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
  client?: { name: string } | null;
  currency?: { code: string } | null;
  createdAt: string;
  archivedAt?: string | null;
}

interface ClientOption {
  id: string;
  name?: string;
}

/** Dashboard tabs (P1-19d.1). Each maps to the set of statuses it shows. */
type Tab = 'drafts' | 'pending' | 'finished' | 'all' | 'archived';
const DRAFT_STATUSES = ['draft'];
// "Pending approval" — anything mid review/approval workflow (T1 two-stage review + legacy in_review).
const PENDING_STATUSES = ['in_review', 'technical_review', 'commercial_review'];
const FINISHED_STATUSES = ['approved', 'issued', 'won', 'lost'];
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'drafts', label: 'Drafts' },
  { key: 'pending', label: 'Pending approval' },
  { key: 'finished', label: 'Finished' },
  { key: 'archived', label: 'Archived' },
];

/** Which status-group a tab shows (null = every status, i.e. All/Archived). */
const tabStatuses = (t: Tab): string[] | null =>
  t === 'drafts' ? DRAFT_STATUSES : t === 'pending' ? PENDING_STATUSES : t === 'finished' ? FINISHED_STATUSES : null;

/** YYYY-MM-DD for `monthsAgo` months before today (local) — used for the default "last two months" window. */
const isoMonthsAgo = (monthsAgo: number): string => {
  const d = new Date();
  d.setMonth(d.getMonth() - monthsAgo);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export default function QuotesList() {
  // Raw fetched set (for the current date/client/search + archived flag), before tab grouping — the
  // summary cards + each tab's list are both derived from this.
  const [fetched, setFetched] = useState<QuoteRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const canWrite = getRole() !== 'viewer';

  // Filter controls. Default to the last two months (from = 2 months ago, to = open-ended).
  const defaultFrom = useMemo(() => isoMonthsAgo(2), []);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [clientId, setClientId] = useState('');
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState('');
  const [clients, setClients] = useState<ClientOption[]>([]);
  const isArchived = tab === 'archived';

  // Populate the client filter once.
  useEffect(() => {
    api<{ rows: ClientOption[] }>('/admin/clients?take=200')
      .then((r) => setClients(r.rows))
      .catch(() => setClients([]));
  }, []);

  // Debounce the jobRef search → server `q`.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const clientOptions = useMemo(
    () => clients.map((c) => ({ value: c.id, label: c.name ?? `Client ${c.id}` })),
    [clients],
  );

  // Fetch is keyed on the archived flag + filters (NOT the tab) — the draft/pending/finished/all
  // grouping is done client-side, so switching between those tabs is instant (no refetch) and the
  // summary cards stay stable.
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

  // Rows for the active tab (client-side status grouping).
  const rows = useMemo(() => {
    if (!fetched) return null;
    const statuses = tabStatuses(tab);
    return statuses ? fetched.filter((q) => statuses.includes(q.status)) : fetched;
  }, [fetched, tab]);

  // Summary counts over the current (date/client/search-filtered) set, mirroring the tabs.
  const summary = useMemo(() => {
    const f = fetched ?? [];
    return {
      total: f.length,
      drafts: f.filter((q) => DRAFT_STATUSES.includes(q.status)).length,
      pending: f.filter((q) => PENDING_STATUSES.includes(q.status)).length,
      finished: f.filter((q) => FINISHED_STATUSES.includes(q.status)).length,
    };
  }, [fetched]);

  // Reset to the default view (last two months, no client/search). Full-time can be had by clearing
  // the "Created from" field manually.
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

  return (
    <div>
      <div className="topbar">
        <h1>Quotes</h1>
        {canWrite && tab !== 'archived' && (
          <Link href="/quotes/new">
            <button className="primary">+ New quote</button>
          </Link>
        )}
      </div>

      {/* Summary cards — counts over the current date/client/search filter, and quick tab nav. */}
      <div
        className="totals"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', marginBottom: 16 }}
      >
        {([
          { key: 'all', label: isArchived ? 'Archived' : 'Total', value: summary.total },
          { key: 'drafts', label: 'Drafts', value: summary.drafts },
          { key: 'pending', label: 'Pending approval', value: summary.pending },
          { key: 'finished', label: 'Finished', value: summary.finished },
        ] as Array<{ key: Tab; label: string; value: number }>).map((c) => (
          <button
            key={c.key}
            type="button"
            className="stat"
            onClick={() => setTab(c.key)}
            style={{
              textAlign: 'left',
              cursor: 'pointer',
              borderColor: tab === c.key ? 'var(--accent)' : undefined,
            }}
          >
            <div className="label">{c.label}</div>
            <div className="value">{fetched ? c.value : '—'}</div>
          </button>
        ))}
      </div>

      {/* Tabs */}
      <div className="tabs" style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            className={tab === t.key ? 'primary' : 'ghost'}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div
        className="filters"
        style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end', marginBottom: 16 }}
      >
        <div style={{ flex: '1 1 200px', minWidth: 180 }}>
          <label className="muted" style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>
            Job reference
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
          {tab === 'archived'
            ? 'No archived quotes.'
            : summary.total === 0
              ? hasFilters
                ? 'No quotes match these filters.'
                : 'No quotes yet. Create your first one.'
              : // other quotes exist in this window, just none in the active group
                `No quotes ${
                  tab === 'pending' ? 'pending approval' : tab === 'drafts' ? 'in draft' : tab === 'finished' ? 'finished' : 'match these filters'
                }${hasFilters ? ' in this window' : ''}.`}
        </p>
      )}
      {rows && rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Job ref</th>
                <th>Client</th>
                <th>Status</th>
                <th className="cell-num">Grand total</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((q) => (
                <tr key={q.id}>
                  <td>{q.jobReference}</td>
                  <td>{q.client?.name ?? '—'}</td>
                  <td>
                    <span className="pill status-badge">{q.status.replace('_', ' ')}</span>
                  </td>
                  <td className="cell-num">
                    {q.currency?.code ?? ''} {Number(q.grandTotal).toLocaleString()}
                  </td>
                  <td>{new Date(q.createdAt).toLocaleDateString()}</td>
                  <td className="actions">
                    <Link href={`/quotes/${q.id}`}>
                      <button className="ghost">Open</button>
                    </Link>
                    {canWrite &&
                      (q.archivedAt ? (
                        <button
                          className="ghost"
                          disabled={busyId === q.id}
                          onClick={() => archive(q.id, true)}
                        >
                          {busyId === q.id ? '…' : 'Restore'}
                        </button>
                      ) : (
                        <button
                          className="ghost"
                          disabled={busyId === q.id}
                          onClick={() => archive(q.id, false)}
                        >
                          {busyId === q.id ? '…' : 'Archive'}
                        </button>
                      ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
