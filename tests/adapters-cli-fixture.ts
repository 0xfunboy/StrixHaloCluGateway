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
    if (['wrong-thread', 'wrong-namespace', 'unknown-tool'].includes(message.id)) {
      if (message.result?.success !== false) process.exit(13);
      return;
    }
    if (message.id === 'workspace-read') {
      const result = message.result;
      if (result?.success !== true) process.exit(14);
      notify('item/agentMessage/delta', { itemId: 'answer', delta: result.contentItems[0].text });
      notify('turn/completed', { turn: { id: turnId, status: 'completed', items: [] } });
      return;
    }
    if (message.id !== 'approval') return;
    notify('item/agentMessage/delta', { itemId: 'answer', delta: message.result.decision === 'accept' ? 'Approved.' : 'Denied.' });
    if (mode !== 'usage-unknown') {
      const total = mode === 'usage-zero' ? { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 } : { inputTokens: 12, outputTokens: 4, cachedInputTokens: 0 };
      notify('thread/tokenUsage/updated', { tokenUsage: { total } });
    }
    send({ method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex', primary: { usedPercent: 25, windowDurationMins: 300 } }, accessToken: 'PRIVATE_PUSH_TOKEN' } });
    notify('turn/completed', { turn: { id: turnId, status: 'completed', items: [] } }); return;
  }
  const p = message.params ?? {};
  if (message.method === 'initialize') return void reply(message.id, { userAgent: 'fixture', codexHome: mode === 'wrong-home' ? '/unscoped-profile' : process.env.CODEX_HOME });
  if (message.method === 'initialized') return;
  if (message.method === 'config/read') return void reply(message.id, { config: { cli_auth_credentials_store: mode === 'wrong-store' ? 'keyring' : 'file', forced_login_method: 'chatgpt',
    features: { apps: !process.argv.includes('features.apps=false'), plugins: !process.argv.includes('features.plugins=false') },
    ...(mode === 'workspace-external-mcp' ? { mcp_servers: { outside: { enabled: true } } } : {}) } });
  if (message.method === 'model/list') return void reply(message.id, { data: [{ model: 'fixture-model', displayName: 'Fixture', contextWindow: 16384, accessToken: 'PRIVATE_MODEL_TOKEN' }] });
  if (message.method === 'account/read') return void reply(message.id, { account: { type: 'chatgpt', email: 'PRIVATE_EMAIL', accessToken: 'PRIVATE_TOKEN' } });
  if (message.method === 'account/rateLimits/read') return void reply(message.id, { rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { usedPercent: 25, windowDurationMins: 300 }, secondary: { usedPercent: 90, windowDurationMins: 10080 } } }, accessToken: 'PRIVATE_QUOTA_TOKEN' });
  if (message.method === 'account/login/start') {
    reply(message.id, { type: 'chatgptDeviceCode', loginId: 'fixture-login', verificationUrl: mode === 'bad-url' ? 'https://evil.invalid/device' : 'https://auth.openai.com/device', userCode: 'ABCD-EFGH', accessToken: 'PRIVATE_LOGIN_TOKEN' });
    if (mode !== 'login-hang') setTimeout(() => send({ method: 'account/login/completed', params: { loginId: 'fixture-login', success: true } }), 30);
    return;
  }
  if (message.method === 'account/login/cancel') return void reply(message.id, {});
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    if (mode === 'workspace-tools' && p.dynamicTools?.[0]?.name !== 'yed1z_read_file') process.exit(15);
    readOnly = p.sandbox === 'read-only'; return void reply(message.id, { thread: { id: threadId }, sandbox: { type: mode === 'unsafe' ? 'dangerFullAccess' : readOnly ? 'readOnly' : 'workspaceWrite' }, approvalsReviewer: 'user' });
  }
  if (message.method === 'turn/interrupt') return void reply(message.id, {});
  if (message.method === 'turn/start') {
    reply(message.id, { turn: { id: turnId, status: 'inProgress' } });
    if (mode === 'workspace-tools') {
      const call = (id: string, params: Data) => send({ id, method: 'item/tool/call', params: { threadId, turnId, callId: id, namespace: null, tool: 'yed1z_read_file', arguments: { path: 'index.js' }, ...params } });
      call('wrong-thread', { threadId: 'unrelated-thread' });
      call('wrong-namespace', { namespace: 'remote' });
      call('unknown-tool', { tool: 'write_file' });
      call('workspace-read', {});
      return;
    }
    notify('item/reasoning/textDelta', { delta: 'Model reasoning process' });
    notify('item/agentMessage/delta', { itemId: 'answer', delta: 'Hello. ' });
    if (mode === 'hang') return;
    send({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'command', command: 'git status --short', cwd: process.cwd(), availableDecisions: ['accept', 'decline', 'cancel'] } }); return;
  }
  send({ id: message.id, error: { code: -32601, message: 'PRIVATE_ERROR_TOKEN' } });
}
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  void handle(JSON.parse(line) as Data).catch(() => process.exit(12));
});
