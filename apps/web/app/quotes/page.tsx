'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';

interface QuoteRow {
  id: string;
  jobReference: string;
  status: string;
  grandTotal: string;
  client?: { name: string } | null;
  currency?: { code: string } | null;
  createdAt: string;
}

export default function QuotesList() {
  const [rows, setRows] = useState<QuoteRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<QuoteRow[]>('/quotes')
      .then(setRows)
      .catch((e) => setError(e.message));
  }, []);

  return (
    <div>
      <div className="topbar">
        <h1>Quotes</h1>
        <Link href="/quotes/new">
          <button className="primary">+ New quote</button>
        </Link>
      </div>
      {error && <div className="error">{error}</div>}
      {!rows && <div className="muted">Loading…</div>}
      {rows && rows.length === 0 && <p className="muted">No quotes yet. Create your first one.</p>}
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
