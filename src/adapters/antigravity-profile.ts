import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { AdapterConnection } from './types.ts';

const PROFILE_FLAGS = /^--(?:gemini[-_]dir|app[-_]data[-_]dir|cli_dir_name|cli_log_file|log-file|login|use_stubby_auth|dangerously-skip-permissions)(?:=|$)/;
const DEFAULT_ARGS = ['acp', '--sandbox', '--disable-telemetry'];

export function privateRuntimeDirectory(directory: string): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  const canonical = realpathSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || canonical !== path.resolve(directory)
      || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())))) {
    throw new Error('Native account directory must be owned by the service user, private (0700) and not a symlink.');
  }
  return canonical;
}

function managedFlags(directory: string): string[] {
  return ['--gemini-dir', path.join(directory, 'gemini'), '--app-data-dir', 'antigravity-cli'];
}

function managedEnvironment(directory: string): Record<string, string> {
  return {
    // Override OS credential lookup paths as well as ACP's own data directory.
    XDG_CONFIG_HOME: privateRuntimeDirectory(path.join(directory, 'config')),
    XDG_DATA_HOME: privateRuntimeDirectory(path.join(directory, 'data')),
    XDG_CACHE_HOME: privateRuntimeDirectory(path.join(directory, 'cache')),
    XDG_STATE_HOME: privateRuntimeDirectory(path.join(directory, 'state')),
    XDG_RUNTIME_DIR: privateRuntimeDirectory(path.join(directory, 'runtime')),
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=' + path.join(directory, 'runtime', 'no-session-bus'),
  };
}

export function bindAntigravityProfile(connection: AdapterConnection, location: string): AdapterConnection {
  const directory = privateRuntimeDirectory(location);
  const args = connection.args ?? DEFAULT_ARGS;
  if (args.some(arg => PROFILE_FLAGS.test(arg))) {
    throw new Error('Antigravity isolated accounts require an ACP launcher without global profile, login or permission overrides.');
  }
  privateRuntimeDirectory(path.join(directory, 'gemini'));
  return {
    ...connection,
    isolatedProfilePath: directory,
    args: [...args, ...managedFlags(directory)],
    env: { ...connection.env, ...managedEnvironment(directory) },
  };
}

function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

/** Render a private sign-in command without exposing the server's custom args or environment. */
export function antigravityLoginCommand(connection: AdapterConnection, executable = 'agy'): string {
  const directory = connection.isolatedProfilePath;
  if (!directory) return [quote(executable), 'acp', '--login'].join(' ');
  const env = Object.entries(managedEnvironment(directory)).map(([key, value]) => quote(key + '=' + value));
  return ['env -i "PATH=$PATH" "HOME=$HOME" "TERM=${TERM:-dumb}" "LANG=${LANG:-C.UTF-8}"',
    ...env, quote(executable), ...[...DEFAULT_ARGS, ...managedFlags(directory), '--login'].map(quote)].join(' ');
}
