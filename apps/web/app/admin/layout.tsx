'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, clearToken, getRole, getToken, type Role } from '@/lib/api';
import type { TableDef } from '@/lib/types';

// Top-level nav items and which roles may see them.
const NAV: Array<{ href: string; label: string; roles: Role[] }> = [
  { href: '/quotes', label: '📐 Quotes', roles: ['admin', 'sales'] },
  { href: '/admin/users', label: '👥 Users & roles', roles: ['admin'] },
  { href: '/admin/audit', label: '📜 Audit log', roles: ['admin'] },
  { href: '/admin/kb', label: '📚 Knowledge base', roles: ['admin', 'sales'] },
  { href: '/admin/rules', label: '⚖️ Effective rules', roles: ['admin', 'sales'] },
];

export default function AdminLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [role, setRole] = useState<Role | null>(null);
  const [tables, setTables] = useState<TableDef[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!getToken()) {
      router.replace('/login');
      return;
    }
    const r = getRole();
    // Viewers have no admin/reference area — send them to their quotes.
    if (r === 'viewer') {
      router.replace('/quotes');
      return;
    }
    setRole(r);
    // Reference data is for admin + sales only.
    if (r === 'admin' || r === 'sales') {
      api<{ tables: TableDef[] }>('/admin/_meta')
        .then((res) => setTables(res.tables))
        .catch((e) => setError(e.message));
    } else {
      setTables([]);
    }
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
  if (!role || !tables) return <div className="center">Loading…</div>;

  const canSeeReference = role === 'admin' || role === 'sales';
  const navItems = NAV.filter((n) => n.roles.includes(role));

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          🧾 QuoteZen <small>{role}</small>
        </div>
        {navItems.map((n) => (
          <Link key={n.href} href={n.href} className="nav-item" style={{ fontWeight: 600 }}>
            <span>{n.label}</span>
          </Link>
        ))}
        {canSeeReference && <div className="nav-group">Reference data</div>}
        {canSeeReference &&
          groups.map(([group, items]) => (
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
