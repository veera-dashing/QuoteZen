'use client';

import { api, THEME_KEY, type Theme } from './api';

export type { Theme };
/** The concrete palette applied to the DOM (a 'system' preference resolves to one of these). */
export type AppliedTheme = 'light' | 'dark';

/** Stored PREFERENCE from localStorage (source of truth between reloads). Defaults dark. */
export const getStoredPref = (): Theme => {
  if (typeof window === 'undefined') return 'dark';
  const t = window.localStorage.getItem(THEME_KEY);
  return t === 'light' || t === 'dark' || t === 'system' ? t : 'dark';
};

/** The OS colour scheme (prefers-color-scheme). Falls back to light where unavailable. */
export const systemTheme = (): AppliedTheme =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';

/** Resolve a preference to the concrete palette to apply. */
export const resolveTheme = (pref: Theme): AppliedTheme => (pref === 'system' ? systemTheme() : pref);

/** Apply a preference to the document + persist it locally (instant, no network). */
export const storePref = (pref: Theme): void => {
  if (typeof window !== 'undefined') window.localStorage.setItem(THEME_KEY, pref);
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = resolveTheme(pref);
};

/**
 * Set the theme preference: apply locally at once (so the UI never lags) and persist to the DB via
 * PATCH /auth/me. A failed write is non-fatal — the local preference still holds for this session.
 */
export const setThemePref = async (pref: Theme): Promise<void> => {
  storePref(pref);
  try {
    await api('/auth/me', { method: 'PATCH', body: JSON.stringify({ themePreference: pref }) });
  } catch {
    /* keep the local preference even if persistence fails */
  }
};
