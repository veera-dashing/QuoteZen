'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { clearToken, getToken } from '@/lib/api';

export default function QuotesLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getToken()) router.replace('/login');
    else setReady(true);
  }, [router]);

  if (!ready) return <div className="center">Loading…</div>;

  return (
    <div>
      <header className="qheader">
        <div className="brand">
          🧾 QuoteZen <small>quotes</small>
        </div>
        <nav className="qnav">
          <Link href="/quotes">Quotes</Link>
          <Link href="/admin">Reference data</Link>
          <button
            className="ghost"
            onClick={() => {
              clearToken();
              router.replace('/login');
            }}
          >
            Sign out
          </button>
        </nav>
      </header>
      <main className="main" style={{ maxWidth: 1100, margin: '0 auto' }}>
        {children}
      </main>
    </div>
  );
}
