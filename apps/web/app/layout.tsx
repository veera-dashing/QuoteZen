import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'QuoteZen Admin',
  description: 'Seen Technology quoting engine — reference data admin',
};

// Runs before first paint so the persisted theme is applied without a flash of the wrong palette.
// 'system' (or an unknown value) resolves against the OS colour scheme; missing → dark (legacy default).
const themeScript = `try{var t=localStorage.getItem('quotezen_theme');var d=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.dataset.theme=(t==='light'?'light':t==='dark'?'dark':t==='system'?(d?'dark':'light'):'dark');}catch(e){document.documentElement.dataset.theme='dark';}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
