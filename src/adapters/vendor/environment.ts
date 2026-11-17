/** Never inherit model keys, server tokens, or runtime injection variables. */
const INHERITED = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM',
  'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
  'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
]);
const FORBIDDEN = /(?:authorization|api[-_]?key|token|secret|password|cookie|credential|^NODE_OPTIONS$|^NODE_PATH$|^LD_|^DYLD_|^PYTHONPATH$|^BASH_ENV$|^ENV$)/i;

export function runtimeEnvironment(overrides?: Record<string, string>): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of INHERITED) if (process.env[key] !== undefined) result[key] = process.env[key];
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || FORBIDDEN.test(key) || value.includes('\0')) {
      throw new Error('Runtime environment contains a forbidden credential or injection field.');
    }
    // Overrides are trusted server profile configuration, never browser input.
    result[key] = value;
  }
  return result;
}
