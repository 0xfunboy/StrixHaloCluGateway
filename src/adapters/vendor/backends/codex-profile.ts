import type { Profile } from '../core/types.ts';

/** Use the same official credential store for an isolated profile on every operation. */
export function codexArgs(profile: Profile, login = false): string[] {
  const args = [...(profile.args ?? ['app-server', '--listen', 'stdio://'])];
  if (profile.env?.CODEX_HOME) args.push('-c', 'cli_auth_credentials_store="file"');
  if (login) args.push('-c', 'forced_login_method="chatgpt"');
  return args;
}
