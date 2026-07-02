'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api, getRole } from '@/lib/api';
import SearchSelect from '@/components/SearchSelect';

interface QuoteRow {
  id: string;
  jobReference: string;
  status: string;
  grandTotal: string;
  client?: { name: string; clientTier?: { name: string } | null } | null;
  currency?: { code: string } | null;
  createdAt: string;
  requestedShippingDate?: string | null;
  archivedAt?: string | null;
}

interface ClientOption {
  id: string;
  name?: string;
}

/** Status filter pills (P1-19d). "all"/"archived" are special; the rest map to a status group. */
type Filter = 'all' | 'draft' | 'pending' | 'approved' | 'issued' | 'won' | 'lost' | 'archived';
const GROUPS: Record<Exclude<Filter, 'all' | 'archived'>, string[]> = {
  draft: ['draft'],
  pending: ['in_review', 'technical_review', 'commercial_review'], // mid review/approval workflow
  approved: ['approved'],
  issued: ['issued'],
  won: ['won'],
  lost: ['lost'],
};
const PILLS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'draft', label: 'Draft' },
  { key: 'pending', label: 'Pending approval' },
  { key: 'approved', label: 'Approved' },
  { key: 'issued', label: 'Issued' },
  { key: 'won', label: 'Won' },
  { key: 'lost', label: 'Lost' },
  { key: 'archived', label: 'Archived' },
];
const OPEN_STATUSES = [...GROUPS.draft, ...GROUPS.pending]; // "in progress" for the KPI cards

/** Per-status badge colour (theme vars). */
const statusStyle = (status: string): { bg: string; fg: string } => {
  if (status === 'won') return { bg: 'rgba(48,164,108,0.16)', fg: 'var(--ok)' };
  if (status === 'lost') return { bg: 'rgba(229,72,77,0.16)', fg: 'var(--danger)' };
  if (status === 'approved' || status === 'issued') return { bg: 'rgba(70,237,213,0.15)', fg: 'var(--accent)' };
  if (GROUPS.pending.includes(status)) return { bg: 'rgba(245,158,11,0.16)', fg: '#f59e0b' };
  return { bg: 'var(--surface-2)', fg: 'var(--muted)' }; // draft / other
};

/** YYYY-MM-DD for `monthsAgo` months before today (local) — the default "last two months" window. */
const isoMonthsAgo = (monthsAgo: number): string => {
  const d = new Date();
  d.setMonth(d.getMonth() - monthsAgo);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const relativeTime = (iso: string): string => {
  const diff = Date.now() - new Date(iso).getTime();
  const day = 86_400_000;
  if (diff < 3_600_000) return 'just now';
  if (diff < day) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 30 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(iso).toLocaleDateString();
};

export default function QuotesList() {
  // Raw fetched set (for the current date/client/search + archived flag), before the pill filter —
  // the KPI cards, the pill counts, and the table are all derived from this.
  const [fetched, setFetched] = useState<QuoteRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const canWrite = getRole() !== 'viewer';

  const defaultFrom = useMemo(() => isoMonthsAgo(2), []);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [clientId, setClientId] = useState('');
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState('');
  const [clients, setClients] = useState<ClientOption[]>([]);
  const isArchived = filter === 'archived';

  useEffect(() => {
    api<{ rows: ClientOption[] }>('/admin/clients?take=200')
      .then((r) => setClients(r.rows))
      .catch(() => setClients([]));
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const clientOptions = useMemo(
    () => clients.map((c) => ({ value: c.id, label: c.name ?? `Client ${c.id}` })),
    [clients],
  );

  // Fetch keyed on the archived flag + filters (NOT the pill) — status grouping is client-side, so
  // switching pills is instant and the KPI cards / counts stay stable.
  const load = useCallback(() => {
    setFetched(null);
    setError(null);
    const params = new URLSearchParams();
    if (isArchived) params.set('archived', 'true');
    if (debouncedSearch) params.set('q', debouncedSearch);
    if (clientId) params.set('clientId', clientId);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const qs = params.toString();
    api<QuoteRow[]>(`/quotes${qs ? `?${qs}` : ''}`)
      .then((data) => setFetched(data))
      .catch((e) => setError(e.message));
  }, [isArchived, debouncedSearch, clientId, from, to]);

  useEffect(() => {
    load();
  }, [load]);

  const rows = useMemo(() => {
    if (!fetched) return null;
    if (filter === 'all' || filter === 'archived') return fetched;
    const statuses = GROUPS[filter];
    return fetched.filter((q) => statuses.includes(q.status));
  }, [fetched, filter]);

  // Counts per pill over the current window (non-archived pills only; Archived has no live count).
  const counts = useMemo(() => {
    const f = fetched ?? [];
    const c: Record<string, number> = { all: f.length };
    (Object.keys(GROUPS) as Array<keyof typeof GROUPS>).forEach((k) => {
      c[k] = f.filter((q) => GROUPS[k].includes(q.status)).length;
    });
    return c;
  }, [fetched]);

  // KPI metrics over the current window (real data only — no AI confidence/time-saved).
  const metrics = useMemo(() => {
    const f = fetched ?? [];
    const sum = (pred: (q: QuoteRow) => boolean) =>
      f.filter(pred).reduce((t, q) => t + (Number(q.grandTotal) || 0), 0);
    const code = f[0]?.currency?.code ?? 'AUD';
    return {
      open: f.filter((q) => OPEN_STATUSES.includes(q.status)).length,
      pipeline: sum((q) => OPEN_STATUSES.includes(q.status)),
      pending: f.filter((q) => GROUPS.pending.includes(q.status)).length,
      wonValue: sum((q) => q.status === 'won'),
      code,
    };
  }, [fetched]);

  const money = (n: number, code: string) => `${code} ${Math.round(n).toLocaleString()}`;

  const clearFilters = () => {
    setSearch('');
    setClientId('');
    setFrom(defaultFrom);
    setTo('');
  };
  const hasFilters = Boolean(search || clientId || to || from !== defaultFrom);

  const archive = async (id: string, archived: boolean) => {
    setBusyId(id);
    setError(null);
    try {
      await api(`/quotes/${id}/${archived ? 'restore' : 'archive'}`, { method: 'POST' });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusyId(null);
    }
  };

  const KPIS: Array<{ label: string; value: string; sub: string }> = [
    { label: 'Open quotes', value: fetched ? String(metrics.open) : '—', sub: 'in progress' },
    { label: 'Pipeline value', value: fetched ? money(metrics.pipeline, metrics.code) : '—', sub: 'open quotes, est.' },
    { label: 'Awaiting approval', value: fetched ? String(metrics.pending) : '—', sub: 'in review' },
    { label: 'Won value', value: fetched ? money(metrics.wonValue, metrics.code) : '—', sub: 'in this window' },
  ];

  return (
    <div>
      <div className="topbar">
        <h1>Quotes</h1>
        {canWrite && !isArchived && (
          <Link href="/quotes/new">
            <button className="primary">+ New quote</button>
          </Link>
        )}
      </div>

      {/* KPI cards — real metrics over the current filter window. */}
      <div
        className="totals"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', marginBottom: 18 }}
      >
        {KPIS.map((k) => (
          <div key={k.label} className="stat">
            <div className="label" style={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              {k.label}
            </div>
            <div className="value">{k.value}</div>
            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
              {k.sub}
            </div>
          </div>
        ))}
      </div>

      {/* Status filter pills with counts. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
        {PILLS.map((p) => {
          const active = filter === p.key;
          const count = p.key === 'archived' ? null : counts[p.key] ?? 0;
          return (
            <button
              key={p.key}
              className={active ? 'primary' : 'ghost'}
              onClick={() => setFilter(p.key)}
              style={{ borderRadius: 999, ...(active ? {} : { border: '1px solid var(--border)' }) }}
            >
              {p.label}
              {count !== null && (
                <span style={{ opacity: 0.7, marginLeft: 6 }}>({fetched ? count : '…'})</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Filters */}
      <div
        className="filters"
        style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end', marginBottom: 16 }}
      >
        <div style={{ flex: '1 1 200px', minWidth: 180 }}>
          <label className="muted" style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>
            Search
          </label>
          <input
            placeholder="Search job ref…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: '100%' }}
          />
        </div>
        <div style={{ flex: '1 1 200px', minWidth: 180 }}>
          <label className="muted" style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>
            Client
          </label>
          <SearchSelect
            value={clientId}
            onChange={setClientId}
            options={clientOptions}
            placeholder="All clients"
            allowEmpty
          />
        </div>
        <div>
          <label className="muted" style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>
            Created from
          </label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label className="muted" style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>
            Created to
          </label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        {hasFilters && (
          <button className="ghost" onClick={clearFilters}>
            Clear filters
          </button>
        )}
      </div>

      {error && <div className="error">{error}</div>}
      {!rows && <div className="muted">Loading…</div>}
      {rows && rows.length === 0 && (
        <p className="muted">
          {filter === 'archived'
            ? 'No archived quotes.'
            : counts.all === 0
              ? hasFilters
                ? 'No quotes match these filters.'
                : 'No quotes yet. Create your first one.'
              : `No ${filter === 'all' ? 'quotes' : `${PILLS.find((p) => p.key === filter)?.label.toLowerCase()} quotes`}${hasFilters ? ' in this window' : ''}.`}
        </p>
      )}
      {rows && rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Brief</th>
                <th>Stage</th>
                <th>Tier</th>
                <th className="cell-num">Value</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((q) => {
                const s = statusStyle(q.status);
                return (
                  <tr key={q.id}>
                    <td>
                      <Link href={`/quotes/${q.id}`} style={{ fontWeight: 600 }}>
                        {q.jobReference}
                      </Link>
                      <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                        {q.client?.name ?? 'No client'} · {relativeTime(q.createdAt)}
                      </div>
                    </td>
                    <td>
                      <span
                        className="pill status-badge"
                        style={{ background: s.bg, color: s.fg, borderColor: 'transparent' }}
                      >
                        {q.status.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td>
                      {q.client?.clientTier?.name ? (
                        <span className="pill">{q.client.clientTier.name}</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="cell-num">
                      {q.currency?.code ?? ''} {Number(q.grandTotal).toLocaleString()}
                      <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                        {q.requestedShippingDate
                          ? `Go-live ${new Date(q.requestedShippingDate).toLocaleDateString()}`
                          : 'Go-live TBC'}
                      </div>
                    </td>
                    <td className="actions">
                      <Link href={`/quotes/${q.id}`}>
                        <button className="ghost">Open</button>
                      </Link>
                      {canWrite &&
                        (q.archivedAt ? (
                          <button className="ghost" disabled={busyId === q.id} onClick={() => archive(q.id, true)}>
                            {busyId === q.id ? '…' : 'Restore'}
                          </button>
                        ) : (
                          <button className="ghost" disabled={busyId === q.id} onClick={() => archive(q.id, false)}>
                            {busyId === q.id ? '…' : 'Archive'}
                          </button>
                        ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
