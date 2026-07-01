'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, getRole } from '@/lib/api';
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
  // A+ discount guardrail: note required above 5%; hard cap 12% (admin-overridable).
  const [discountNote, setDiscountNote] = useState('');
  const isAdmin = getRole() === 'admin';
  // Cap + note threshold (as %) are maintained by admins in the DB settings; the quote page reads them
  // so the estimator's input is hard-limited to the current cap (see the /quotes/discount-policy fetch).
  const [capPct, setCapPct] = useState(12);
  const [noteThreshold, setNoteThreshold] = useState(5);
  const discPctNum = discountPctInput.trim() === '' ? null : Number(discountPctInput);
  const needsNote = discPctNum != null && discPctNum > noteThreshold && !discountNote.trim();
  const capBlocked = discPctNum != null && discPctNum > capPct && !isAdmin;
  const discountBlocked = needsNote || capBlocked;
  // Non-admins can't type above the cap; admins may exceed it (audited on save).
  const onDiscountChange = (raw: string) => {
    if (!isAdmin && raw.trim() !== '' && Number(raw) > capPct) { setDiscountPctInput(String(capPct)); return; }
    setDiscountPctInput(raw);
  };
  // U5 — where the discount applies: one-off upfront concession (default) vs every renewal.
  const [discountScope, setDiscountScope] = useState<'one_off' | 'recurring'>('one_off');
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
      api<{ capPct: number; noteThresholdPct: number }>('/quotes/discount-policy'),
    ])
      .then(([c, l, cur, v, policy]) => {
        setClients(c.rows);
        setLocations(l.rows);
        setCurrencies(cur);
        setViewers(v);
        setCapPct(Math.round(policy.capPct * 1000) / 10);
        setNoteThreshold(Math.round(policy.noteThresholdPct * 1000) / 10);
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
          discountNote: discountNote.trim() || undefined,
          discountScope,
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
            <input type="number" min={0} max={isAdmin ? 99 : capPct} step="0.5" value={discountPctInput} onChange={(e) => onDiscountChange(e.target.value)} placeholder="(default)" />
            <p className="muted" style={{ margin: '4px 0 0', fontSize: 12, color: capBlocked ? 'var(--danger, #dc2626)' : undefined }}>
              {capBlocked
                ? `Exceeds the ${capPct}% cap — admin approval required.`
                : isAdmin
                  ? `Cap ${capPct}% (you can override). Above ${noteThreshold}% requires a manager note.`
                  : `Capped at ${capPct}%. Above ${noteThreshold}% requires a manager note.`}
            </p>
          </div>
        </div>
        {discPctNum != null && discPctNum > noteThreshold && (
          <div className="field">
            <label>Manager note (required for discounts above {noteThreshold}%){needsNote && <span style={{ color: 'var(--danger, #dc2626)' }}> *</span>}</label>
            <textarea value={discountNote} onChange={(e) => setDiscountNote(e.target.value)} rows={2} style={{ width: '100%', fontFamily: 'inherit', fontSize: 13, padding: 8, boxSizing: 'border-box', borderColor: needsNote ? 'var(--danger, #dc2626)' : undefined }} placeholder="Justification for the discount…" />
          </div>
        )}
        <div className="field">
          <label>Discount applies to</label>
          <select value={discountScope} onChange={(e) => setDiscountScope(e.target.value as 'one_off' | 'recurring')}>
            <option value="one_off">One-off (upfront equipment + services)</option>
            <option value="recurring">Every renewal (recurring total)</option>
          </select>
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
          <button className="primary" type="submit" disabled={busy || !jobReference || discountBlocked}>
            {busy ? 'Creating…' : 'Create & continue'}
          </button>
          <button type="button" className="ghost" onClick={() => router.push('/quotes')} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
