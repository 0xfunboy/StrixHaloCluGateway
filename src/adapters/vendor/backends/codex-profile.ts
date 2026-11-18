import type { Profile } from '../core/types.ts';
import { record, type JsonRpcProcess } from './rpc.ts';

/** Use the same official credential store for an isolated profile on every operation. */
export function codexArgs(profile: Profile, login = false, workspaceBound = false): string[] {
  const args = [...(profile.args ?? ['app-server', '--listen', 'stdio://'])];
  if (profile.env?.CODEX_HOME) args.push('-c', 'cli_auth_credentials_store="file"');
  if (login) args.push('-c', 'forced_login_method="chatgpt"');
  if (workspaceBound) args.push('-c', 'features.apps=false', '-c', 'features.plugins=false');
  return args;
}

/** Reject a fallback to an ambient credential store before inspecting or starting a turn. */
export async function confirmCodexProfile(
  rpc: JsonRpcProcess, initialized: unknown, directory: string | undefined, signal: AbortSignal, login = false, workspace?: string,
): Promise<void> {
  if (!directory || record(initialized).codexHome !== directory) {
    throw new Error('Codex did not confirm the isolated account directory. Check the official CLI configuration.');
  }
  const effective = record(record(await rpc.request('config/read', { includeLayers: false, cwd: workspace }, { signal })).config);
  if (effective.cli_auth_credentials_store !== 'file' || (login && effective.forced_login_method !== 'chatgpt')) {
    throw new Error('Codex did not confirm the isolated file credential store for this account.');
  }
  if (workspace) {
    const features = record(effective.features);
    const activeMcp = Object.values(record(effective.mcp_servers)).some(server => record(server).enabled !== false);
    if (features.apps !== false || features.plugins !== false || activeMcp) {
      throw Object.assign(new Error('Codex did not confirm restricted workspace tools. Disable configured external MCP servers in the managed workspace profile.'), { code: 'NATIVE_WORKSPACE_SETUP' });
    }
  }
}
