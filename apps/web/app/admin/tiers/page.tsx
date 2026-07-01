'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, getRole } from '@/lib/api';

/**
 * Z6 — "Tiers & per-client rules" admin page. Client tiers are rule-bearing entities: each tier
 * carries structured rules (preferred freight + default discount %) that the engine auto-applies when
 * it identifies the client, overridable per client (global→tier→client resolution). Below the tier
 * cards, per-client free-text rule notes are editable inline.
 */

interface ClientTier {
  id: string;
  name: string;
  label: string | null;
  description: string | null;
  installStandard: string | null;
  preferredFreight: string | null;
  defaultDiscountPct: string | null; // Decimal serialises as string
  deprecated?: boolean;
}

interface ClientRow {
  id: string;
  name: string;
  tier: string | null;
  rulesNote: string | null;
}

const pct = (v: string | null) => (v == null ? '—' : `${(Number(v) * 100).toFixed(1)}%`);

export default function TiersPage() {
  const router = useRouter();
  const [tiers, setTiers] = useState<ClientTier[] | null>(null);
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Inline-edit state for per-client rule notes: clientId → draft note.
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = () => {
    Promise.all([
      api<{ rows: ClientTier[] }>('/admin/client-tiers?take=200'),
      api<{ rows: ClientRow[] }>('/admin/clients?take=200'),
    ])
      .then(([t, c]) => {
        setTiers(t.rows.filter((row) => !row.deprecated));
        setClients(c.rows);
      })
      .catch((e) => setError(e.message));
  };

  useEffect(() => {
    if (getRole() !== 'admin') {
      router.replace('/quotes');
      return;
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  // Clients grouped by tier name (for the tier-card chips + counts).
  const byTier = useMemo(() => {
    const map = new Map<string, ClientRow[]>();
    for (const c of clients) {
      if (!c.tier) continue;
      const list = map.get(c.tier) ?? [];
      list.push(c);
      map.set(c.tier, list);
    }
    return map;
  }, [clients]);

  // Clients that have per-client rule logic captured (rulesNote), for the sample list.
  const withNotes = useMemo(() => clients.filter((c) => (c.rulesNote ?? '').trim().length > 0), [clients]);

  const saveNote = async (client: ClientRow) => {
    const note = draft[client.id] ?? '';
    setSavingId(client.id);
    setError(null);
    try {
      await api(`/admin/clients/${client.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ rulesNote: note }),
      });
      setDraft((d) => {
        const next = { ...d };
        delete next[client.id];
        return next;
      });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSavingId(null);
    }
  };

  if (error && !tiers) return <div className="center">Failed to load: {error}</div>;
  if (!tiers) return <div className="center">Loading…</div>;

  return (
    <div>
      <div className="topbar">
        <h1>Tiers &amp; per-client rules</h1>
      </div>
      <p className="muted">
        Rules below are auto-applied by the engine when it identifies the client. Resolution is
        global&nbsp;→&nbsp;tier&nbsp;→&nbsp;client: a client&apos;s own value wins over its tier, which
        wins over the system default.
      </p>

      {error && <div className="error">{error}</div>}

      {/* ── Tier cards ── */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: 16,
          marginBottom: 24,
        }}
      >
        {tiers.map((t) => {
          const members = byTier.get(t.name) ?? [];
          return (
            <div className="card" key={t.id} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 44,
                    height: 44,
                    borderRadius: 10,
                    fontWeight: 800,
                    fontSize: 18,
                    background: 'var(--accent, #6d5dfc)',
                    color: '#fff',
                  }}
                >
                  {t.name}
                </span>
                <div>
                  <div style={{ fontWeight: 700 }}>{t.label ?? `${t.name} tier`}</div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {members.length} CLIENT{members.length === 1 ? '' : 'S'}
                  </div>
                </div>
              </div>

              {t.description && <div style={{ fontSize: 14 }}>{t.description}</div>}

              <div className="table-wrap">
                <table>
                  <tbody>
                    <tr>
                      <td className="muted">Preferred freight</td>
                      <td>{t.preferredFreight ?? '—'}</td>
                    </tr>
                    <tr>
                      <td className="muted">Default discount</td>
                      <td>{pct(t.defaultDiscountPct)}</td>
                    </tr>
                    <tr>
                      <td className="muted">Install standard</td>
                      <td>{t.installStandard ?? '—'}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {members.length > 0 ? (
                  members.map((c) => (
                    <span key={c.id} className="pill">
                      {c.name}
                    </span>
                  ))
                ) : (
                  <span className="muted" style={{ fontSize: 13 }}>
                    No clients in this tier yet
                  </span>
                )}
                <Link href="/admin/clients" className="pill" style={{ textDecoration: 'none' }}>
                  + Add client
                </Link>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Sample per-client logic (editable rule notes) ── */}
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Sample per-client logic</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          Free-text rules captured against individual clients. Edit inline and Save; these layer on top
          of the client&apos;s tier.
        </p>
        {withNotes.length === 0 ? (
          <div className="muted">
            No per-client rule notes yet. Add a note to any client in{' '}
            <Link href="/admin/clients">Clients</Link>, or edit one below once present.
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Tier</th>
                  <th>Rule note</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {withNotes.map((c) => {
                  const editing = c.id in draft;
                  return (
                    <tr key={c.id}>
                      <td style={{ fontWeight: 600 }}>{c.name}</td>
                      <td>{c.tier ? <span className="pill">{c.tier}</span> : <span className="muted">—</span>}</td>
                      <td>
                        <input
                          style={{ width: '100%' }}
                          value={editing ? draft[c.id] : (c.rulesNote ?? '')}
                          onChange={(e) => setDraft((d) => ({ ...d, [c.id]: e.target.value }))}
                        />
                      </td>
                      <td>
                        <button
                          className="btn"
                          disabled={!editing || savingId === c.id}
                          onClick={() => saveNote(c)}
                        >
                          {savingId === c.id ? 'Saving…' : 'Save'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
