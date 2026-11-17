import { createInterface } from 'node:readline';
const mode = process.argv[2] ?? 'models';
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    if (message.params.clientCapabilities.terminal !== false || message.params.clientCapabilities.fs.writeTextFile !== false) process.exit(21);
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: mode === 'wrong-version' ? 9 : 1, authMethods: [{ id: 'oauth-personal', name: 'Google', accessToken: 'PRIVATE_AUTH_TOKEN' }], agentCapabilities: {} } });
  } else if (message.method === 'session/new') {
    if (message.params.mcpServers.length !== 0) process.exit(22);
    if (mode === 'unauthenticated') send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Authentication required PRIVATE_ERROR_TOKEN' } });
    else send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'inspection-session', ...(mode === 'no-models' ? {} : mode === 'legacy-models' ? { models: { availableModels: [{ modelId: 'observed-legacy-model', name: 'Observed legacy' }] } } : { configOptions: [{ id: 'model', category: 'model', type: 'select', options: [{ name: 'Fixture group', options: [{ value: 'observed-fixture-model', name: 'Observed ACP model', accessToken: 'PRIVATE_MODEL_TOKEN' }] }] }] }), accessToken: 'PRIVATE_SESSION_TOKEN' } });
  } else if (message.method === 'session/prompt' || message.method === 'authenticate') process.exit(23);
  else send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported' } });
});
