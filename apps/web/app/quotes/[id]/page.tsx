'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, ApiError, downloadFile, getRole } from '@/lib/api';
import SearchSelect from '@/components/SearchSelect';

interface Opt { id: string; name?: string; model?: string; sell?: string | null; category?: string; code?: string }
interface LedScreen { id: string; screenName: string | null; qty: number; resolutionWpx: number | null; resolutionHpx: number | null; priceTotal: string | null }
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

// The optional LED option/service lookups: each is its own admin CRUD table, served by
// GET /admin/<slug>?take=200 → { rows }, all using `name` as the human title field.
const LED_OPTION_TABLES = [
  { key: 'frameId', slug: 'frames', label: 'Frame' },
  { key: 'trimId', slug: 'trim-options', label: 'Trim' },
  { key: 'hangingBarId', slug: 'hanging-bars', label: 'Hanging bar' },
  { key: 'engineeringId', slug: 'engineering-options', label: 'Engineering' },
  { key: 'installMethodId', slug: 'install-methods', label: 'Install method' },
  { key: 'freightOptionId', slug: 'freight-options', label: 'Freight option' },
  { key: 'warrantyId', slug: 'warranties', label: 'Warranty' },
  { key: 'serviceHoursId', slug: 'service-hours', label: 'Service hours' },
  { key: 'accessEquipmentId', slug: 'access-equipment', label: 'Access equipment' },
  { key: 'gobId', slug: 'gob-options', label: 'GOB' },
] as const;
type LedOptionKey = (typeof LED_OPTION_TABLES)[number]['key'];

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
  // Optional options/services: catalog rows per table + the chosen id per field.
  const [optionRows, setOptionRows] = useState<Record<LedOptionKey, Opt[]>>(
    () => Object.fromEntries(LED_OPTION_TABLES.map((t) => [t.key, [] as Opt[]])) as unknown as Record<LedOptionKey, Opt[]>,
  );
  const [selectedOptions, setSelectedOptions] = useState<Record<LedOptionKey, string>>(
    () => Object.fromEntries(LED_OPTION_TABLES.map((t) => [t.key, ''])) as unknown as Record<LedOptionKey, string>,
  );

  useEffect(() => {
    api<{ rows: Opt[] }>('/admin/led-products?take=300').then((r) => setProducts(r.rows));
    Promise.all(
      LED_OPTION_TABLES.map((t) =>
        api<{ rows: Opt[] }>(`/admin/${t.slug}?take=200`)
          .then((r) => [t.key, r.rows] as const)
          .catch(() => [t.key, [] as Opt[]] as const),
      ),
    ).then((entries) => {
      setOptionRows(Object.fromEntries(entries) as unknown as Record<LedOptionKey, Opt[]>);
    });
  }, []);

  // Only the option ids that are actually set, ready to merge into a POST body.
  const selectedOptionIds = (): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const t of LED_OPTION_TABLES) {
      const v = selectedOptions[t.key];
      if (v) out[t.key] = Number(v);
    }
    return out;
  };

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
          // Chosen options/services (only the ids that are set are sent).
          ...selectedOptionIds(),
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

  const setQty = async (sid: string, qty: number) => {
    if (!(qty >= 1)) return;
    await api(`/quotes/${quote.id}/led-screens/${sid}/qty`, { method: 'PATCH', body: JSON.stringify({ qty }) });
    await onChange();
  };

  const duplicate = async (sid: string) => {
    await api(`/quotes/${quote.id}/led-screens/${sid}/duplicate`, { method: 'POST', body: JSON.stringify({}) });
    await onChange();
  };

  const move = async (index: number, dir: -1 | 1) => {
    const ids = quote.ledScreens.map((s) => Number(s.id));
    const target = index + dir;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    await api(`/quotes/${quote.id}/led-screens/reorder`, { method: 'POST', body: JSON.stringify({ orderedIds: ids }) });
    await onChange();
  };

  // Required-field gating (P1-12.3): the essentials before "+ Add & price".
  const missing: string[] = [];
  if (!productId) missing.push('LED product');
  if (!(Number(w) > 0)) missing.push('width');
  if (!(Number(h) > 0)) missing.push('height');
  const canAddSpecific = missing.length === 0;

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
        <p className="muted">Width, height and rotation come from “Configure from opening” above; pick the product and any options below.</p>
        <div className="grid3">
          <div>
            <label style={!productId ? { color: 'var(--danger, #dc2626)' } : undefined}>Product *</label>
            <SearchSelect
              value={productId}
              onChange={setProductId}
              allowEmpty
              placeholder="Search products…"
              options={products.map((p) => ({ value: p.id, label: p.model ?? '' }))}
            />
          </div>
          <div>
            <label style={Number(w) > 0 ? undefined : { color: 'var(--danger, #dc2626)' }}>Width (mm) *</label>
            <input type="number" value={w} onChange={(e) => setW(e.target.value)} />
          </div>
          <div>
            <label style={Number(h) > 0 ? undefined : { color: 'var(--danger, #dc2626)' }}>Height (mm) *</label>
            <input type="number" value={h} onChange={(e) => setH(e.target.value)} />
          </div>
        </div>

        <h4 style={{ margin: '16px 0 4px' }}>Options &amp; services</h4>
        <p className="muted" style={{ marginTop: 0 }}>All optional — selections are priced and persisted with the screen.</p>
        <div className="grid3">
          {LED_OPTION_TABLES.map((t) => (
            <div key={t.key}>
              <label>{t.label}</label>
              <SearchSelect
                value={selectedOptions[t.key]}
                onChange={(v) => setSelectedOptions((prev) => ({ ...prev, [t.key]: v }))}
                allowEmpty
                placeholder={`Select ${t.label.toLowerCase()}…`}
                options={(optionRows[t.key] ?? []).map((o) => ({ value: o.id, label: o.name ?? o.model ?? '' }))}
              />
            </div>
          ))}
        </div>

        {!canAddSpecific && (
          <p className="muted" style={{ marginTop: 12 }}>
            ⚠️ Required before pricing: {missing.join(', ')}.
          </p>
        )}
        <div className="step-actions">
          <button className="primary" onClick={() => addScreen()} disabled={busy || !canAddSpecific}>
            {busy ? 'Pricing…' : '+ Add & price'}
          </button>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>LED screens ({quote.ledScreens.length})</h3>
        {quote.ledScreens.length === 0 && <p className="muted">None yet — this step is optional.</p>}
        {quote.ledScreens.map((s, i) => (
          <div className="list-row" key={s.id}>
            <div>
              <b>{s.screenName || 'LED screen'}</b>{' '}
              <span className="muted">
                {s.resolutionWpx && s.resolutionHpx ? `${s.resolutionWpx}×${s.resolutionHpx}px` : ''}
              </span>
            </div>
            <div className="row-actions">
              <button className="ghost" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>▲</button>
              <button className="ghost" title="Move down" disabled={i === quote.ledScreens.length - 1} onClick={() => move(i, 1)}>▼</button>
              <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 4, margin: 0 }}>
                Qty
                <input
                  type="number"
                  min={1}
                  defaultValue={s.qty}
                  style={{ width: 60 }}
                  onBlur={(e) => { const v = Number(e.target.value); if (v !== s.qty) setQty(s.id, v); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                />
              </label>
              <span>{quote.currency?.code} {(Number(s.priceTotal ?? 0) * s.qty).toLocaleString()}</span>
              <button className="ghost" onClick={() => duplicate(s.id)}>Duplicate</button>
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

// One field-level difference between two version snapshots. `from`/`to` is null when the
// path exists in only one snapshot (a field/screen added or removed structurally).
interface DiffEntry { path: string; from: unknown | null; to: unknown | null }

interface ValidationFinding { rule: string; severity: 'error' | 'warning' | 'cannot_evaluate'; message: string }
interface QuoteValidation {
  canFinalise: boolean;
  counts: { error: number; warning: number; cannotEvaluate: number };
  screens: Array<{ screenId: string; screenName: string; findings: ValidationFinding[] }>;
}

interface PriceLine { label: string; category: string | null; qty: number; cost: string | null; sell: string | null }
interface PriceSection { type: 'led' | 'lcd' | 'licence'; name: string; lines: PriceLine[]; total: string }
interface PriceResult {
  costVisible: boolean;
  sections: PriceSection[];
  licences: Array<{ screenType: string; tier: string; qty: number; isInteractive: boolean; annual: string }>;
  totals: {
    equipment: string; services: string; recurring: string; grandTotal: string;
    margin: string | null; marginFloor: number | null;
  };
}

function ReviewStep({ quote, onChange }: { quote: Quote; onChange: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [bom, setBom] = useState<BomScreen[] | null>(null);
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  // Version diff (P1-04.2/.4): A = from, B = to.
  const [diffA, setDiffA] = useState<number | null>(null);
  const [diffB, setDiffB] = useState<number | null>(null);
  const [diff, setDiff] = useState<DiffEntry[] | null>(null);
  const [diffPair, setDiffPair] = useState<{ a: number; b: number } | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [validation, setValidation] = useState<QuoteValidation | null>(null);
  const [price, setPrice] = useState<PriceResult | null>(null);
  const [pricing, setPricing] = useState(false);
  const [priceError, setPriceError] = useState<string | null>(null);
  const role = getRole();
  const isAdmin = role === 'admin';
  const canPrice = role === 'admin' || role === 'sales';
  const canWrite = role !== 'viewer';

  // Editable proposal text (P1-18.2): three textareas, one line per item, pre-filled from the API.
  const [assumptionsText, setAssumptionsText] = useState('');
  const [exclusionsText, setExclusionsText] = useState('');
  const [termsText, setTermsText] = useState('');
  const [termsSaving, setTermsSaving] = useState(false);
  const [termsSaved, setTermsSaved] = useState(false);
  const [termsError, setTermsError] = useState<string | null>(null);

  const loadTerms = useCallback(() => {
    api<Array<{ kind: 'assumption' | 'exclusion' | 'term'; text: string }>>(`/quotes/${quote.id}/terms`)
      .then((rows) => {
        const byKind = (k: string) => rows.filter((r) => r.kind === k).map((r) => r.text).join('\n');
        setAssumptionsText(byKind('assumption'));
        setExclusionsText(byKind('exclusion'));
        setTermsText(byKind('term'));
      })
      .catch(() => setTermsError('Could not load proposal text'));
  }, [quote.id]);

  const saveTerms = async () => {
    setTermsSaving(true);
    setTermsError(null);
    setTermsSaved(false);
    const split = (s: string) => s.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    const terms = [
      ...split(assumptionsText).map((text) => ({ kind: 'assumption' as const, text })),
      ...split(exclusionsText).map((text) => ({ kind: 'exclusion' as const, text })),
      ...split(termsText).map((text) => ({ kind: 'term' as const, text })),
    ];
    try {
      await api(`/quotes/${quote.id}/terms`, { method: 'PUT', body: JSON.stringify({ terms }) });
      setTermsSaved(true);
      loadAudit();
    } catch (e) {
      setTermsError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setTermsSaving(false);
    }
  };

  const loadPrice = async () => {
    setPricing(true);
    setPriceError(null);
    try {
      setPrice(await api<PriceResult>(`/quotes/${quote.id}/price`, { method: 'POST' }));
    } catch (e) {
      setPriceError(e instanceof Error ? e.message : 'Pricing failed');
    } finally {
      setPricing(false);
    }
  };

  const loadAudit = useCallback(() => {
    api<Audit[]>(`/quotes/${quote.id}/audit`).then(setAudit);
  }, [quote.id]);
  const loadVersions = useCallback(() => {
    api<Version[]>(`/quotes/${quote.id}/versions`).then((vs) => {
      setVersions(vs);
      // Default the comparison to (previous → latest) when ≥2 versions exist, only if
      // the user hasn't picked a pair yet.
      setDiffA((cur) => {
        if (cur != null || vs.length < 2) return cur;
        const nums = vs.map((v) => v.revisionNo).sort((x, y) => x - y);
        return nums[nums.length - 2] ?? null;
      });
      setDiffB((cur) => {
        if (cur != null || vs.length < 2) return cur;
        const nums = vs.map((v) => v.revisionNo).sort((x, y) => x - y);
        return nums[nums.length - 1] ?? null;
      });
    });
  }, [quote.id]);
  const loadValidation = useCallback(() => {
    api<QuoteValidation>(`/quotes/${quote.id}/validate`).then(setValidation).catch(() => setValidation(null));
  }, [quote.id]);

  useEffect(() => {
    loadAudit();
    loadVersions();
    loadValidation();
    loadTerms();
  }, [loadAudit, loadVersions, loadValidation, loadTerms]);

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

  const compareVersions = async () => {
    if (diffA == null || diffB == null || diffA === diffB) return;
    setDiffBusy(true);
    setDiffError(null);
    setDiff(null);
    try {
      const rows = await api<DiffEntry[]>(`/quotes/${quote.id}/versions/diff?a=${diffA}&b=${diffB}`);
      setDiff(rows);
      setDiffPair({ a: diffA, b: diffB });
    } catch (e) {
      setDiffError(e instanceof Error ? e.message : 'Compare failed');
    } finally {
      setDiffBusy(false);
    }
  };

  const recompute = async () => {
    setBusy(true);
    try {
      await api(`/quotes/${quote.id}/recompute`, { method: 'POST' });
      await onChange();
      loadAudit();
      loadValidation();
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
      loadValidation();
    } catch (e) {
      // Surfaces the margin-guardrail block, etc.
      setStatusError(e instanceof Error ? e.message : 'Status change failed');
    }
  };

  const cur = quote.currency?.code ?? '';

  // Compact, readable string for a snapshot value; null/undefined → "—" (rendered muted).
  const fmtVal = (v: unknown): string => {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  };
  const vlabel = (v: Version) => `v${v.revisionNo} — ${v.label ?? new Date(v.createdAt).toLocaleString()}`;
  const versionOpts = versions.map((v) => ({ value: String(v.revisionNo), label: vlabel(v) }));
  const canCompare = versions.length >= 2 && diffA != null && diffB != null && diffA !== diffB;

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
        <div className="topbar">
          <h3 style={{ margin: 0 }}>Itemised price</h3>
          <button
            className="primary"
            onClick={loadPrice}
            disabled={!canPrice || pricing}
            title={canPrice ? undefined : 'Viewers cannot price a quote'}
          >
            {pricing ? 'Pricing…' : '＄ Itemise price'}
          </button>
        </div>
        {!canPrice && (
          <p className="muted" style={{ marginTop: 8 }}>Read-only role — pricing is unavailable.</p>
        )}
        {priceError && <div className="error" style={{ marginTop: 10 }}>{priceError}</div>}
        {price && (
          <div style={{ marginTop: 14 }}>
            {!price.costVisible && (
              <p className="muted" style={{ marginTop: 0 }}>Cost hidden for your role.</p>
            )}
            {price.sections.length === 0 && <p className="muted">No priced lines yet.</p>}
            {price.sections.map((sec, si) => (
              <div key={si} style={{ marginBottom: 14 }}>
                <div className="topbar">
                  <b>{sec.name} <span className="muted">· {sec.type.toUpperCase()}</span></b>
                  <span>{cur} {Number(sec.total).toLocaleString()}</span>
                </div>
                <div className="table-wrap" style={{ marginTop: 6 }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Label</th><th>Category</th><th className="cell-num">Qty</th>
                        {price.costVisible && <th className="cell-num">Cost</th>}
                        <th className="cell-num">Sell</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sec.lines.map((l, li) => (
                        <tr key={li}>
                          <td>{l.label}</td>
                          <td className="muted">{l.category ?? '—'}</td>
                          <td className="cell-num">{l.qty}</td>
                          {price.costVisible && (
                            <td className="cell-num">{cur} {Number(l.cost ?? 0).toLocaleString()}</td>
                          )}
                          <td className="cell-num">{cur} {Number(l.sell ?? 0).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
            {price.licences.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <b>Licences</b>
                <div className="table-wrap" style={{ marginTop: 6 }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Screen type</th><th>Tier</th><th className="cell-num">Qty</th>
                        <th>Interactive</th><th className="cell-num">Annual</th>
                      </tr>
                    </thead>
                    <tbody>
                      {price.licences.map((l, li) => (
                        <tr key={li}>
                          <td>{l.screenType}</td>
                          <td className="muted">{l.tier}</td>
                          <td className="cell-num">{l.qty}</td>
                          <td>{l.isInteractive ? 'Yes' : 'No'}</td>
                          <td className="cell-num">{cur} {Number(l.annual).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            <div className="totals">
              <div className="stat"><div className="label">Equipment</div><div className="value">{cur} {Number(price.totals.equipment).toLocaleString()}</div></div>
              <div className="stat"><div className="label">Services</div><div className="value">{cur} {Number(price.totals.services).toLocaleString()}</div></div>
              <div className="stat"><div className="label">Recurring / yr</div><div className="value">{cur} {Number(price.totals.recurring).toLocaleString()}</div></div>
              <div className="stat"><div className="label">Grand total</div><div className="value">{cur} {Number(price.totals.grandTotal).toLocaleString()}</div></div>
              {price.totals.margin != null && (() => {
                const margin = Number(price.totals.margin);
                const floor = price.totals.marginFloor;
                const below = floor != null && margin < floor;
                return (
                  <>
                    <div className="stat">
                      <div className="label">Margin</div>
                      <div className="value" style={below ? { color: 'var(--danger, #dc2626)' } : undefined}>
                        {(margin * 100).toFixed(1)}%{below ? ' ⛔' : ''}
                      </div>
                    </div>
                    {floor != null && (
                      <div className="stat"><div className="label">Margin floor</div><div className="value">{(floor * 100).toFixed(1)}%</div></div>
                    )}
                  </>
                );
              })()}
            </div>
          </div>
        )}
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
        <h3 style={{ marginTop: 0 }}>Proposal text</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          One item per line. This text flows into the proposal PDF and is captured in version
          snapshots. Empty groups fall back to the standard defaults in the PDF.
        </p>
        {([
          ['Assumptions', assumptionsText, setAssumptionsText] as const,
          ['Exclusions', exclusionsText, setExclusionsText] as const,
          ['Terms & conditions', termsText, setTermsText] as const,
        ]).map(([label, value, setter]) => (
          <div key={label} style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>{label}</label>
            <textarea
              value={value}
              onChange={(e) => {
                setter(e.target.value);
                setTermsSaved(false);
              }}
              disabled={!canWrite}
              rows={5}
              style={{ width: '100%', fontFamily: 'inherit', fontSize: 13, padding: 8, boxSizing: 'border-box' }}
              placeholder={canWrite ? 'One item per line…' : undefined}
            />
          </div>
        ))}
        {canWrite && (
          <div className="row-actions" style={{ alignItems: 'center' }}>
            <button className="primary" onClick={saveTerms} disabled={termsSaving}>
              {termsSaving ? 'Saving…' : 'Save proposal text'}
            </button>
            {termsSaved && <span style={{ color: 'var(--ok, #16a34a)' }}>✓ Saved</span>}
            {termsError && <span style={{ color: 'var(--danger, #dc2626)' }}>{termsError}</span>}
          </div>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Validation</h3>
        {!validation && <p className="muted">Checking…</p>}
        {validation && validation.screens.length === 0 && (
          <p className="muted">No LED screens to validate.</p>
        )}
        {validation && validation.screens.length > 0 && (
          <>
            <p className="muted" style={{ marginTop: 0 }}>
              {validation.counts.error} error(s) · {validation.counts.warning} warning(s) ·{' '}
              {validation.counts.cannotEvaluate} not yet evaluable
            </p>
            {validation.counts.error + validation.counts.warning + validation.counts.cannotEvaluate === 0 && (
              <p style={{ color: 'var(--ok, #16a34a)' }}>✓ No conflicts found — ready to finalise.</p>
            )}
            {validation.screens.map((s) =>
              s.findings.length === 0 ? null : (
                <div key={s.screenId} style={{ marginBottom: 10 }}>
                  <b>{s.screenName}</b>
                  {s.findings.map((f, i) => (
                    <div
                      key={i}
                      style={{
                        marginTop: 4,
                        fontSize: 13,
                        color:
                          f.severity === 'error'
                            ? 'var(--danger, #dc2626)'
                            : f.severity === 'warning'
                            ? 'var(--warn, #d97706)'
                            : 'var(--muted, #6b7280)',
                      }}
                    >
                      {f.severity === 'error' ? '⛔' : f.severity === 'warning' ? '⚠️' : 'ℹ️'}{' '}
                      <span className="muted">[{f.rule}]</span> {f.message}
                    </div>
                  ))}
                </div>
              ),
            )}
          </>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Workflow</h3>
        <div className="row-actions">
          <button onClick={() => setStatus('in_review')}>Send to review</button>
          <button
            onClick={() => setStatus('approved')}
            disabled={!isAdmin && validation != null && !validation.canFinalise}
            title={!isAdmin && validation != null && !validation.canFinalise ? 'Resolve validation errors first' : undefined}
          >
            Approve
          </button>
          <button
            onClick={() => setStatus('issued')}
            disabled={!isAdmin && validation != null && !validation.canFinalise}
            title={!isAdmin && validation != null && !validation.canFinalise ? 'Resolve validation errors first' : undefined}
          >
            Issue
          </button>
        </div>
        {validation != null && !validation.canFinalise && (
          <div className="muted" style={{ marginTop: 8, fontSize: 13 }}>
            {isAdmin
              ? `${validation.counts.error} validation error(s) present — you may override as admin (the override is audited).`
              : `Finalisation is blocked: ${validation.counts.error} validation error(s) must be resolved.`}
          </div>
        )}
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
        <h3 style={{ marginTop: 0 }}>Compare versions</h3>
        {versions.length < 2 && (
          <p className="muted">Save at least two versions to compare them.</p>
        )}
        {versions.length >= 2 && (
          <>
            <div className="grid3" style={{ alignItems: 'end' }}>
              <div>
                <label>Version A (from)</label>
                <SearchSelect
                  value={diffA == null ? '' : String(diffA)}
                  onChange={(v) => setDiffA(v ? Number(v) : null)}
                  placeholder="Select version…"
                  options={versionOpts}
                />
              </div>
              <div>
                <label>Version B (to)</label>
                <SearchSelect
                  value={diffB == null ? '' : String(diffB)}
                  onChange={(v) => setDiffB(v ? Number(v) : null)}
                  placeholder="Select version…"
                  options={versionOpts}
                />
              </div>
              <div>
                <button className="primary" onClick={compareVersions} disabled={!canCompare || diffBusy}>
                  {diffBusy ? 'Comparing…' : 'Compare'}
                </button>
              </div>
            </div>
            {diffA != null && diffB != null && diffA === diffB && (
              <p className="muted" style={{ marginTop: 8 }}>Pick two different versions to compare.</p>
            )}
            {diffError && <div className="error" style={{ marginTop: 10 }}>{diffError}</div>}
            {diff && diffPair && (
              <div style={{ marginTop: 14 }}>
                <p className="muted" style={{ marginTop: 0 }}>
                  {diff.length === 0
                    ? `No differences between v${diffPair.a} and v${diffPair.b}.`
                    : `${diff.length} difference${diff.length === 1 ? '' : 's'} between v${diffPair.a} and v${diffPair.b}.`}
                </p>
                {diff.length > 0 && (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Field (path)</th>
                          <th>From (v{diffPair.a})</th>
                          <th>To (v{diffPair.b})</th>
                        </tr>
                      </thead>
                      <tbody>
                        {diff.map((d, i) => {
                          const added = (d.from === null || d.from === undefined) && !(d.to === null || d.to === undefined);
                          const removed = !(d.from === null || d.from === undefined) && (d.to === null || d.to === undefined);
                          // Subtle row tint: added = green, removed = red, changed = default.
                          const bg = added
                            ? 'color-mix(in srgb, var(--ok, #16a34a) 12%, transparent)'
                            : removed
                            ? 'color-mix(in srgb, var(--danger, #dc2626) 12%, transparent)'
                            : undefined;
                          return (
                            <tr key={`${d.path}-${i}`} style={bg ? { background: bg } : undefined}>
                              <td><code style={{ fontSize: 12 }}>{d.path}</code></td>
                              <td className={d.from === null || d.from === undefined ? 'muted' : undefined}>{fmtVal(d.from)}</td>
                              <td className={d.to === null || d.to === undefined ? 'muted' : undefined}>{fmtVal(d.to)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </>
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
