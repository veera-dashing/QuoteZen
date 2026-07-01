'use client';

import { useEffect, useState } from 'react';
import { getStoredPref, setThemePref, storePref, type Theme } from '@/lib/theme';

const ORDER: Theme[] = ['light', 'dark', 'system'];
const META: Record<Theme, { icon: string; label: string }> = {
  light: { icon: '☀️', label: 'Light' },
  dark: { icon: '🌙', label: 'Dark' },
  system: { icon: '🖥️', label: 'System' },
};

/**
 * Light/dark/system theme switch. Clicking cycles Light → Dark → System. Applies instantly and
 * persists the choice to the DB (PATCH /auth/me). While set to System, it re-applies live when the
 * OS colour scheme changes.
 */
export default function ThemeToggle() {
  const [pref, setPref] = useState<Theme>('dark');

  // Read the resolved preference after mount (localStorage isn't available during SSR).
  useEffect(() => setPref(getStoredPref()), []);

  // While following the OS, re-resolve the palette when the OS colour scheme flips.
  useEffect(() => {
    if (pref !== 'system' || typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => storePref('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [pref]);

  const cycle = () => {
    const next = ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length] as Theme;
    setPref(next);
    void setThemePref(next);
  };

  const nextPref = ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length] as Theme;
  return (
    <button
      className="ghost"
      onClick={cycle}
      title={`Theme: ${META[pref].label}. Click for ${META[nextPref].label}.`}
      aria-label={`Theme: ${META[pref].label}. Click to switch to ${META[nextPref].label}.`}
    >
      {META[pref].icon} {META[pref].label}
    </button>
  );
}
