'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import SearchSelect from '@/components/SearchSelect';

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
  // Project information / commercial (U1) — discountPct shown as %, stored as a fraction.
  const [requestedShippingDate, setRequestedShippingDate] = useState('');
  const [siteAddress, setSiteAddress] = useState('');
  const [projectNotes, setProjectNotes] = useState('');
  const [discountPctInput, setDiscountPctInput] = useState('');
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
          requestedShippingDate: requestedShippingDate || undefined,
          siteAddress: siteAddress.trim() || undefined,
          projectNotes: projectNotes.trim() || undefined,
          discountPct: discountPctInput.trim() === '' ? undefined : Number(discountPctInput) / 100,
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
            <SearchSelect
              value={clientId}
              onChange={setClientId}
              allowEmpty
              placeholder="Select client…"
              options={clients.map((c) => ({ value: c.id, label: c.name ?? '' }))}
            />
          </div>
          <div className="field">
            <label>Location</label>
            <SearchSelect
              value={locationId}
              onChange={setLocationId}
              allowEmpty
              placeholder="Select location…"
              options={locations.map((l) => ({ value: l.id, label: l.name ?? '' }))}
            />
          </div>
        </div>
        <div className="field">
          <label>Currency</label>
          <SearchSelect
            value={currencyCode}
            onChange={setCurrencyCode}
            options={currencies.map((c) => ({ value: c.code ?? '', label: c.code ?? '' }))}
          />
        </div>
        <h4 style={{ margin: '4px 0' }}>Project information</h4>
        <div className="grid2">
          <div className="field">
            <label>Requested shipping date</label>
            <input type="date" value={requestedShippingDate} onChange={(e) => setRequestedShippingDate(e.target.value)} />
          </div>
          <div className="field">
            <label>Discount override (%)</label>
            <input type="number" min={0} max={99} step="0.5" value={discountPctInput} onChange={(e) => setDiscountPctInput(e.target.value)} placeholder="(default)" />
          </div>
        </div>
        <div className="field">
          <label>Site address</label>
          <input value={siteAddress} onChange={(e) => setSiteAddress(e.target.value)} placeholder="e.g. 12 Site St, Sydney" />
        </div>
        <div className="field">
          <label>Project notes</label>
          <textarea value={projectNotes} onChange={(e) => setProjectNotes(e.target.value)} rows={3} style={{ width: '100%', fontFamily: 'inherit', fontSize: 13, padding: 8, boxSizing: 'border-box' }} placeholder="Internal project notes…" />
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
