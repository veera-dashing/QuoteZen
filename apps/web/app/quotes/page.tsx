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
type Tab = 'drafts' | 'finished' | 'all' | 'archived';
const DRAFT_STATUSES = ['draft', 'in_review'];
const FINISHED_STATUSES = ['approved', 'issued', 'won', 'lost'];
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'drafts', label: 'Drafts' },
  { key: 'finished', label: 'Finished' },
  { key: 'all', label: 'All' },
  { key: 'archived', label: 'Archived' },
];

export default function QuotesList() {
  const [rows, setRows] = useState<QuoteRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const canWrite = getRole() !== 'viewer';

  // Filter controls.
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [clientId, setClientId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [clients, setClients] = useState<ClientOption[]>([]);

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

  const load = useCallback(() => {
    setRows(null);
    setError(null);
    const params = new URLSearchParams();
    if (tab === 'archived') params.set('archived', 'true');
    // "Finished" is a status group; we fetch the group and filter client-side (the server `status`
    // param is a single value). Drafts is also a group. "All"/"Archived" carry no status param.
    if (debouncedSearch) params.set('q', debouncedSearch);
    if (clientId) params.set('clientId', clientId);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const qs = params.toString();
    api<QuoteRow[]>(`/quotes${qs ? `?${qs}` : ''}`)
      .then((data) => {
        const grouped =
          tab === 'drafts'
            ? data.filter((q) => DRAFT_STATUSES.includes(q.status))
            : tab === 'finished'
              ? data.filter((q) => FINISHED_STATUSES.includes(q.status))
              : data;
        setRows(grouped);
      })
      .catch((e) => setError(e.message));
  }, [tab, debouncedSearch, clientId, from, to]);

  useEffect(() => {
    load();
  }, [load]);

  const clearFilters = () => {
    setSearch('');
    setClientId('');
    setFrom('');
    setTo('');
  };
  const hasFilters = Boolean(search || clientId || from || to);

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
            : hasFilters
              ? 'No quotes match these filters.'
              : 'No quotes yet. Create your first one.'}
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
