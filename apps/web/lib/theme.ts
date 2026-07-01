'use client';

import { api, THEME_KEY, type Theme } from './api';

export type { Theme };

/** Current theme from localStorage (source of truth for the client between reloads). Defaults dark. */
export const getStoredTheme = (): Theme => {
  if (typeof window === 'undefined') return 'dark';
  return window.localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
};

/** Apply the theme to the document + persist locally (instant, no network). */
export const storeTheme = (theme: Theme): void => {
  if (typeof window !== 'undefined') window.localStorage.setItem(THEME_KEY, theme);
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = theme;
};

/**
 * Switch theme: apply locally at once (so the UI never lags) and persist to the DB via PATCH
 * /auth/me. A failed write is non-fatal — the local preference still holds for this session.
 */
export const setTheme = async (theme: Theme): Promise<void> => {
  storeTheme(theme);
  try {
    await api('/auth/me', { method: 'PATCH', body: JSON.stringify({ themePreference: theme }) });
  } catch {
    /* keep the local preference even if persistence fails */
  }
};
