import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Application } from '../src/server.ts';
import { defaultConfig, type Config } from '../src/config.ts';
import type { AgentTask, Conversation, ModelRoute, Project, Run } from '../src/contracts.ts';
import type { InferenceRequest, InferenceResult, ToolCall } from '../src/adapters/types.ts';
import type { Completion } from '../src/orchestrator.ts';
import { AppError, id, now } from '../src/util.ts';

const product = 'export const answer = 42;\n';
const plan = JSON.stringify({ tasks: [
  { id: 'alpha', title: 'Research Alpha', role: 'researcher', instruction: 'RESEARCH_ALPHA: inspect the implementation requirements.', dependsOn: [] },
  { id: 'beta', title: 'Research Beta', role: 'researcher', instruction: 'RESEARCH_BETA: inspect the independent verification requirements.', dependsOn: [] },
  { id: 'implementation', title: 'Implement product', role: 'coder', instruction: 'Create product.ts after reading both research reports.', dependsOn: ['alpha', 'beta'] },
] });

function result(text: string, toolCalls: ToolCall[] = []): InferenceResult {
  return {
    text, toolCalls, finishReason: toolCalls.length ? 'tool_calls' : 'stop',
    usage: { inputTokens: 20, outputTokens: 10 },
    metrics: { totalMs: 2, sources: { usage: 'provider', ttft: 'gateway', prefill: 'unknown', decode: 'unknown', context: 'unknown' } },
    quota: { state: 'unknown', source: 'unknown', observedAt: now() },
  };
}

interface Call {
  request: InferenceRequest;
  role: string;
  name?: 'alpha' | 'beta';
  state: 'pending' | 'completed' | 'aborted';
  finish?: (text: string) => void;
}

/** Only inference is controlled. Persistence, the DAG, scheduler, HTTP controls,
 * workspace writes and executable verification all use the real implementation. */
class CompletionLab {
  calls: Call[] = [];
  uncertainOnAlphaAbort?: 'REMOTE_UNCERTAIN' | 'NATIVE_UNCERTAIN';
  complete: Completion = async request => {
    request.signal.throwIfAborted();
    const role = request.messages.find(m => m.role === 'system')?.content.match(/Your role: ([a-z]+)/)?.[1] ?? 'unknown';
    const call: Call = { request, role, state: 'pending' };
    this.calls.push(call);
    const respond = (text: string, tools?: ToolCall[]): InferenceResult => {
      call.state = 'completed';
      if (text) request.onText(text);
      return result(text, tools);
    };
    if (role === 'primary') return respond(plan);
    if (role === 'reviewer') return respond(JSON.stringify({ approved: true, issues: [], summary: 'Both research reports were applied and the product is ready for executable verification.', methodCandidate: null }));
    if (role === 'coder') {
      if (request.messages.some(m => m.role === 'tool')) return respond('Created product.ts from both research reports.');
      return respond('', [{ id: id('tool'), name: 'write_file', arguments: JSON.stringify({ path: 'product.ts', content: product }) }]);
    }
    assert.equal(role, 'researcher', 'Unexpected model role in task-control fixture');
    const instruction = request.messages.at(-1)?.content ?? '';
    call.name = instruction.includes('RESEARCH_ALPHA') ? 'alpha' : 'beta';
    request.onText(`Research ${call.name} in progress.`);
    return await new Promise<InferenceResult>((resolve, reject) => {
      const abort = () => {
        if (call.state !== 'pending') return;
        call.state = 'aborted';
        const code = call.name === 'alpha' ? this.uncertainOnAlphaAbort : undefined;
        reject(code ? new AppError(503, code, `${code}: inspect the actual remote outcome before resuming.`) : request.signal.reason);
      };
      call.finish = text => {
        assert.equal(call.state, 'pending', 'A finished or aborted inference must not be completed twice');
        request.signal.removeEventListener('abort', abort);
        resolve(respond(text));
      };
      request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted) abort();
    });
  };
  research(name: 'alpha' | 'beta'): Call[] { return this.calls.filter(c => c.name === name); }
}

async function eventually(predicate: () => boolean, description: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(`Timed out: ${description}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function bounded<T>(promise: Promise<T>, description: string, timeoutMs = 3000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yed1z-task-control-'));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  const lab = new CompletionLab();
  const config: Config = {
    ...defaultConfig(), port: 0, telemetryIntervalMs: 300_000, links: [],
    nodes: [{ id: 'fixture-node', label: 'Fixture execution host', kind: 'server', capabilities: ['execution'] }],
    resourceGroups: [{ id: 'fixture-inference', label: 'Concurrent fixture inference', nodeIds: [], capacity: 3 }],
    providers: [{
      id: 'fixture-provider', label: 'Controlled inference', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1',
      nodeIds: [], resourceGroupIds: ['fixture-inference'], enabled: true,
      models: ['planner', 'researcher', 'coder', 'reviewer', 'alternate'].map(model => ({ model, label: model, contextWindow: 32768, capabilities: ['chat', 'tools'] })),
    }],
    targets: [{
      id: 'fixture-target', nodeId: 'fixture-node', kind: 'local', workspaceRoot: workspace,
      commands: [{
        id: 'verify', label: 'Verify generated product', verification: true,
        argv: [process.execPath, '-e', `const fs=require('node:fs');if(fs.readFileSync('product.ts','utf8')!==${JSON.stringify(product)})process.exit(7);console.log('verified actual product.ts');`],
      }],
      deployments: [],
    }],
  };
  const app = new Application({ directory: path.join(root, 'state'), config, complete: lab.complete });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const alice = app.store.createUser('Alice', 'admin');
  const bob = app.store.createUser('Bob', 'operator');
  const viewer = app.store.createUser('Viewer', 'viewer');
  app.catalog.seed(alice.user);
  const routes = Object.fromEntries(app.catalog.models(alice.user).map(route => [route.model, route])) as Record<string, ModelRoute>;
  const project: Project = {
    id: id('prj'), ownerId: alice.user.id, memberIds: [bob.user.id, viewer.user.id], name: 'Task controls', description: 'Verify independent agent controls against a real DAG.',
    targetId: 'fixture-target', workspace: '.', routes: { primary: routes.planner.id, researcher: routes.researcher.id, coder: routes.coder.id, reviewer: routes.reviewer.id },
    verifyRecipeIds: ['verify'], createdAt: now(), updatedAt: now(),
  };
  app.store.put('project', project);
  const conversation = app.store.put<Conversation>('conversation', { id: id('conv'), ownerId: alice.user.id, projectId: project.id, title: 'Agent controls', createdAt: now(), updatedAt: now(), messages: [] });
  const port = await app.listen();
  const api = async (taskId: string, action: 'pause' | 'resume' | 'cancel' | 'steer' | 'route', body: Record<string, unknown> = {}, token = alice.token) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/tasks/${taskId}/${action}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const start = () => app.orchestrator.start(alice.user, conversation.id, {
    text: 'Build product.ts using two independent research reports and verify the generated file.', routeId: routes.planner.id,
    mode: 'mission', permissions: { write: true, commands: true }, maxIterations: 3, maxParallel: 3,
  });
  const state = (runId: string) => app.store.require<Run>('run', runId);
  const task = (runId: string, label: string): AgentTask => {
    const found = state(runId).tasks.find(task => task.label === label);
    assert.ok(found, `Expected task ${label}`);
    return found;
  };
  const ready = async () => eventually(() => lab.research('alpha').length === 1 && lab.research('beta').length === 1, 'both independent researchers to enter inference concurrently');
  return { app, lab, alice, bob, viewer, routes, project, conversation, workspace, api, start, state, task, ready };
}

test('pausing one researcher preserves its sibling, blocks the dependent coder and resumes the same DAG without resetting its budget', { timeout: 10000 }, async t => {
  const f = await fixture(t), run = f.start();
  await f.ready();
  const alpha = f.task(run.id, 'Research Alpha'), beta = f.task(run.id, 'Research Beta'), coder = f.task(run.id, 'Implement product');
  const initialBudget = f.state(run.id).budget;
  assert.equal(initialBudget.callsUsed, 3);
  assert.equal((await f.api(alpha.id, 'pause')).status, 200);
  await eventually(() => f.task(run.id, alpha.label).control === 'paused', 'Alpha to checkpoint its pause');
  assert.equal(f.lab.research('alpha')[0].request.signal.aborted, true);
  assert.equal(f.lab.research('beta')[0].request.signal.aborted, false);
  assert.equal(f.task(run.id, beta.label).status, 'running');
  assert.match(f.task(run.id, alpha.label).output ?? '', /Research alpha in progress/);
  f.lab.research('beta')[0].finish!('BETA_REPORT: verification requires answer 42.');
  await eventually(() => f.app.orchestrator.taskWakeups.has(run.id), 'mission to wait for the paused dependency');
  assert.equal(f.task(run.id, beta.label).status, 'succeeded');
  assert.equal(f.task(run.id, coder.label).status, 'queued');
  assert.equal(f.lab.calls.filter(call => call.role === 'coder').length, 0);
  assert.equal(f.state(run.id).budget.callsUsed, initialBudget.callsUsed);
  const usedBeforeResume = f.state(run.id).budget.outputTokensUsed;
  assert.ok(usedBeforeResume > initialBudget.outputTokensUsed);
  assert.equal((await f.api(alpha.id, 'resume')).status, 200);
  await eventually(() => f.lab.research('alpha').length === 2, 'resumed Alpha inference');
  assert.equal(f.task(run.id, alpha.label).attempt, alpha.attempt + 1);
  assert.equal(f.state(run.id).budget.callsUsed, initialBudget.callsUsed + 1);
  assert.equal(f.state(run.id).budget.outputTokensUsed, usedBeforeResume);
  assert.equal(f.lab.research('beta').length, 1, 'Completed sibling must not be replayed');
  f.lab.research('alpha')[1].finish!('ALPHA_REPORT: export the answer as 42.');
  await bounded(f.app.orchestrator.idle(run.id), 'resumed mission to finish');
  const done = f.state(run.id);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.verificationPassed, true);
  assert.equal(done.iteration, 0, 'A task resume must not replan the whole mission');
  assert.equal(done.tasks.filter(task => task.role === 'primary').length, 1);
  assert.equal(done.tasks.find(task => task.id === alpha.id)?.status, 'succeeded');
  assert.equal(done.tasks.find(task => task.id === coder.id)?.status, 'succeeded');
  assert.equal(done.budget.callsUsed, f.lab.calls.length);
  assert.equal(done.budget.outputTokensUsed, f.lab.calls.filter(call => call.state === 'completed').length * 10);
  assert.equal(done.budget.maxModelCalls, initialBudget.maxModelCalls);
  assert.equal(done.budget.maxOutputTokens, initialBudget.maxOutputTokens);
  const coderContext = f.lab.calls.find(call => call.role === 'coder')!.request.messages.map(message => message.content).join('\n');
  assert.match(coderContext, /ALPHA_REPORT/);
  assert.match(coderContext, /BETA_REPORT/);
  assert.equal(await readFile(path.join(f.workspace, 'product.ts'), 'utf8'), product);
  assert.equal(f.app.orchestrator.taskControls.size, 0);
  assert.equal(f.app.orchestrator.taskWakeups.size, 0);
  assert.equal(f.app.orchestrator.outputReservations.get(run.id) ?? 0, 0);
  assert.equal(f.app.scheduler.snapshot()['fixture-inference'], 0);
});

test('cancelling a queued agent pauses the mission without executing or automatically regenerating that agent', { timeout: 10000 }, async t => {
  const f = await fixture(t), run = f.start();
  await f.ready();
  const coder = f.task(run.id, 'Implement product');
  assert.equal(coder.status, 'queued');
  assert.equal((await f.api(coder.id, 'cancel')).status, 200);
  assert.equal(f.task(run.id, coder.label).status, 'cancelled');
  f.lab.research('alpha')[0].finish!('ALPHA_REPORT: complete.');
  f.lab.research('beta')[0].finish!('BETA_REPORT: complete.');
  await bounded(f.app.orchestrator.idle(run.id), 'queued cancellation to halt the mission');
  assert.equal(f.state(run.id).status, 'paused');
  assert.equal(f.state(run.id).tasks.filter(task => task.role === 'coder').length, 1);
  assert.equal(f.state(run.id).tasks.filter(task => task.role === 'primary').length, 1);
  assert.equal(f.lab.calls.some(call => ['coder', 'reviewer'].includes(call.role)), false);
  assert.equal(f.app.orchestrator.active.has(run.id), false);
  await assert.rejects(readFile(path.join(f.workspace, 'product.ts')));
  const callsAtPause = f.lab.calls.length;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.lab.calls.length, callsAtPause);
  assert.equal(f.state(run.id).tasks.find(task => task.id === coder.id)?.status, 'cancelled');
});

test('task steering persists, pauses only the active agent and permits route changes only while queued or paused', { timeout: 10000 }, async t => {
  const f = await fixture(t), run = f.start();
  await f.ready();
  const alpha = f.task(run.id, 'Research Alpha'), coder = f.task(run.id, 'Implement product');
  const steer = 'Inspect the existing module first and keep the export compatible.';
  assert.equal((await f.api(alpha.id, 'route', { routeId: f.routes.alternate.id })).status, 409);
  assert.equal((await f.api(coder.id, 'route', { routeId: f.routes.alternate.id })).status, 200);
  assert.equal(f.task(run.id, coder.label).routeId, f.routes.alternate.id);
  assert.equal((await f.api(alpha.id, 'steer', { text: steer })).status, 200);
  await eventually(() => f.task(run.id, alpha.label).control === 'paused', 'steered Alpha to pause');
  assert.match(f.task(run.id, alpha.label).instruction, /USER STEERING:/);
  assert.ok(f.task(run.id, alpha.label).instruction.includes(steer));
  assert.equal(f.lab.research('beta')[0].request.signal.aborted, false);
  assert.ok(f.app.store.replay(f.alice.user.id).some(event => event.type === 'user.task_steer' && event.taskId === alpha.id && event.text === steer));
  assert.equal((await f.api(alpha.id, 'route', { routeId: f.routes.alternate.id })).status, 200);
  assert.equal((await f.api(alpha.id, 'resume')).status, 200);
  f.lab.research('beta')[0].finish!('BETA_REPORT: independent work complete.');
  await eventually(() => f.lab.research('alpha').length === 2, 'steered task to restart on its selected model');
  const resumed = f.lab.research('alpha')[1];
  assert.equal(resumed.request.model.id, 'alternate');
  assert.ok(resumed.request.messages.some(message => message.content.includes(steer)));
  assert.ok(resumed.request.messages.some(message => /Never replay side effects blindly/.test(message.content)));
  assert.equal((await f.api(alpha.id, 'route', { routeId: f.routes.researcher.id })).status, 409);
  resumed.finish!('ALPHA_REPORT: compatible export verified.');
  await bounded(f.app.orchestrator.idle(run.id), 'steered mission to finish');
  assert.equal(f.state(run.id).status, 'succeeded');
  assert.equal(f.lab.calls.find(call => call.role === 'coder')?.request.model.id, 'alternate');
  assert.equal((await f.api(alpha.id, 'route', { routeId: f.routes.researcher.id })).status, 409);
});

test('a project colleague cannot control another owner’s agents through any task endpoint', { timeout: 10000 }, async t => {
  const f = await fixture(t), run = f.start();
  await f.ready();
  const alpha = f.task(run.id, 'Research Alpha'), before = f.state(run.id);
  assert.equal(f.app.store.projectFor(f.bob.user, f.project.id).id, f.project.id, 'Bob is a legitimate project operator');
  for (const action of ['pause', 'resume', 'cancel', 'steer', 'route'] as const) {
    const response = await f.api(alpha.id, action, action === 'steer' ? { text: 'Unauthorized redirection' } : action === 'route' ? { routeId: f.routes.alternate.id } : {}, f.bob.token);
    assert.equal(response.status, 404, `${action} must not reveal or mutate another owner’s task`);
  }
  assert.equal((await f.api(alpha.id, 'pause', {}, f.viewer.token)).status, 403);
  assert.deepEqual(f.state(run.id), before);
  assert.equal(f.lab.research('alpha')[0].request.signal.aborted, false);
  assert.equal(f.lab.research('beta')[0].request.signal.aborted, false);
  f.app.orchestrator.control(f.alice.user, run.id, 'cancel');
  await bounded(f.app.orchestrator.idle(run.id), 'owner cancellation');
});

test('global cancellation wakes a mission waiting on a paused queued task and releases the workspace and resources', { timeout: 10000 }, async t => {
  const f = await fixture(t), run = f.start();
  await f.ready();
  const coder = f.task(run.id, 'Implement product');
  assert.equal((await f.api(coder.id, 'pause')).status, 200);
  assert.equal(f.task(run.id, coder.label).control, 'paused');
  f.lab.research('alpha')[0].finish!('ALPHA_REPORT: complete.');
  f.lab.research('beta')[0].finish!('BETA_REPORT: complete.');
  await eventually(() => f.app.orchestrator.taskWakeups.has(run.id), 'waitForTask to register the paused dependency');
  f.app.orchestrator.control(f.alice.user, run.id, 'cancel');
  await bounded(f.app.orchestrator.idle(run.id), 'global cancellation to wake waitForTask', 1000);
  assert.equal(f.state(run.id).status, 'cancelled');
  assert.equal(f.lab.calls.some(call => call.role === 'coder'), false);
  assert.equal(f.app.orchestrator.active.size, 0);
  assert.equal(f.app.orchestrator.taskControls.size, 0);
  assert.equal(f.app.orchestrator.taskWakeups.size, 0);
  assert.equal(f.app.scheduler.snapshot()['fixture-inference'], 0);
  // A new mission on the same workspace must reach inference after the old waiter exits.
  const next = f.start();
  await eventually(() => f.lab.research('alpha').length === 2 && f.lab.research('beta').length === 2, 'next mission to acquire the released workspace');
  f.app.orchestrator.control(f.alice.user, next.id, 'cancel');
  await bounded(f.app.orchestrator.idle(next.id), 'next mission cleanup');
});

for (const code of ['REMOTE_UNCERTAIN', 'NATIVE_UNCERTAIN'] as const) {
  test(`${code} raised while pausing an agent remains an uncertain mission outcome instead of a resumable task pause`, { timeout: 10000 }, async t => {
    const f = await fixture(t);
    f.lab.uncertainOnAlphaAbort = code;
    const run = f.start();
    await f.ready();
    const alpha = f.task(run.id, 'Research Alpha');
    assert.equal((await f.api(alpha.id, 'pause')).status, 200);
    await eventually(() => f.lab.research('alpha')[0].state === 'aborted', 'uncertain runtime to report its interrupted outcome');
    f.lab.research('beta')[0].finish!('BETA_REPORT: independent result is complete.');
    await eventually(() => !f.app.orchestrator.active.has(run.id) || f.app.orchestrator.taskWakeups.has(run.id), 'uncertain mission to stop or expose an incorrectly resumable pause');
    const current = f.state(run.id);
    assert.equal(current.status, 'interrupted', 'Uncertainty must win over a requested single-agent pause');
    assert.match(current.error ?? '', new RegExp(code));
    assert.equal(current.tasks.find(task => task.id === alpha.id)?.control, undefined);
    assert.match(current.tasks.find(task => task.id === alpha.id)?.error ?? '', new RegExp(code));
    assert.equal(f.lab.calls.filter(call => call.role === 'primary').length, 1);
    assert.equal(f.lab.calls.some(call => call.role === 'coder'), false);
    assert.equal(f.app.orchestrator.taskWakeups.has(run.id), false);
    assert.equal((await f.api(alpha.id, 'resume')).status, 409, 'Reconciliation must go through the mission controller');
  });
}
