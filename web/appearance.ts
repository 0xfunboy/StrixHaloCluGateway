import type { Appearance } from '../src/contracts.ts';

export function localAppearance(win: Window): Appearance {
  try {
    const theme = win.localStorage.getItem('theme');
    const crt = win.localStorage.getItem('crt');
    const motion = crt === 'false' ? 'off' : crt === 'true' ? 'on' : win.localStorage.getItem('yed1z.motion');
    return {
      ...(theme === 'dark' || theme === 'light' || theme === 'system' ? { theme } : {}),
      ...(motion === 'on' || motion === 'off' ? { motion } : {}),
    };
  } catch {
    return {};
  }
}

export function storeAppearance(win: Window, appearance: Appearance): void {
  try {
    if (appearance.theme) win.localStorage.setItem('theme', appearance.theme);
    if (appearance.motion) {
      win.localStorage.setItem('crt', String(appearance.motion === 'on'));
      win.localStorage.setItem('yed1z.motion', appearance.motion);
    }
  } catch { /* Storage can be disabled in the browser or isolated by the host. */ }
}

export function createAppearance(win: Window, render: (motionEnabled: boolean) => void) {
  const dark = win.matchMedia?.('(prefers-color-scheme: dark)');
  const reduced = win.matchMedia?.('(prefers-reduced-motion: reduce)');
  let preference = localAppearance(win);
  const apply = () => {
    const theme = preference.theme === 'dark' || preference.theme === 'light' ? preference.theme : dark?.matches === false ? 'light' : 'dark';
    const motion = preference.motion !== 'off' && !reduced?.matches;
    const html = win.document.documentElement;
    html.dataset.theme = theme;
    html.dataset.motion = motion ? 'on' : 'off';
    render(motion);
  };
  const storage = (event: StorageEvent) => {
    if (event.key === null || ['theme', 'crt', 'yed1z.motion'].includes(event.key)) {
      preference = localAppearance(win);
      apply();
    }
  };
  dark?.addEventListener('change', apply);
  reduced?.addEventListener('change', apply);
  win.addEventListener('storage', storage);
  apply();
  return {
    get value(): Required<Appearance> {
      return { theme: preference.theme ?? 'system', motion: preference.motion ?? 'on' };
    },
    get reduced(): boolean { return reduced?.matches === true; },
    update(change: Appearance): void {
      preference = { ...preference, ...change };
      storeAppearance(win, change);
      apply();
    },
    dispose(): void {
      dark?.removeEventListener('change', apply);
      reduced?.removeEventListener('change', apply);
      win.removeEventListener('storage', storage);
    },
  };
}
