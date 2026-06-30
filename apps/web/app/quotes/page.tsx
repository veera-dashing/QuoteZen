'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, getRole } from '@/lib/api';

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

export default function QuotesList() {
  const [rows, setRows] = useState<QuoteRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const canWrite = getRole() !== 'viewer';

  const load = useCallback(() => {
    setRows(null);
    api<QuoteRow[]>(`/quotes${showArchived ? '?archived=true' : ''}`)
      .then(setRows)
      .catch((e) => setError(e.message));
  }, [showArchived]);

  useEffect(() => {
    load();
  }, [load]);

  const archive = async (id: string, archived: boolean) => {
    setBusyId(id);
    setError(null);
    try {
      await api(`/quotes/${id}/${archived ? 'restore' : 'archive'}`, { method: 'POST' });
      // Row leaves the current view (active→archived or vice-versa): just reload.
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
        <h1>Quotes{showArchived ? ' · Archived' : ''}</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="ghost" onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? 'View active' : 'View archived'}
          </button>
          {canWrite && !showArchived && (
            <Link href="/quotes/new">
              <button className="primary">+ New quote</button>
            </Link>
          )}
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      {!rows && <div className="muted">Loading…</div>}
      {rows && rows.length === 0 && (
        <p className="muted">
          {showArchived ? 'No archived quotes.' : 'No quotes yet. Create your first one.'}
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
                  <td className="actions">
                    <Link href={`/quotes/${q.id}`}>
                      <button className="ghost">Open</button>
                    </Link>
                    {canWrite &&
                      (showArchived ? (
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
