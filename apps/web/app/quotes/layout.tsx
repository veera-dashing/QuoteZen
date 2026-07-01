'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { clearToken, getRole, getToken, type Role } from '@/lib/api';

export default function QuotesLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [role, setRole] = useState<Role | null>(null);

  useEffect(() => {
    if (!getToken()) router.replace('/login');
    else {
      setRole(getRole());
      setReady(true);
    }
  }, [router]);

  if (!ready) return <div className="center">Loading…</div>;

  // Reference data is visible to all internal staff (everyone except read-only viewers).
  const canSeeReference = role !== null && role !== 'viewer';

  return (
    <div>
      <header className="qheader">
        <div className="brand">
          🧾 QuoteZen <small>quotes</small>
        </div>
        <nav className="qnav">
          <Link href="/quotes">Quotes</Link>
          {canSeeReference && <Link href="/admin">Reference data</Link>}
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
