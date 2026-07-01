'use client';

import { useEffect, useState } from 'react';
import { getStoredTheme, setTheme, type Theme } from '@/lib/theme';

/** Light/dark theme switch. Applies instantly and persists the choice to the DB (PATCH /auth/me). */
export default function ThemeToggle() {
  const [theme, setThemeState] = useState<Theme>('dark');

  // Read the resolved theme after mount (localStorage isn't available during SSR).
  useEffect(() => setThemeState(getStoredTheme()), []);

  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setThemeState(next);
    void setTheme(next);
  };

  const nextLabel = theme === 'dark' ? 'light' : 'dark';
  return (
    <button className="ghost" onClick={toggle} title={`Switch to ${nextLabel} theme`} aria-label={`Switch to ${nextLabel} theme`}>
      {theme === 'dark' ? '☀️ Light' : '🌙 Dark'}
    </button>
  );
}
