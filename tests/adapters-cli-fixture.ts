import { createInterface } from 'node:readline';

const mode = process.argv[2] ?? 'run';
const threadId = 'thread-fixture', turnId = 'turn-fixture';
type Data = Record<string, any>;
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
const reply = (id: unknown, result: unknown) => send({ id, result });
const notify = (method: string, params: Data) => send({ method, params: { threadId, turnId, ...params } });
let readOnly = true;
async function handle(message: Data): Promise<void> {
  if (!message.method) {
    if (message.id !== 'approval') return;
    notify('item/agentMessage/delta', { itemId: 'answer', delta: message.result.decision === 'accept' ? 'Approved.' : 'Denied.' });
    notify('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 12, outputTokens: 4, cachedInputTokens: 0 } } });
    send({ method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex', primary: { usedPercent: 25, windowDurationMins: 300 } }, accessToken: 'PRIVATE_PUSH_TOKEN' } });
    notify('turn/completed', { turn: { id: turnId, status: 'completed', items: [] } }); return;
  }
  const p = message.params ?? {};
  if (message.method === 'initialize') return void reply(message.id, { userAgent: 'fixture', codexHome: process.env.CODEX_HOME });
  if (message.method === 'initialized') return;
  if (message.method === 'config/read') return void reply(message.id, { config: { cli_auth_credentials_store: 'file', forced_login_method: 'chatgpt' } });
  if (message.method === 'model/list') return void reply(message.id, { data: [{ model: 'fixture-model', displayName: 'Fixture', contextWindow: 16384, accessToken: 'PRIVATE_MODEL_TOKEN' }] });
  if (message.method === 'account/read') return void reply(message.id, { account: { type: 'chatgpt', email: 'PRIVATE_EMAIL', accessToken: 'PRIVATE_TOKEN' } });
  if (message.method === 'account/rateLimits/read') return void reply(message.id, { rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { usedPercent: 25, windowDurationMins: 300 }, secondary: { usedPercent: 90, windowDurationMins: 10080 } } }, accessToken: 'PRIVATE_QUOTA_TOKEN' });
  if (message.method === 'account/login/start') {
    reply(message.id, { type: 'chatgptDeviceCode', loginId: 'fixture-login', verificationUrl: mode === 'bad-url' ? 'https://evil.invalid/device' : 'https://auth.openai.com/device', userCode: 'ABCD-EFGH', accessToken: 'PRIVATE_LOGIN_TOKEN' });
    setTimeout(() => send({ method: 'account/login/completed', params: { loginId: 'fixture-login', success: true } }), 30); return;
  }
  if (message.method === 'account/login/cancel') return void reply(message.id, {});
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    readOnly = p.sandbox === 'read-only'; return void reply(message.id, { thread: { id: threadId }, sandbox: { type: mode === 'unsafe' ? 'dangerFullAccess' : readOnly ? 'readOnly' : 'workspaceWrite' }, approvalsReviewer: 'user' });
  }
  if (message.method === 'turn/interrupt') return void reply(message.id, {});
  if (message.method === 'turn/start') {
    reply(message.id, { turn: { id: turnId, status: 'inProgress' } });
    notify('item/reasoning/textDelta', { delta: 'PRIVATE_REASONING' });
    notify('item/agentMessage/delta', { itemId: 'answer', delta: 'Hello. ' });
    if (mode === 'hang') return;
    send({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'command', command: 'git status --short', cwd: process.cwd(), availableDecisions: ['accept', 'decline', 'cancel'] } }); return;
  }
  send({ id: message.id, error: { code: -32601, message: 'PRIVATE_ERROR_TOKEN' } });
}
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  void handle(JSON.parse(line) as Data).catch(() => process.exit(12));
});
