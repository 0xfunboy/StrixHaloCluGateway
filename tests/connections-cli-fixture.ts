import { createInterface } from 'node:readline';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const mode = process.argv[2] ?? 'models';
const geminiDirectory = process.argv[process.argv.indexOf('--gemini-dir') + 1];
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
if (process.argv.includes('--login')) {
  if (mode !== 'profile-file') process.exit(2);
  process.stdout.write('Open this link in a browser to log in with Google:\nhttps://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=fixture&redirect_uri=https%3A%2F%2Fexample.test%2Fdone\nThen paste the authorization code:\n');
  createInterface({input:process.stdin}).once('line',value=>{
    if (value!=='valid-fixture-code') process.exit(3);
    writeFileSync(path.join(geminiDirectory,'fixture-signed-in'),'ok');
    process.exit(0);
  });
} else createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    if (message.params.clientCapabilities.terminal !== false || message.params.clientCapabilities.fs.writeTextFile !== false) process.exit(21);
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: mode === 'wrong-version' ? 9 : 1, authMethods: [{ id: 'oauth-personal', name: 'Google', accessToken: 'PRIVATE_AUTH_TOKEN' }], agentCapabilities: {} } });
  } else if (message.method === 'session/new') {
    if (message.params.mcpServers.length !== 0) process.exit(22);
    const hasProfile = mode !== 'profile-file' || (path.isAbsolute(geminiDirectory) && existsSync(path.join(geminiDirectory, 'fixture-signed-in')));
    if (mode === 'unauthenticated' || !hasProfile) send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Authentication required PRIVATE_ERROR_TOKEN' } });
    else send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'inspection-session', ...(mode === 'no-models' ? {} : mode === 'legacy-models' ? { models: { availableModels: [{ modelId: 'observed-legacy-model', name: 'Observed legacy' }] } } : { configOptions: [{ id: 'model', category: 'model', type: 'select', options: [{ name: 'Fixture group', options: [{ value: 'observed-fixture-model', name: 'Observed ACP model', accessToken: 'PRIVATE_MODEL_TOKEN' }] }] }] }), accessToken: 'PRIVATE_SESSION_TOKEN' } });
  } else if (message.method === 'session/prompt' || message.method === 'authenticate') process.exit(23);
  else send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported' } });
});
