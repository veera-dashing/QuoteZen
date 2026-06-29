'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, clearToken, getToken } from '@/lib/api';
import type { TableDef } from '@/lib/types';

export default function AdminLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [tables, setTables] = useState<TableDef[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!getToken()) {
      router.replace('/login');
      return;
    }
    api<{ tables: TableDef[] }>('/admin/_meta')
      .then((r) => setTables(r.tables))
      .catch((e) => setError(e.message));
  }, [router]);

  const groups = useMemo(() => {
    const map = new Map<string, TableDef[]>();
    for (const t of tables ?? []) {
      const list = map.get(t.group) ?? [];
      list.push(t);
      map.set(t.group, list);
    }
    return [...map.entries()];
  }, [tables]);

  const signOut = () => {
    clearToken();
    router.replace('/login');
  };

  if (error) return <div className="center">Failed to load: {error}</div>;
  if (!tables) return <div className="center">Loading…</div>;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          🧾 QuoteZen <small>admin</small>
        </div>
        <Link href="/quotes" className="nav-item" style={{ fontWeight: 600 }}>
          <span>📐 Quotes</span>
        </Link>
        <div className="nav-group">Reference data</div>
        {groups.map(([group, items]) => (
          <div key={group}>
            <div className="nav-group">{group}</div>
            {items.map((t) => {
              const href = `/admin/${t.resource}`;
              const active = pathname === href;
              return (
                <Link key={t.resource} href={href} className={`nav-item${active ? ' active' : ''}`}>
                  <span>{t.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
        <div style={{ marginTop: 20, padding: '0 10px' }}>
          <button className="ghost" onClick={signOut}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
