import type { ApprovalRequest, ExternalBackend, ExternalRequest, ExternalResult } from '../core/types.ts';
import {
  JsonRpcProcess, RpcMethodError, approveOnce, bounded, cancelled, preview, record, string,
  type BackendOptions,
} from './rpc.ts';

function permissionKind(value: unknown): ApprovalRequest['kind'] {
  if (value === 'execute') return 'command';
  if (value === 'edit' || value === 'delete' || value === 'move') return 'write';
  if (value === 'fetch') return 'network';
  return 'other';
}

function selectValues(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  return options.flatMap((entry: unknown) => {
    const option = record(entry);
    return typeof option.value === 'string' ? [option.value] : selectValues(option.options);
  });
}

/** ACP v1 client for the official Antigravity CLI; it never reads or copies OAuth tokens. */
export class AntigravityBackend implements ExternalBackend {
  private readonly options: Required<BackendOptions>;

  constructor(options: BackendOptions = {}) {
    this.options = { requestTimeoutMs: options.requestTimeoutMs ?? 30_000, turnTimeoutMs: options.turnTimeoutMs ?? 20 * 60_000 };
  }

  async run(request: ExternalRequest): Promise<ExternalResult> {
    if (request.signal.aborted) throw cancelled();
    if (request.readOnly) {
      throw new Error('Antigravity ACP does not expose a verified read-only enforcement mode. Use a compatible backend for Plan/Team, or Antigravity in Agent mode.');
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([request.signal, controller.signal]);
    const scopedRequest = { ...request, signal };
    let sessionId = '';
    let prompting = false;
    let finished = false;
    let promptResponse: Promise<unknown> | undefined;
    let text = '';
    let textBytes = 0;
    const rpc = new JsonRpcProcess({
      label: 'Antigravity', command: request.profile.command || 'agy',
      args: request.profile.args ?? ['acp', '--sandbox'],
      cwd: request.cwd, env: request.profile.env,
      requestTimeoutMs: this.options.requestTimeoutMs,
      onNotification: (method, params) => {
        // session/load replays stored messages; the canonical chat already has those.
        if (method !== 'session/update' || !prompting || params.sessionId !== sessionId) return;
        const update = record(params.update);
        if (update.sessionUpdate === 'agent_message_chunk') {
          const content = record(update.content);
          if (content.type === 'text' && typeof content.text === 'string') {
            textBytes += Buffer.byteLength(content.text);
            if (textBytes > 8 * 1024 * 1024) throw new Error('Antigravity response exceeded the 8 MiB limit.');
            text += content.text;
            request.onEvent({ type: 'text', text: content.text });
          }
        } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
          request.onEvent({ type: 'tool', name: string(update.name) || string(update.title) || string(update.kind) || 'tool',
            detail: preview({ id: update.toolCallId, kind: update.kind, status: update.status, locations: update.locations }).slice(0, 4000) });
        } else if (update.sessionUpdate === 'plan') {
          request.onEvent({ type: 'status', text: 'Antigravity updated its task plan.' });
        }
        // agent_thought_chunk and unverified quota/usage extensions are not copied to chat.
      },
      onRequest: async (method, params) => {
        if (method !== 'session/request_permission') {
          throw new RpcMethodError('This client does not provide file, terminal, or interactive-input capabilities.');
        }
        const cancelledOutcome = { outcome: { outcome: 'cancelled' } };
        if (!prompting || params.sessionId !== sessionId || signal.aborted) return cancelledOutcome;
        const choices = Array.isArray(params.options) ? params.options.map(record) : [];
        const allow = choices.find(option => option.kind === 'allow_once' && typeof option.optionId === 'string');
        const reject = choices.find(option => option.kind === 'reject_once' && typeof option.optionId === 'string');
        // A boolean confirmation cannot authorize a persistent allow_always rule.
        if (!allow) return reject ? { outcome: { outcome: 'selected', optionId: reject.optionId } } : cancelledOutcome;
        const tool = record(params.toolCall);
        const approved = await approveOnce(scopedRequest, {
          title: 'Antigravity requests permission', kind: permissionKind(tool.kind),
          detail: preview({ kind: tool.kind, title: tool.title, locations: tool.locations, input: tool.rawInput, content: tool.content }),
        });
        if (signal.aborted) return cancelledOutcome;
        const choice = approved ? allow : reject;
        return choice ? { outcome: { outcome: 'selected', optionId: choice.optionId } } : cancelledOutcome;
      },
    });

    const run = async (): Promise<ExternalResult> => {
      request.onEvent({ type: 'status', text: 'Connecting to the official Antigravity runtime…' });
      const initialized = record(await rpc.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'haloforge', title: 'HaloForge', version: '0.1.0' },
      }, { signal }));
      if (initialized.protocolVersion !== 1) throw new Error('Antigravity did not negotiate ACP version 1. Update the CLI or this extension.');
      if (request.resumeId && record(initialized.agentCapabilities).loadSession !== true) {
        throw new Error('This Antigravity version cannot reload saved ACP sessions. Start a new conversation or update the official CLI.');
      }
      const setup = record(await rpc.request(request.resumeId ? 'session/load' : 'session/new', {
        cwd: request.cwd, mcpServers: [], ...(request.resumeId ? { sessionId: request.resumeId } : {}),
      }, { signal }));
      sessionId = request.resumeId || string(setup.sessionId);
      if (!sessionId) throw new Error('Antigravity did not return an ACP session ID.');
      await this.setModel(rpc, setup, sessionId, request.profile.model.trim(), signal);
      if (signal.aborted) throw cancelled();
      prompting = true;
      // Keep this request alive during cancellation so the agent can acknowledge it.
      promptResponse = rpc.request('session/prompt', {
        sessionId, prompt: [{ type: 'text', text: request.prompt }],
      }, { timeoutMs: this.options.turnTimeoutMs });
      const response = record(await promptResponse);
      finished = true;
      if (response.stopReason === 'cancelled') throw cancelled();
      if (response.stopReason !== 'end_turn' && response.stopReason !== 'refusal') {
        const stop = response.stopReason === 'max_tokens' || response.stopReason === 'max_turn_requests' ? response.stopReason : 'unsupported stop reason';
        throw new Error(`Antigravity stopped before completing the task (${stop}).`);
      }
      if (response.stopReason === 'refusal') request.onEvent({ type: 'status', text: 'Antigravity declined this request.' });
      return { text, sessionId };
    };

    try {
      return await bounded(run(), signal, this.options.turnTimeoutMs, 'Antigravity turn', rpc.failure);
    } finally {
      controller.abort();
      if (prompting && sessionId && !finished) {
        rpc.notify('session/cancel', { sessionId });
        if (promptResponse) await bounded(promptResponse, new AbortController().signal, 300, 'Antigravity cancellation').catch(() => undefined);
      }
      rpc.dispose();
    }
  }

  private async setModel(rpc: JsonRpcProcess, setup: Record<string, unknown>, sessionId: string, model: string, signal: AbortSignal): Promise<void> {
    if (!model || model === 'current' || model === 'default') return;
    const configs = Array.isArray(setup.configOptions) ? setup.configOptions.map(record) : [];
    const config = configs.find(option => option.category === 'model' && option.type === 'select');
    if (config) {
      if (!selectValues(config.options).includes(model)) {
        throw new Error('The selected model is not offered to this Antigravity ACP client. Choose a model in the official CLI or use "current".');
      }
      if (config.currentValue === model) return;
      const result = record(await rpc.request('session/set_config_option', { sessionId, configId: config.id, value: model }, { signal }));
      const updated = Array.isArray(result.configOptions) ? result.configOptions.map(record).find(option => option.id === config.id) : undefined;
      if (!updated || updated.currentValue !== model) throw new Error('Antigravity did not confirm the requested model change.');
      return;
    }
    // Compatibility with agents exposing the earlier ACP model selector.
    const models = record(setup.models);
    const available = Array.isArray(models.availableModels) ? models.availableModels.map(record) : [];
    if (!available.some(option => option.modelId === model)) {
      throw new Error('Antigravity did not advertise the requested model. Use "current" to keep the official CLI selection.');
    }
    if (models.currentModelId !== model) await rpc.request('session/set_model', { sessionId, modelId: model }, { signal });
  }
}
