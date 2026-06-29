'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, ApiError, downloadFile, getRole } from '@/lib/api';
import SearchSelect from '@/components/SearchSelect';

interface Opt { id: string; name?: string; model?: string; sell?: string | null; category?: string; code?: string }
interface LedScreen { id: string; screenName: string | null; resolutionWpx: number | null; resolutionHpx: number | null; priceTotal: string | null }
interface LcdScreen { id: string; screenName: string | null; priceTotal: string | null }
interface Licence { id: string; screenType: string; tier: string; qty: number; isInteractive: boolean }
interface Quote {
  id: string; jobReference: string; status: string; lockVersion: number;
  clientId: string | null; locationId: string | null;
  totalEquipment: string; totalServices: string; totalRecurring: string; grandTotal: string;
  currency?: { code: string } | null;
  ledScreens: LedScreen[]; lcdScreens: LcdScreen[]; licences: Licence[];
  viewers?: Array<{ user: { id: string; name: string; email: string } }>;
}
interface Audit { id: string; action: string; fieldName: string | null; oldValue: string | null; newValue: string | null; changedAt: string; user?: { name: string } }

const STEPS = ['Details', 'LED screens', 'LCD screens', 'Licences', 'Review'] as const;

export default function QuoteWizard() {
  const { id } = useParams<{ id: string }>();
  const [quote, setQuote] = useState<Quote | null>(null);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setQuote(await api<Quote>(`/quotes/${id}`));
  }, [id]);

  useEffect(() => {
    refetch().catch((e) => setError(e.message));
  }, [refetch]);

  if (error) return <div className="error">{error}</div>;
  if (!quote) return <div className="muted">Loading…</div>;

  return (
    <div>
      <div className="topbar">
        <h1>
          {quote.jobReference} <span className="pill status-badge">{quote.status.replace('_', ' ')}</span>
        </h1>
        <span className="muted">
          {quote.currency?.code} {Number(quote.grandTotal).toLocaleString()}
        </span>
      </div>

      <div className="stepper">
        {STEPS.map((s, i) => (
          <div key={s} className={`step${i === step ? ' active' : ''}`} onClick={() => setStep(i)}>
            {i + 1}. {s}
          </div>
        ))}
      </div>

      {step === 0 && <DetailsStep quote={quote} onChange={refetch} />}
      {step === 1 && <LedStep quote={quote} onChange={refetch} />}
      {step === 2 && <LcdStep quote={quote} onChange={refetch} />}
      {step === 3 && <LicenceStep quote={quote} onChange={refetch} />}
      {step === 4 && <ReviewStep quote={quote} onChange={refetch} />}

      <div className="step-actions">
        <button disabled={step === 0} onClick={() => setStep(step - 1)}>
          ← Back
        </button>
        {step < STEPS.length - 1 && (
          <>
            <button className="ghost" onClick={() => setStep(step + 1)}>
              Skip
            </button>
            <button className="primary" onClick={() => setStep(step + 1)}>
              Next →
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function DetailsStep({ quote, onChange }: { quote: Quote; onChange: () => Promise<void> }) {
  const canWrite = getRole() !== 'viewer';
  const [jobReference, setJobReference] = useState(quote.jobReference);
  const [clientId, setClientId] = useState(quote.clientId ?? '');
  const [locationId, setLocationId] = useState(quote.locationId ?? '');
  const [currencyCode, setCurrencyCode] = useState(quote.currency?.code ?? 'AUD');
  const [selectedViewers, setSelectedViewers] = useState<Set<string>>(
    () => new Set((quote.viewers ?? []).map((v) => v.user.id)),
  );
  const [clients, setClients] = useState<Opt[]>([]);
  const [locations, setLocations] = useState<Opt[]>([]);
  const [currencies, setCurrencies] = useState<Opt[]>([]);
  const [viewers, setViewers] = useState<Array<{ id: string; name: string; email: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!canWrite) return;
    Promise.all([
      api<{ rows: Opt[] }>('/admin/clients?take=200'),
      api<{ rows: Opt[] }>('/admin/locations?take=200'),
      api<Opt[]>('/catalog/currencies'),
      api<Array<{ id: string; name: string; email: string }>>('/users/viewers'),
    ]).then(([c, l, cur, v]) => {
      setClients(c.rows);
      setLocations(l.rows);
      setCurrencies(cur);
      setViewers(v);
    });
  }, [canWrite]);

  const toggleViewer = (id: string) =>
    setSelectedViewers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const save = async () => {
    setBusy(true);
    setErr(null);
    setConflict(false);
    setSaved(false);
    try {
      await api(`/quotes/${quote.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          jobReference,
          currencyCode,
          clientId: clientId ? Number(clientId) : null,
          locationId: locationId ? Number(locationId) : null,
          viewerUserIds: [...selectedViewers].map(Number),
          // Optimistic concurrency: server rejects (409) if the quote moved since we loaded it.
          expectedVersion: quote.lockVersion,
        }),
      });
      await onChange();
      setSaved(true);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'conflict') setConflict(true);
      else setErr(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  if (!canWrite) {
    return (
      <div className="card">
        <p className="muted">Quote header (read-only).</p>
        <div className="grid3">
          <div><label>Job reference</label><input value={quote.jobReference} readOnly /></div>
          <div><label>Status</label><input value={quote.status} readOnly /></div>
          <div><label>Currency</label><input value={quote.currency?.code ?? ''} readOnly /></div>
        </div>
        <div style={{ marginTop: 12 }}>
          <label>Shared with viewers</label>
          <div>
            {quote.viewers && quote.viewers.length > 0
              ? quote.viewers.map((v) => <span key={v.user.id} className="pill" style={{ marginRight: 6 }}>{v.user.name}</span>)
              : <span className="muted">Not shared with any viewers.</span>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="topbar">
        <h3 style={{ margin: 0 }}>Quote details</h3>
        <span className="muted" title="Optimistic-locking token; bumped on every change">v{quote.lockVersion}</span>
      </div>
      <div className="grid3">
        <div><label>Job reference</label><input value={jobReference} onChange={(e) => setJobReference(e.target.value)} /></div>
        <div>
          <label>Client</label>
          <SearchSelect
            value={clientId}
            onChange={setClientId}
            allowEmpty
            placeholder="Select client…"
            options={clients.map((c) => ({ value: c.id, label: c.name ?? '' }))}
          />
        </div>
        <div>
          <label>Location</label>
          <SearchSelect
            value={locationId}
            onChange={setLocationId}
            allowEmpty
            placeholder="Select location…"
            options={locations.map((l) => ({ value: l.id, label: l.name ?? '' }))}
          />
        </div>
        <div>
          <label>Currency</label>
          <SearchSelect
            value={currencyCode}
            onChange={setCurrencyCode}
            options={currencies.map((c) => ({ value: c.code ?? '', label: c.code ?? '' }))}
          />
        </div>
        <div><label>Status</label><input value={quote.status} readOnly /></div>
      </div>

      {viewers.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <label>Share with viewers (read-only access)</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {viewers.map((v) => (
              <label key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text)', cursor: 'pointer' }}>
                <input type="checkbox" checked={selectedViewers.has(v.id)} onChange={() => toggleViewer(v.id)} style={{ width: 'auto' }} />
                {v.name}
              </label>
            ))}
          </div>
        </div>
      )}

      {conflict && (
        <div className="error" style={{ marginTop: 12 }}>
          This quote was changed elsewhere since you opened it. Your edits were not saved.{' '}
          <button className="ghost" onClick={() => onChange()}>Reload latest</button>
        </div>
      )}
      {err && <div className="error" style={{ marginTop: 12 }}>{err}</div>}
      {saved && <div className="muted" style={{ marginTop: 12 }}>✓ Saved.</div>}

      <div className="step-actions">
        <button className="primary" onClick={save} disabled={busy || !jobReference}>
          {busy ? 'Saving…' : 'Save details'}
        </button>
      </div>
    </div>
  );
}

interface ConfigOption {
  productId: string;
  model: string;
  rotated: boolean;
  widthMm: number;
  heightMm: number;
  cabinetCount: number;
  resolutionWpx: number;
  resolutionHpx: number;
  ratioLabel: string | null;
  fillPercent: string;
  cutCabinetSuggested: boolean;
}

function LedStep({ quote, onChange }: { quote: Quote; onChange: () => Promise<void> }) {
  const [products, setProducts] = useState<Opt[]>([]);
  const [productId, setProductId] = useState('');
  const [name, setName] = useState('');
  const [w, setW] = useState('1120');
  const [h, setH] = useState('1920');
  const [rotate, setRotate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [options, setOptions] = useState<ConfigOption[] | null>(null);
  const [reasons, setReasons] = useState<string[]>([]);

  useEffect(() => {
    api<{ rows: Opt[] }>('/admin/led-products?take=300').then((r) => setProducts(r.rows));
  }, []);

  const configure = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await api<{ options: ConfigOption[]; reasons: string[] }>(
        `/quotes/${quote.id}/screens/configure`,
        { method: 'POST', body: JSON.stringify({ desiredWidthMm: Number(w), desiredHeightMm: Number(h), allowRotation: rotate }) },
      );
      setOptions(res.options);
      setReasons(res.reasons);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const addScreen = async (chosenProductId?: string, rotated?: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/quotes/${quote.id}/led-screens`, {
        method: 'POST',
        body: JSON.stringify({
          screenName: name || undefined,
          ledProductId: Number(chosenProductId ?? productId),
          desiredWidthMm: Number(w),
          desiredHeightMm: Number(h),
          rotateCabinets: rotated ?? rotate,
        }),
      });
      setName('');
      setOptions(null);
      await onChange();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (sid: string) => {
    await api(`/quotes/${quote.id}/led-screens/${sid}`, { method: 'DELETE' });
    await onChange();
  };

  return (
    <div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Configure from opening</h3>
        <p className="muted">Enter the opening size; the engine ranks every LED product that fits.</p>
        <div className="grid3">
          <div><label>Screen name</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div><label>Width (mm)</label><input type="number" value={w} onChange={(e) => setW(e.target.value)} /></div>
          <div><label>Height (mm)</label><input type="number" value={h} onChange={(e) => setH(e.target.value)} /></div>
          <div>
            <label>Allow rotation</label>
            <input type="checkbox" checked={rotate} onChange={(e) => setRotate(e.target.checked)} style={{ width: 'auto' }} />
          </div>
        </div>
        {err && <div className="error">{err}</div>}
        <div className="step-actions">
          <button className="primary" onClick={configure} disabled={busy}>
            {busy ? 'Configuring…' : '🔍 Find best-fit products'}
          </button>
        </div>
      </div>

      {options && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Ranked configurations ({options.length})</h3>
          {options.length === 0 && <p className="muted">No fit: {reasons.join(' ')}</p>}
          {options.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Product</th><th>Size (mm)</th><th>Resolution</th><th>Ratio</th>
                    <th className="cell-num">Fill %</th><th className="cell-num">Cabinets</th><th>Cut?</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {options.slice(0, 25).map((o, i) => (
                    <tr key={`${o.productId}-${o.rotated}-${i}`}>
                      <td>{o.model}{o.rotated ? ' (rot)' : ''}</td>
                      <td>{o.widthMm}×{o.heightMm}</td>
                      <td>{o.resolutionWpx}×{o.resolutionHpx}</td>
                      <td>{o.ratioLabel ?? '—'}</td>
                      <td className="cell-num">{o.fillPercent}</td>
                      <td className="cell-num">{o.cabinetCount}</td>
                      <td>{o.cutCabinetSuggested ? '⚠️' : '—'}</td>
                      <td className="actions">
                        <button className="primary" onClick={() => addScreen(o.productId, o.rotated)} disabled={busy}>
                          Use
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>…or add a specific product</h3>
        <div className="grid3">
          <div>
            <label>Product</label>
            <SearchSelect
              value={productId}
              onChange={setProductId}
              allowEmpty
              placeholder="Search products…"
              options={products.map((p) => ({ value: p.id, label: p.model ?? '' }))}
            />
          </div>
        </div>
        <div className="step-actions">
          <button className="primary" onClick={() => addScreen()} disabled={busy || !productId}>
            {busy ? 'Pricing…' : '+ Add & price'}
          </button>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>LED screens ({quote.ledScreens.length})</h3>
        {quote.ledScreens.length === 0 && <p className="muted">None yet — this step is optional.</p>}
        {quote.ledScreens.map((s) => (
          <div className="list-row" key={s.id}>
            <div>
              <b>{s.screenName || 'LED screen'}</b>{' '}
              <span className="muted">
                {s.resolutionWpx && s.resolutionHpx ? `${s.resolutionWpx}×${s.resolutionHpx}px` : ''}
              </span>
            </div>
            <div className="row-actions">
              <span>{quote.currency?.code} {Number(s.priceTotal ?? 0).toLocaleString()}</span>
              <button className="danger" onClick={() => remove(s.id)}>Delete</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LcdStep({ quote, onChange }: { quote: Quote; onChange: () => Promise<void> }) {
  const [displays, setDisplays] = useState<Opt[]>([]);
  const [displayId, setDisplayId] = useState('');
  const [qty, setQty] = useState('1');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ rows: Opt[] }>('/admin/display-catalog?q=philips&take=100').then((r) => setDisplays(r.rows));
  }, []);

  const add = async () => {
    setBusy(true);
    const d = displays.find((x) => x.id === displayId);
    try {
      await api(`/quotes/${quote.id}/lcd-screens`, {
        method: 'POST',
        body: JSON.stringify({
          screenName: d?.model,
          displayId: displayId ? Number(displayId) : undefined,
          items: [{ itemType: 'display', displayId: Number(displayId), qty: Number(qty), unitSell: d?.sell ?? 0 }],
        }),
      });
      await onChange();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Add LCD display</h3>
        <div className="grid3">
          <div>
            <label>Display (Philips)</label>
            <SearchSelect
              value={displayId}
              onChange={setDisplayId}
              allowEmpty
              placeholder="Search displays…"
              options={displays.map((d) => ({ value: d.id, label: `${d.model}${d.sell ? ` ($${d.sell})` : ''}` }))}
            />
          </div>
          <div><label>Qty</label><input type="number" value={qty} onChange={(e) => setQty(e.target.value)} /></div>
        </div>
        <div className="step-actions">
          <button className="primary" onClick={add} disabled={busy || !displayId}>+ Add display</button>
        </div>
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>LCD screens ({quote.lcdScreens.length})</h3>
        {quote.lcdScreens.length === 0 && <p className="muted">None yet — optional.</p>}
        {quote.lcdScreens.map((s) => (
          <div className="list-row" key={s.id}>
            <b>{s.screenName || 'LCD'}</b>
            <span>{quote.currency?.code} {Number(s.priceTotal ?? 0).toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function LicenceStep({ quote, onChange }: { quote: Quote; onChange: () => Promise<void> }) {
  const [screenType, setScreenType] = useState('LED');
  const [tier, setTier] = useState('low');
  const [qty, setQty] = useState('1');
  const [interactive, setInteractive] = useState(false);
  const [busy, setBusy] = useState(false);

  const add = async () => {
    setBusy(true);
    try {
      await api(`/quotes/${quote.id}/licences`, {
        method: 'POST',
        body: JSON.stringify({ screenType, tier, qty: Number(qty), isInteractive: interactive }),
      });
      await onChange();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Add SeenCMP licence</h3>
        <div className="grid3">
          <div>
            <label>Screen type</label>
            <SearchSelect
              value={screenType}
              onChange={setScreenType}
              options={[{ value: 'LED', label: 'LED' }, { value: 'LCD', label: 'LCD' }]}
            />
          </div>
          <div>
            <label>Volume tier</label>
            <SearchSelect
              value={tier}
              onChange={setTier}
              options={[{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }]}
            />
          </div>
          <div><label>Qty (screens)</label><input type="number" value={qty} onChange={(e) => setQty(e.target.value)} /></div>
          <div>
            <label>Interactive</label>
            <input type="checkbox" checked={interactive} onChange={(e) => setInteractive(e.target.checked)} style={{ width: 'auto' }} />
          </div>
        </div>
        <div className="step-actions">
          <button className="primary" onClick={add} disabled={busy}>+ Add licence</button>
        </div>
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Licences ({quote.licences.length})</h3>
        {quote.licences.map((l) => (
          <div className="list-row" key={l.id}>
            <span>{l.screenType} · {l.tier} · {l.qty} screen(s){l.isInteractive ? ' · interactive' : ''}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

interface BomScreen {
  screenId: string;
  description: string;
  components: Array<{ type: string; name: string; qty: number; unitSell: string | null }>;
  costLines: Array<{ label: string; sell: string | null }>;
}

interface Version {
  revisionNo: number;
  label: string | null;
  grandTotal: string | null;
  restoredFrom: number | null;
  createdAt: string;
  createdBy?: { name: string };
}

function ReviewStep({ quote, onChange }: { quote: Quote; onChange: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [bom, setBom] = useState<BomScreen[] | null>(null);
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [statusError, setStatusError] = useState<string | null>(null);

  const loadAudit = useCallback(() => {
    api<Audit[]>(`/quotes/${quote.id}/audit`).then(setAudit);
  }, [quote.id]);
  const loadVersions = useCallback(() => {
    api<Version[]>(`/quotes/${quote.id}/versions`).then(setVersions);
  }, [quote.id]);

  useEffect(() => {
    loadAudit();
    loadVersions();
  }, [loadAudit, loadVersions]);

  const saveVersion = async () => {
    await api(`/quotes/${quote.id}/versions`, { method: 'POST', body: JSON.stringify({ label: `Saved ${new Date().toLocaleString()}` }) });
    loadVersions();
    loadAudit();
  };
  const rollback = async (rev: number) => {
    if (!window.confirm(`Roll back to version ${rev}? This creates a new version; history is preserved.`)) return;
    await api(`/quotes/${quote.id}/versions/${rev}/rollback`, { method: 'POST' });
    await onChange();
    loadVersions();
    loadAudit();
  };

  const recompute = async () => {
    setBusy(true);
    try {
      await api(`/quotes/${quote.id}/recompute`, { method: 'POST' });
      await onChange();
      loadAudit();
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (status: string) => {
    setStatusError(null);
    try {
      await api(`/quotes/${quote.id}/status`, { method: 'POST', body: JSON.stringify({ status }) });
      await onChange();
      loadAudit();
    } catch (e) {
      // Surfaces the margin-guardrail block, etc.
      setStatusError(e instanceof Error ? e.message : 'Status change failed');
    }
  };

  const cur = quote.currency?.code ?? '';
  return (
    <div>
      <div className="card">
        <div className="topbar">
          <h3 style={{ margin: 0 }}>Totals</h3>
          <button className="primary" onClick={recompute} disabled={busy}>
            {busy ? 'Recomputing…' : '↻ Recompute'}
          </button>
        </div>
        <div className="totals">
          <div className="stat"><div className="label">Equipment</div><div className="value">{cur} {Number(quote.totalEquipment).toLocaleString()}</div></div>
          <div className="stat"><div className="label">Services</div><div className="value">{cur} {Number(quote.totalServices).toLocaleString()}</div></div>
          <div className="stat"><div className="label">Recurring / yr</div><div className="value">{cur} {Number(quote.totalRecurring).toLocaleString()}</div></div>
          <div className="stat"><div className="label">Grand total</div><div className="value">{cur} {Number(quote.grandTotal).toLocaleString()}</div></div>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Documents</h3>
        <div className="row-actions">
          <button onClick={() => downloadFile(`/quotes/${quote.id}/export.pdf`, `quote-${quote.jobReference}.pdf`)}>
            ⬇ Proposal PDF
          </button>
          <button onClick={() => api<BomScreen[]>(`/quotes/${quote.id}/bom`).then(setBom)}>📦 BOM / PI</button>
          <button onClick={() => api<Record<string, unknown>>(`/quotes/${quote.id}/solution-summary`).then(setSummary)}>
            📋 Solution summary
          </button>
          <button onClick={() => downloadFile(`/quotes/${quote.id}/pm-handoff`, `pm-handoff-${quote.jobReference}.json`)}>
            ⬇ PM handoff
          </button>
        </div>
        {bom && (
          <div style={{ marginTop: 14 }}>
            {bom.map((s) => (
              <div key={s.screenId} style={{ marginBottom: 12 }}>
                <b>{s.description}</b>
                <div className="table-wrap" style={{ marginTop: 6 }}>
                  <table>
                    <thead><tr><th>Component</th><th>Type</th><th className="cell-num">Qty</th></tr></thead>
                    <tbody>
                      {s.components.map((c, i) => (
                        <tr key={i}><td>{c.name}</td><td className="muted">{c.type}</td><td className="cell-num">{c.qty}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )}
        {summary && (
          <pre style={{ marginTop: 14, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, overflowX: 'auto', fontSize: 12 }}>
            {JSON.stringify(summary, null, 2)}
          </pre>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Workflow</h3>
        <div className="row-actions">
          <button onClick={() => setStatus('in_review')}>Send to review</button>
          <button onClick={() => setStatus('approved')}>Approve</button>
          <button onClick={() => setStatus('issued')}>Issue</button>
        </div>
        {statusError && <div className="error" style={{ marginTop: 10 }}>{statusError}</div>}
      </div>

      <div className="card">
        <div className="topbar">
          <h3 style={{ margin: 0 }}>Versions</h3>
          <button className="primary" onClick={saveVersion}>＋ Save version</button>
        </div>
        {versions.length === 0 && <p className="muted">No saved versions yet.</p>}
        {versions.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>#</th><th>Label</th><th className="cell-num">Grand total</th><th>By</th><th></th></tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.revisionNo}>
                    <td>v{v.revisionNo}{v.restoredFrom ? ` (↺ from v${v.restoredFrom})` : ''}</td>
                    <td>{v.label ?? '—'}</td>
                    <td className="cell-num">{cur} {Number(v.grandTotal ?? 0).toLocaleString()}</td>
                    <td className="muted">{v.createdBy?.name ?? '—'}</td>
                    <td className="actions"><button className="ghost" onClick={() => rollback(v.revisionNo)}>Roll back</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Change history</h3>
        {audit.length === 0 && <p className="muted">No history yet.</p>}
        {audit.slice(0, 30).map((a) => (
          <div className="audit-line" key={a.id}>
            <b>{a.action}</b> {a.fieldName ? `· ${a.fieldName}: ${a.oldValue ?? '∅'} → ${a.newValue ?? '∅'}` : ''}{' '}
            <span>· {a.user?.name ?? 'system'} · {new Date(a.changedAt).toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
