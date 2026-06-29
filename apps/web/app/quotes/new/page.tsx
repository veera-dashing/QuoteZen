'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';

interface Option {
  id: string;
  name?: string;
  code?: string;
}

export default function NewQuote() {
  const router = useRouter();
  const [jobReference, setJobReference] = useState('');
  const [clientId, setClientId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [currencyCode, setCurrencyCode] = useState('AUD');
  const [clients, setClients] = useState<Option[]>([]);
  const [locations, setLocations] = useState<Option[]>([]);
  const [currencies, setCurrencies] = useState<Option[]>([]);
  const [viewers, setViewers] = useState<Array<{ id: string; name: string; email: string }>>([]);
  const [selectedViewers, setSelectedViewers] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([
      api<{ rows: Option[] }>('/admin/clients?take=200'),
      api<{ rows: Option[] }>('/admin/locations?take=200'),
      api<Option[]>('/catalog/currencies'),
      api<Array<{ id: string; name: string; email: string }>>('/users/viewers'),
    ])
      .then(([c, l, cur, v]) => {
        setClients(c.rows);
        setLocations(l.rows);
        setCurrencies(cur);
        setViewers(v);
      })
      .catch((e) => setError(e.message));
  }, []);

  const toggleViewer = (id: string) =>
    setSelectedViewers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const quote = await api<{ id: string }>('/quotes', {
        method: 'POST',
        body: JSON.stringify({
          jobReference,
          currencyCode,
          clientId: clientId ? Number(clientId) : undefined,
          locationId: locationId ? Number(locationId) : undefined,
          viewerUserIds: selectedViewers.size ? [...selectedViewers].map(Number) : undefined,
        }),
      });
      router.replace(`/quotes/${quote.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="topbar">
        <h1>New quote</h1>
      </div>
      <form className="card" onSubmit={submit} style={{ maxWidth: 560 }}>
        <div className="field">
          <label>Job reference *</label>
          <input value={jobReference} onChange={(e) => setJobReference(e.target.value)} placeholder="2026-001" />
        </div>
        <div className="grid2">
          <div className="field">
            <label>Client</label>
            <select value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">—</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Location</label>
            <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">—</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label>Currency</label>
          <select value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value)}>
            {currencies.map((c) => (
              <option key={c.id} value={c.code}>
                {c.code}
              </option>
            ))}
          </select>
        </div>
        {viewers.length > 0 && (
          <div className="field">
            <label>Share with viewers (read-only access)</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {viewers.map((v) => (
                <label
                  key={v.id}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text)', cursor: 'pointer' }}
                >
                  <input
                    type="checkbox"
                    checked={selectedViewers.has(v.id)}
                    onChange={() => toggleViewer(v.id)}
                    style={{ width: 'auto' }}
                  />
                  {v.name}
                </label>
              ))}
            </div>
          </div>
        )}
        {error && <div className="error">{error}</div>}
        <div className="step-actions">
          <button className="primary" type="submit" disabled={busy || !jobReference}>
            {busy ? 'Creating…' : 'Create & continue'}
          </button>
        </div>
      </form>
    </div>
  );
}
