'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface KbRow {
  id: string;
  jobReference: string;
  clientName: string | null;
  locationName: string | null;
  productModels: string | null;
  grandTotal: string;
  margin: string | null;
  outcome: string;
  capturedAt: string;
}

const OUTCOMES = ['', 'issued', 'won', 'lost'];

export default function KbPage() {
  const [rows, setRows] = useState<KbRow[] | null>(null);
  const [outcome, setOutcome] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    const q = outcome ? `?outcome=${outcome}` : '';
    api<KbRow[]>(`/kb${q}`)
      .then(setRows)
      .catch((e) => setError(e.message));
  }, [outcome]);

  useEffect(load, [load]);

  if (error) return <div className="error">{error}</div>;

  return (
    <div>
      <div className="topbar">
        <h1>Knowledge base</h1>
      </div>
      <p className="muted">Completed quotes captured with structured metadata — the corpus for future similarity checks.</p>
      <div className="toolbar">
        <select value={outcome} onChange={(e) => setOutcome(e.target.value)} style={{ width: 180 }}>
          {OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {o || 'All outcomes'}
            </option>
          ))}
        </select>
        <div className="spacer" />
        <span className="muted">{rows?.length ?? 0} entries</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Job ref</th>
              <th>Client</th>
              <th>Products</th>
              <th className="cell-num">Grand total</th>
              <th className="cell-num">Margin</th>
              <th>Outcome</th>
              <th>Captured</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((r) => (
              <tr key={r.id}>
                <td>{r.jobReference}</td>
                <td>{r.clientName ?? '—'}</td>
                <td className="muted">{r.productModels ?? '—'}</td>
                <td className="cell-num">{Number(r.grandTotal).toLocaleString()}</td>
                <td className="cell-num">{r.margin ? `${(Number(r.margin) * 100).toFixed(1)}%` : '—'}</td>
                <td>
                  <span className="pill">{r.outcome}</span>
                </td>
                <td className="muted">{new Date(r.capturedAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
