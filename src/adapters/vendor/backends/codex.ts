import type { ExternalBackend, ExternalRequest, ExternalResult, Usage } from '../core/types.ts';
import { codexArgs, confirmCodexProfile } from './codex-profile.ts';
import { quotaSnapshot } from '../inspect.ts';
import {
  JsonRpcProcess, RpcMethodError, approveOnce, bounded, cancelled, deferred, preview, record, string,
  type BackendOptions,
} from './rpc.ts';

type Data = Record<string, unknown>;

function tokenUsage(value: unknown): Usage | undefined {
  const data = record(value);
  const input = data.inputTokens;
  const output = data.outputTokens;
  if (typeof input !== 'number' || typeof output !== 'number' || !Number.isSafeInteger(input) || !Number.isSafeInteger(output) || input < 0 || output < 0) return;
  const cached = data.cachedInputTokens;
  return {
    inputTokens: input, outputTokens: output,
    ...(typeof cached === 'number' && Number.isSafeInteger(cached) && cached >= 0 ? { cachedInputTokens: cached } : {}),
  };
}

/** Native Codex app-server adapter. Authentication and tool execution stay in the official CLI. */
export class CodexBackend implements ExternalBackend {
  private readonly options: Required<BackendOptions>;

  constructor(options: BackendOptions = {}) {
    this.options = { requestTimeoutMs: options.requestTimeoutMs ?? 30_000, turnTimeoutMs: options.turnTimeoutMs ?? 20 * 60_000 };
  }

  async run(request: ExternalRequest): Promise<ExternalResult> {
    if (request.signal.aborted) throw cancelled();
    const controller = new AbortController();
    const signal = AbortSignal.any([request.signal, controller.signal]);
    const scopedRequest = { ...request, signal };
    const completion = deferred<void>();
    const turnReady = deferred<void>();
    let threadId = '';
    let turnId = '';
    let capturing = false;
    let finished = false;
    let textBytes = 0;
    let usage: Usage | undefined;
    let knownQuotaObserved = false;
    let thinkingText = '';
    let thinkingStart: number | undefined;
    let thinkingEnd: number | undefined;
    const actions: Array<{ title: string; kind?: 'command' | 'tool' | 'file' | 'status'; detail?: string; status?: string }> = [];
    // Thread totals must never be charged again when resuming a saved thread.
    let baseline: Usage | undefined = request.resumeId ? undefined : { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    const messages = new Map<string, string>();
    const toolItems = new Map<string, Data>();
    const early: Array<[string, Data]> = [];
    const workspaceTools = request.workspaceTools;
    const toolNames = new Map(workspaceTools?.definitions.map(tool => [`yed1z_${tool.name}`, tool]) ?? []);
    let workspaceCalls = 0;

    const append = (id: string, text: string) => {
      if (!text || finished) return;
      textBytes += Buffer.byteLength(text);
      if (textBytes > 8 * 1024 * 1024) {
        completion.reject(new Error('Codex response exceeded the 8 MiB limit.'));
        return;
      }
      messages.set(id, (messages.get(id) ?? '') + text);
      request.onEvent({ type: 'text', text });
    };

    const finish = (turn: Data) => {
      if (finished || string(turn.id) !== turnId) return;
      const status = string(turn.status);
      if (status === 'inProgress') return;
      if (Array.isArray(turn.items)) {
        for (const item of turn.items) {
          const data = record(item);
          const id = string(data.id);
          if (data.type === 'agentMessage' && id && !messages.has(id)) append(id, string(data.text));
        }
      }
      finished = true;
      if (status === 'completed') completion.resolve();
      else if (status === 'interrupted') completion.reject(cancelled());
      else {
        const code = string(record(turn.error).codexErrorInfo);
        const allowedCodes = ['contextWindowExceeded', 'usageLimitExceeded', 'badRequest', 'unauthorized', 'sandboxError'];
        completion.reject(new Error(`Codex turn ${status === 'failed' ? 'failed' : 'ended with an unsupported status'}${allowedCodes.includes(code) ? ` (${code})` : ''}. Check the official CLI for details.`));
      }
    };

    const notification = (method: string, params: Data) => {
      if (method === 'account/rateLimits/updated') {
        // This notification is account-scoped in the official protocol. If a
        // compatible runtime supplies thread scope, reject unrelated threads.
        if (signal.aborted || (params.threadId && params.threadId !== threadId && params.threadId !== request.resumeId)) return;
        const quota = quotaSnapshot(params);
        if (quota.state !== 'unknown') knownQuotaObserved = true;
        request.onEvent({ type: 'quota', quota: { ...quota, source: 'codex_notification', partial: true } });
        return;
      }
      // A resume baseline can arrive before the thread/resume acknowledgement.
      // Accept it only for the exact persisted thread; unrelated events stay out.
      if (params.threadId && params.threadId !== threadId
        && !(method === 'thread/tokenUsage/updated' && !capturing && request.resumeId && params.threadId === request.resumeId)) return;
      if (method === 'thread/tokenUsage/updated' && !capturing) {
        baseline = tokenUsage(record(params.tokenUsage).total) ?? baseline;
        return;
      }
      if (!capturing || finished) return;
      if (!turnId) {
        if (early.length >= 1000) completion.reject(new Error('Codex sent too many events before acknowledging the turn.'));
        else early.push([method, params]);
        return;
      }
      if (params.turnId && params.turnId !== turnId) return;
      if (method === 'turn/completed') { finish(record(params.turn)); return; }
      if (method === 'item/agentMessage/delta') {
        append(string(params.itemId) || 'assistant', string(params.delta));
      } else if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
        const delta = string(params.delta);
        if (delta) {
          thinkingStart ??= performance.now();
          thinkingEnd = performance.now();
          thinkingText += delta;
          request.onEvent({ type: 'thinking', text: delta });
        }
      } else if (method === 'item/started' || method === 'item/completed') {
        const item = record(params.item);
        const id = string(item.id);
        const type = string(item.type);
        if (type === 'agentMessage' && method === 'item/completed' && id && !messages.has(id)) append(id, string(item.text));
        const supportedTools = ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'imageView', 'collabAgentToolCall'];
        if (supportedTools.includes(type)) {
          if (method === 'item/started' && toolItems.size < 256) toolItems.set(id, item);
          const cmd = typeof item.command === 'string' ? item.command : undefined;
          const status = type === 'dynamicToolCall' && item.success === false ? 'failed' : string(item.status) ?? (method === 'item/started' ? 'inProgress' : 'completed');
          const detail = preview({ status, command: item.command, cwd: item.cwd, tool: item.tool, server: item.server }).slice(0, 4000);
          request.onEvent({ type: 'tool', name: type, detail });
          if (method === 'item/completed' || !toolItems.has(id)) {
            actions.push({
              title: cmd ? `${type}: ${cmd}` : type,
              kind: type === 'commandExecution' ? 'command' : type === 'fileChange' ? 'file' : 'tool',
              detail: cmd || detail,
              status
            });
          }
          if (method === 'item/completed') toolItems.delete(id);
        }
      } else if (method === 'thread/tokenUsage/updated' && baseline) {
        const total = tokenUsage(record(params.tokenUsage).total);
        if (total && total.inputTokens >= baseline.inputTokens && total.outputTokens >= baseline.outputTokens) {
          usage = {
            inputTokens: total.inputTokens - baseline.inputTokens,
            outputTokens: total.outputTokens - baseline.outputTokens,
            ...(total.cachedInputTokens !== undefined && baseline.cachedInputTokens !== undefined && total.cachedInputTokens >= baseline.cachedInputTokens
              ? { cachedInputTokens: total.cachedInputTokens - baseline.cachedInputTokens } : {}),
          };
          request.onEvent({ type: 'usage', usage });
        }
      } else if (method === 'turn/plan/updated') {
        request.onEvent({ type: 'status', text: 'Codex updated its task plan.' });
      } else if (method === 'error' && params.willRetry === true) {
        request.onEvent({ type: 'status', text: 'Codex is retrying a temporary runtime error.' });
      }
    };

    const rpc = new JsonRpcProcess({
      label: 'Codex', command: request.profile.command || 'codex',
      args: codexArgs(request.profile, false, Boolean(workspaceTools)),
      cwd: request.cwd, env: request.profile.env,
      requestTimeoutMs: this.options.requestTimeoutMs,
      omitJsonRpcVersion: true,
      onNotification: notification,
      onRequest: async (method, params) => {
        if (method === 'item/tool/call' && workspaceTools) {
          const reply = (success: boolean, text: string) => ({ success, contentItems: [{ type: 'inputText', text: text.slice(0, 96000) }] });
          if (!capturing || signal.aborted || params.namespace) return reply(false, 'Workspace tool is not available for this turn.');
          await bounded(turnReady.promise, signal, this.options.requestTimeoutMs, 'Codex turn acknowledgement');
          if (params.threadId !== threadId || params.turnId !== turnId || finished) return reply(false, 'Workspace tool request is outside the active turn.');
          const tool = toolNames.get(string(params.tool));
          if (!tool || workspaceCalls >= 64) return reply(false, 'Workspace tool is unavailable or its call limit was reached.');
          workspaceCalls++;
          const result = await workspaceTools.execute(tool.name, record(params.arguments), signal);
          return reply(result.ok, result.output);
        }
        if (method === 'mcpServer/elicitation/request') return { action: 'decline', content: null };
        if (method === 'item/permissions/requestApproval') {
          // Do not grant an unfamiliar filesystem/network permission profile by accident.
          request.onEvent({ type: 'status', text: 'An additional Codex permission profile was declined. This adapter supports single command and file approvals.' });
          return { permissions: {}, scope: 'turn' };
        }
        const fileChange = method === 'item/fileChange/requestApproval';
        const command = method === 'item/commandExecution/requestApproval';
        if (!fileChange && !command) throw new RpcMethodError('This client does not implement the requested interactive capability.');
        if (!capturing || signal.aborted || request.readOnly) return { decision: signal.aborted ? 'cancel' : 'decline' };
        await bounded(turnReady.promise, signal, this.options.requestTimeoutMs, 'Codex turn acknowledgement');
        if (params.threadId !== threadId || params.turnId !== turnId || finished) return { decision: 'decline' };
        const network = record(params.networkApprovalContext);
        const isNetwork = Object.keys(network).length > 0;
        const item = toolItems.get(string(params.itemId));
        const approved = await approveOnce(scopedRequest, {
          title: isNetwork ? 'Codex requests network access' : fileChange ? 'Codex requests a file change' : 'Codex requests command execution',
          kind: isNetwork ? 'network' : fileChange ? 'write' : 'command',
          detail: preview({ reason: params.reason, command: params.command, cwd: params.cwd,
            grantRoot: params.grantRoot, network: isNetwork ? network : undefined,
            changes: fileChange ? item?.changes : undefined,
            commandActions: params.commandActions,
            additionalPermissions: params.additionalPermissions,
          }),
        });
        // Never persist an exec-policy amendment or a session-wide allow rule.
        const available = Array.isArray(params.availableDecisions) ? params.availableDecisions : undefined;
        return { decision: signal.aborted ? 'cancel' : approved && (!available || available.includes('accept')) ? 'accept' : 'decline' };
      },
    });

    const run = async (): Promise<ExternalResult> => {
      request.onEvent({ type: 'status', text: 'Connecting to the official Codex runtime…' });
      const initialized = await rpc.request('initialize', {
        clientInfo: { name: 'haloforge_vscode', title: 'HaloForge', version: '0.1.0' },
        capabilities: { experimentalApi: Boolean(workspaceTools), requestAttestation: false },
      }, { signal });
      rpc.notify('initialized');
      await confirmCodexProfile(rpc, initialized, request.profile.env?.CODEX_HOME, signal, false, workspaceTools ? request.cwd : undefined);
      const model = request.profile.model.trim();
      const modelOverride = model && model !== 'default' && model !== 'current' ? { model } : {};
      const policy = {
        cwd: request.cwd,
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: request.readOnly ? 'read-only' : 'workspace-write',
        ...modelOverride,
      };
      const thread = record(await rpc.request(request.resumeId ? 'thread/resume' : 'thread/start', {
        ...policy,
        ...(request.resumeId ? { threadId: request.resumeId, excludeTurns: true } : {}),
        ...(!request.resumeId && workspaceTools ? { dynamicTools: [...toolNames].map(([name, tool]) => ({ type: 'function', name, description: tool.description, inputSchema: tool.parameters, deferLoading: false })) } : {}),
      }, { signal }));
      // The resume key is thread.id, not sessionId (which can name the root of a fork tree).
      threadId = string(record(thread.thread).id);
      if (!threadId) throw new Error('Codex did not return a thread ID. Update the official CLI.');
      const effectiveSandbox = string(record(thread.sandbox).type);
      if ((request.readOnly && effectiveSandbox !== 'readOnly')
        || (effectiveSandbox && !request.readOnly && effectiveSandbox !== 'workspaceWrite')) {
        throw new Error('Codex did not confirm the requested sandbox policy. Check the official CLI configuration.');
      }
      if (thread.approvalsReviewer && thread.approvalsReviewer !== 'user') {
        throw new Error('Codex did not route approvals to the user. Check the official CLI approval settings.');
      }
      const sandboxPolicy = request.readOnly
        ? { type: 'readOnly', networkAccess: false }
        : { type: 'workspaceWrite', writableRoots: [request.cwd], networkAccess: false,
          excludeTmpdirEnvVar: true, excludeSlashTmp: true };
      capturing = true;
      const started = record(await rpc.request('turn/start', {
        threadId, cwd: request.cwd, input: [{ type: 'text', text: request.prompt, text_elements: [] }],
        approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy, ...modelOverride,
      }, { signal }));
      const turn = record(started.turn);
      turnId = string(turn.id);
      if (!turnId) throw new Error('Codex did not return a turn ID.');
      turnReady.resolve();
      for (const [method, params] of early) notification(method, params);
      early.length = 0;
      if (turn.status !== 'inProgress') finish(turn);
      await completion.promise;
      return {
        text: [...messages.values()].join('\n\n'),
        sessionId: threadId,
        ...(usage ? { usage } : {}),
        ...(thinkingText ? { thinking: thinkingText, thinkingMs: thinkingStart !== undefined ? (thinkingEnd ?? performance.now()) - thinkingStart : undefined } : {}),
        ...(actions.length ? { actions } : {})
      };
    };

    try {
      const result = await bounded(run(), signal, this.options.turnTimeoutMs, 'Codex turn', rpc.failure);
      // Optional account observation is outside the turn failure race. A CLI
      // closing, lacking this RPC, or timing out cannot fail a completed task.
      if (!request.signal.aborted) {
        try {
          const quota = quotaSnapshot(await rpc.request('account/rateLimits/read', {}, {
            timeoutMs: Math.min(1500, this.options.requestTimeoutMs), signal: request.signal,
          }));
          request.onEvent({ type: 'quota', quota: { ...quota, source: 'codex_app_server', partial: false } });
        } catch {
          if (!request.signal.aborted && !knownQuotaObserved) {
            request.onEvent({ type: 'quota', quota: { ...quotaSnapshot({}), source: 'not_reported', partial: false } });
          }
        }
      }
      return result;
    } finally {
      controller.abort();
      turnReady.reject(cancelled());
      completion.reject(cancelled());
      if (threadId && turnId && !finished) {
        await rpc.request('turn/interrupt', { threadId, turnId }, { timeoutMs: 300 }).catch(() => undefined);
      }
      rpc.dispose();
    }
  }
}
