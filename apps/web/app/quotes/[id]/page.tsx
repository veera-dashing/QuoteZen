'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, ApiError, downloadFile, getRole, uploadFile } from '@/lib/api';
import SearchSelect from '@/components/SearchSelect';

interface Opt { id: string; name?: string; model?: string; sell?: string | null; totalCost?: string | null; usd?: string | null; category?: string; code?: string }
interface LedScreen {
  id: string; screenName: string | null; qty: number;
  resolutionWpx: number | null; resolutionHpx: number | null; priceTotal: string | null;
  orientation?: string | null;
  aspectRatio?: { ratioLabel: string } | null;
  // Secondary options/services (Form 2) — raw FK scalars + housing/notes, used to pre-fill the editor.
  gobId?: string | null; frameId?: string | null; trimId?: string | null; hangingBarId?: string | null;
  engineeringId?: string | null; installMethodId?: string | null; freightOptionId?: string | null;
  warrantyId?: string | null; serviceHoursId?: string | null; accessEquipmentId?: string | null;
  backCover?: boolean; frameNote?: string | null; serviceDescriptionSuffix?: string | null;
}
interface LcdScreen { id: string; screenName: string | null; priceTotal: string | null }
interface Licence { id: string; screenType: string; tier: string; qty: number; isInteractive: boolean }
interface Quote {
  id: string; jobReference: string; status: string; lockVersion: number;
  clientId: string | null; locationId: string | null;
  // Quote-level PI / commercial fields (U1).
  requestedShippingDate?: string | null; siteAddress?: string | null; projectNotes?: string | null;
  discountPct?: string | null; // stored as a fraction 0..1
  discountScope?: 'one_off' | 'recurring' | null; // U5 — upfront vs every renewal
  totalEquipment: string; totalServices: string; totalRecurring: string; grandTotal: string;
  currency?: { code: string } | null;
  ledScreens: LedScreen[]; lcdScreens: LcdScreen[]; licences: Licence[];
  viewers?: Array<{ user: { id: string; name: string; email: string } }>;
}
interface Risk { category: 'technical' | 'commercial' | 'delivery'; description: string; severity: 'low' | 'medium' | 'high'; mitigation: string | null; seq?: number }
interface Audit { id: string; action: string; fieldName: string | null; oldValue: string | null; newValue: string | null; changedAt: string; user?: { name: string } }
interface QuoteDoc { id: string; originalName: string; mimeType: string; sizeBytes: number; version: number; uploadedBy: { id: string; name: string } | null; createdAt: string }

const STEPS = ['Details', 'Select Screens', 'Licences', 'Review'] as const;

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
      {step === 1 && <SelectScreensStep quote={quote} onChange={refetch} />}
      {step === 2 && <LicenceStep quote={quote} onChange={refetch} />}
      {step === 3 && <ReviewStep quote={quote} onChange={refetch} />}

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
  // Project information / commercial (U1). discountPct is stored as a fraction (0..1) but shown as %.
  const [requestedShippingDate, setRequestedShippingDate] = useState(
    quote.requestedShippingDate ? quote.requestedShippingDate.slice(0, 10) : '',
  );
  const [siteAddress, setSiteAddress] = useState(quote.siteAddress ?? '');
  const [projectNotes, setProjectNotes] = useState(quote.projectNotes ?? '');
  const [discountPctInput, setDiscountPctInput] = useState(
    quote.discountPct != null && quote.discountPct !== '' ? String(Number(quote.discountPct) * 100) : '',
  );
  // U5 — where the discount applies (one-off upfront vs every renewal).
  const [discountScope, setDiscountScope] = useState<'one_off' | 'recurring'>(
    quote.discountScope === 'recurring' ? 'recurring' : 'one_off',
  );
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
  // Auto-save status (P1-05.1): idle until the first edit, then saving → saved (with a timestamp).
  const [autoStatus, setAutoStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  // `dirty` gates the debounced auto-save: set only by genuine user edits (never on mount/refetch).
  const [dirty, setDirty] = useState(false);

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

  const toggleViewer = (id: string) => {
    setDirty(true);
    setSelectedViewers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // The shared PATCH path used by both the explicit Save button and the debounced auto-save. Always
  // sends the CURRENT lockVersion (refreshed by onChange after each success) so consecutive auto-saves
  // never trigger a self-inflicted 409 loop. On conflict it raises the banner and auto-save halts.
  const persist = useCallback(async () => {
    setBusy(true);
    setErr(null);
    setConflict(false);
    setAutoStatus('saving');
    try {
      await api(`/quotes/${quote.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          jobReference,
          currencyCode,
          clientId: clientId ? Number(clientId) : null,
          locationId: locationId ? Number(locationId) : null,
          viewerUserIds: [...selectedViewers].map(Number),
          // Project information (U1). discountPct converts % → fraction; empty clears the override.
          requestedShippingDate: requestedShippingDate || null,
          siteAddress: siteAddress.trim() ? siteAddress.trim() : null,
          projectNotes: projectNotes.trim() ? projectNotes.trim() : null,
          discountPct: discountPctInput.trim() === '' ? null : Number(discountPctInput) / 100,
          discountScope,
          // Optimistic concurrency: server rejects (409) if the quote moved since we loaded it.
          expectedVersion: quote.lockVersion,
        }),
      });
      await onChange(); // refetch → quote.lockVersion advances, so the next save uses the new token.
      setAutoStatus('saved');
      setSavedAt(new Date().toLocaleTimeString());
    } catch (e) {
      setAutoStatus('idle');
      if (e instanceof ApiError && e.code === 'conflict') setConflict(true);
      else setErr(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }, [quote.id, quote.lockVersion, jobReference, currencyCode, clientId, locationId, selectedViewers, requestedShippingDate, siteAddress, projectNotes, discountPctInput, discountScope, onChange]);

  const save = persist;

  // Debounced auto-save (~1.5s after the last edit). `dirty` gates it so it never fires on mount or
  // on the prop-sync re-render after a save/refetch — only genuine user edits arm the timer. When a
  // conflict is showing, auto-save is suspended until the user reloads (which resets dirty).
  useEffect(() => {
    if (!canWrite || !dirty || conflict || !jobReference) return;
    const t = setTimeout(() => {
      setDirty(false);
      void persist();
    }, 1500);
    return () => clearTimeout(t);
  }, [dirty, conflict, canWrite, jobReference, persist]);

  if (!canWrite) {
    return (
      <div className="card">
        <p className="muted">Quote header (read-only).</p>
        <div className="grid3">
          <div><label>Job reference</label><input value={quote.jobReference} readOnly /></div>
          <div><label>Status</label><input value={quote.status} readOnly /></div>
          <div><label>Currency</label><input value={quote.currency?.code ?? ''} readOnly /></div>
        </div>
        <h4 style={{ margin: '16px 0 4px' }}>Project information</h4>
        <div className="grid3">
          <div><label>Requested shipping date</label><input value={quote.requestedShippingDate ? quote.requestedShippingDate.slice(0, 10) : ''} readOnly /></div>
          <div><label>Site address</label><input value={quote.siteAddress ?? ''} readOnly /></div>
          <div><label>Discount</label><input value={quote.discountPct != null && quote.discountPct !== '' ? `${Number(quote.discountPct) * 100}%` : '(default)'} readOnly /></div>
          <div><label>Discount applies to</label><input value={quote.discountScope === 'recurring' ? 'Every renewal (recurring)' : 'One-off (upfront)'} readOnly /></div>
        </div>
        <div style={{ marginTop: 8 }}>
          <label>Project notes</label>
          <textarea value={quote.projectNotes ?? ''} readOnly rows={3} style={{ width: '100%', fontFamily: 'inherit', fontSize: 13, padding: 8, boxSizing: 'border-box' }} />
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
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {autoStatus === 'saving' && <span className="muted">Saving…</span>}
          {autoStatus === 'saved' && (
            <span className="muted">✓ Saved{savedAt ? ` ${savedAt}` : ''}</span>
          )}
          <span className="muted" title="Optimistic-locking token; bumped on every change">v{quote.lockVersion}</span>
        </span>
      </div>
      <div className="grid3">
        <div><label>Job reference</label><input value={jobReference} onChange={(e) => { setJobReference(e.target.value); setDirty(true); }} /></div>
        <div>
          <label>Client</label>
          <SearchSelect
            value={clientId}
            onChange={(v) => { setClientId(v); setDirty(true); }}
            allowEmpty
            placeholder="Select client…"
            options={clients.map((c) => ({ value: c.id, label: c.name ?? '' }))}
          />
        </div>
        <div>
          <label>Location</label>
          <SearchSelect
            value={locationId}
            onChange={(v) => { setLocationId(v); setDirty(true); }}
            allowEmpty
            placeholder="Select location…"
            options={locations.map((l) => ({ value: l.id, label: l.name ?? '' }))}
          />
        </div>
        <div>
          <label>Currency</label>
          <SearchSelect
            value={currencyCode}
            onChange={(v) => { setCurrencyCode(v); setDirty(true); }}
            options={currencies.map((c) => ({ value: c.code ?? '', label: c.code ?? '' }))}
          />
        </div>
        <div><label>Status</label><input value={quote.status} readOnly /></div>
      </div>

      <h4 style={{ margin: '18px 0 4px' }}>Project information</h4>
      <p className="muted" style={{ marginTop: 0 }}>Quote-level site &amp; commercial details. The discount overrides the client/system default (leave blank to inherit).</p>
      <div className="grid3">
        <div>
          <label>Requested shipping date</label>
          <input type="date" value={requestedShippingDate} onChange={(e) => { setRequestedShippingDate(e.target.value); setDirty(true); }} />
        </div>
        <div>
          <label>Site address</label>
          <input value={siteAddress} onChange={(e) => { setSiteAddress(e.target.value); setDirty(true); }} placeholder="e.g. 12 Site St, Sydney" />
        </div>
        <div>
          <label>Discount override (%)</label>
          <input type="number" min={0} max={99} step="0.5" value={discountPctInput} onChange={(e) => { setDiscountPctInput(e.target.value); setDirty(true); }} placeholder="(default)" />
        </div>
        <div>
          <label>Discount applies to</label>
          <select value={discountScope} onChange={(e) => { setDiscountScope(e.target.value as 'one_off' | 'recurring'); setDirty(true); }}>
            <option value="one_off">One-off (upfront)</option>
            <option value="recurring">Every renewal (recurring)</option>
          </select>
        </div>
      </div>
      <div style={{ marginTop: 8 }}>
        <label>Project notes</label>
        <textarea value={projectNotes} onChange={(e) => { setProjectNotes(e.target.value); setDirty(true); }} rows={3} style={{ width: '100%', fontFamily: 'inherit', fontSize: 13, padding: 8, boxSizing: 'border-box' }} placeholder="Internal project notes…" />
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
          This quote was changed elsewhere since you opened it. Your edits were not saved. Auto-save is
          paused.{' '}
          <button className="ghost" onClick={() => { setDirty(false); setConflict(false); void onChange(); }}>Reload latest</button>
        </div>
      )}
      {err && <div className="error" style={{ marginTop: 12 }}>{err}</div>}

      <div className="step-actions">
        <button className="primary" onClick={() => { setDirty(false); void save(); }} disabled={busy || !jobReference}>
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
  // T3: over/under sizing + aspect-ratio guardrail (guidance only).
  sizeMode: 'under' | 'exact' | 'over';
  deltaWidthMm: number;
  deltaHeightMm: number;
  sizeDeltaPct: string;
  ratioPreferred: boolean;
  ratioGuidance: string | null;
  // U2: manufacturer-priority ordering + lead time + size-tolerance band.
  manufacturerName: string | null;
  leadTimeDays: number | null;
  toleranceBand: number;
}

// Good / Better / Best tiered option (T2): a ranked config + tier label/rationale + supply price.
interface TierOption extends ConfigOption {
  tier: 'value' | 'recommended' | 'premium';
  label: string;
  rationale: string;
  vendor?: string | null;
  supplyCostAud: string | null;
  supplySellAud: string;
  margin: string | null;
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

// The four LED component pickers. Each maps a ledComponentSchema `componentType` to its catalog
// admin table (served by GET /admin/<slug>?take=200 → { rows }) and to the single id field the
// schema expects set for that type (exactly one of controllerId/ledPeripheralId/mediaplayerId/peripheralId).
const LED_COMPONENT_TABLES = [
  { componentType: 'controller', slug: 'controllers', idField: 'controllerId', label: 'Controller' },
  { componentType: 'led_peripheral', slug: 'led-peripherals', idField: 'ledPeripheralId', label: 'LED peripheral' },
  { componentType: 'mediaplayer', slug: 'mediaplayers', idField: 'mediaplayerId', label: 'Mediaplayer' },
  { componentType: 'mediaplayer_peripheral', slug: 'peripherals', idField: 'peripheralId', label: 'Mediaplayer peripheral' },
] as const;
type LedComponentType = (typeof LED_COMPONENT_TABLES)[number]['componentType'];
type LedComponentIdField = (typeof LED_COMPONENT_TABLES)[number]['idField'];
// A chosen component row in local state: its type, the selected catalog id, and a qty.
interface ComponentRow { componentType: LedComponentType; itemId: string; qty: number }

// T3: human "Size" indicator for a config — under/exact/over with the signed % delta vs the opening.
function sizeLabel(o: Pick<ConfigOption, 'sizeMode' | 'sizeDeltaPct'>): string {
  const pct = Number(o.sizeDeltaPct);
  if (o.sizeMode === 'exact') return 'exact';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct}% ${o.sizeMode}`;
}

// Form 1 (U1): select & finalise an LED panel — opening size + orientation/ratio + configure /
// Good-Better-Best / specific-product selection + components + rotate. Adds the screen (POST
// /led-screens) with panel + geometry + components only; secondary options/services are set
// afterwards via the per-screen PATCH editor (LedOptionsEditor / Form 2).
function LedAddForm({ quote, onChange }: { quote: Quote; onChange: () => Promise<void> }) {
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
  // Good / Better / Best tiered options (T2).
  const [tiers, setTiers] = useState<TierOption[] | null>(null);
  const [tierReasons, setTierReasons] = useState<string[]>([]);
  const [distinctProducts, setDistinctProducts] = useState(0);
  // The "Screen selection" accordion is open until a product is selected, then collapses to a
  // compact summary; the user can re-open it any time to pick a different product.
  const [accordionOpen, setAccordionOpen] = useState(true);

  // S1: orientation + aspect ratio (with auto-dimension calc), components, back cover, notes.
  const [orientation, setOrientation] = useState('');
  const [aspectRatioId, setAspectRatioId] = useState('');
  const [ratios, setRatios] = useState<Array<{ id: string; ratioLabel: string }>>([]);
  // Component pickers: catalog rows per type + the user's chosen component rows + the add-row draft.
  const [componentRows, setComponentRows] = useState<Record<LedComponentType, Opt[]>>(
    () => Object.fromEntries(LED_COMPONENT_TABLES.map((t) => [t.componentType, [] as Opt[]])) as unknown as Record<LedComponentType, Opt[]>,
  );
  const [components, setComponents] = useState<ComponentRow[]>([]);
  const [draftType, setDraftType] = useState<LedComponentType>('controller');
  const [draftItem, setDraftItem] = useState('');
  const [draftQty, setDraftQty] = useState('1');

  // Options & services lookups (merged in from the per-screen editor) — same admin tables, loaded
  // once so a single add POST can carry frame/trim/GOB/install/freight/warranty/etc.
  const [optionRows, setOptionRows] = useState<Record<LedOptionKey, Opt[]>>(
    () => Object.fromEntries(LED_OPTION_TABLES.map((t) => [t.key, [] as Opt[]])) as unknown as Record<LedOptionKey, Opt[]>,
  );
  const [selectedOpts, setSelectedOpts] = useState<Record<LedOptionKey, string>>(
    () => Object.fromEntries(LED_OPTION_TABLES.map((t) => [t.key, ''])) as unknown as Record<LedOptionKey, string>,
  );
  const [backCover, setBackCover] = useState(false);
  const [frameNote, setFrameNote] = useState('');
  const [serviceDescriptionSuffix, setServiceDescriptionSuffix] = useState('');

  useEffect(() => {
    // activeOnly=true hides deprecated catalog rows from NEW selections (P1-11.4); existing quotes
    // still resolve their stored FK regardless of deprecated state.
    api<{ rows: Opt[] }>('/admin/led-products?take=300&activeOnly=true').then((r) => setProducts(r.rows));
    // Aspect ratios for the orientation/auto-dimension rule.
    api<{ rows: Array<{ id: string; ratioLabel: string }> }>('/admin/screen-ratios?take=200&activeOnly=true')
      .then((r) => setRatios(r.rows))
      .catch(() => setRatios([]));
    // The four component catalogs (controller / led-peripheral / mediaplayer / mediaplayer-peripheral).
    Promise.all(
      LED_COMPONENT_TABLES.map((t) =>
        api<{ rows: Opt[] }>(`/admin/${t.slug}?take=200&activeOnly=true`)
          .then((r) => [t.componentType, r.rows] as const)
          .catch(() => [t.componentType, [] as Opt[]] as const),
      ),
    ).then((entries) => {
      setComponentRows(Object.fromEntries(entries) as unknown as Record<LedComponentType, Opt[]>);
    });
    // The ten options/services catalogs (frame / trim / hanging-bar / engineering / install / freight /
    // warranty / service-hours / access-equipment / GOB).
    Promise.all(
      LED_OPTION_TABLES.map((t) =>
        api<{ rows: Opt[] }>(`/admin/${t.slug}?take=200&activeOnly=true`)
          .then((r) => [t.key, r.rows] as const)
          .catch(() => [t.key, [] as Opt[]] as const),
      ),
    ).then((entries) => setOptionRows(Object.fromEntries(entries) as unknown as Record<LedOptionKey, Opt[]>));
  }, []);

  // Parse "16:9" → { w: 16, h: 9 }; null when unparseable.
  const parseRatio = (label: string | undefined): { w: number; h: number } | null => {
    if (!label) return null;
    const m = label.match(/(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/);
    if (!m) return null;
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (!(w > 0) || !(h > 0)) return null;
    return { w, h };
  };

  // Workbook rule (E11/E12): orientation + ratio + one dimension → fill the other so the longer axis
  // matches orientation (Landscape → width is the long axis; Portrait → height is the long axis).
  // Editing one dimension recomputes the other; both stay editable (the user can override).
  const recalcDim = (changed: 'w' | 'h', value: string, ori = orientation, ratioId = aspectRatioId) => {
    const ratio = parseRatio(ratios.find((r) => r.id === ratioId)?.ratioLabel);
    if (changed === 'w') setW(value);
    else setH(value);
    if (!ratio || !ori) return;
    const minSide = Math.min(ratio.w, ratio.h);
    const maxSide = Math.max(ratio.w, ratio.h);
    const n = Number(value);
    if (!(n > 0)) return;
    if (ori === 'Landscape') {
      // width is the long axis → height = width * (short/long)
      if (changed === 'w') setH(String(Math.round(n * (minSide / maxSide))));
      else setW(String(Math.round(n * (maxSide / minSide))));
    } else {
      // Portrait: height is the long axis → width = height * (short/long)
      if (changed === 'h') setW(String(Math.round(n * (minSide / maxSide))));
      else setH(String(Math.round(n * (maxSide / minSide))));
    }
  };

  // Re-run the auto-calc from the current width when orientation/ratio changes.
  const onOrientationChange = (v: string) => { setOrientation(v); recalcDim('w', w, v, aspectRatioId); };
  const onRatioChange = (v: string) => { setAspectRatioId(v); recalcDim('w', w, orientation, v); };

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

  // Good / Better / Best: three priced tiers (Value / Recommended / Premium) for the opening.
  const loadTiers = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await api<{ options: TierOption[]; reasons: string[]; distinctProducts: number }>(
        `/quotes/${quote.id}/screens/options`,
        { method: 'POST', body: JSON.stringify({ desiredWidthMm: Number(w), desiredHeightMm: Number(h), allowRotation: rotate }) },
      );
      setTiers(res.options);
      setTierReasons(res.reasons);
      setDistinctProducts(res.distinctProducts);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  // Add a component row from the draft pickers (one type + one catalog item + qty).
  const addComponent = () => {
    if (!draftItem) return;
    const q = Number(draftQty);
    setComponents((prev) => [...prev, { componentType: draftType, itemId: draftItem, qty: q >= 1 ? q : 1 }]);
    setDraftItem('');
    setDraftQty('1');
  };
  const removeComponent = (idx: number) => setComponents((prev) => prev.filter((_, i) => i !== idx));

  // Map a ComponentRow → the ledComponentSchema shape (set exactly the one id field for its type).
  const componentPayload = () =>
    components.map((c) => {
      const def = LED_COMPONENT_TABLES.find((t) => t.componentType === c.componentType)!;
      return { componentType: c.componentType, [def.idField as LedComponentIdField]: Number(c.itemId), qty: c.qty };
    });

  const addScreen = async () => {
    setBusy(true);
    setErr(null);
    try {
      // Selected option FKs (omit empties), housing/notes — all carried in the one add POST.
      const optionFks: Record<string, number> = {};
      for (const t of LED_OPTION_TABLES) if (selectedOpts[t.key]) optionFks[t.key] = Number(selectedOpts[t.key]);
      await api(`/quotes/${quote.id}/led-screens`, {
        method: 'POST',
        body: JSON.stringify({
          screenName: name || undefined,
          ledProductId: Number(productId),
          desiredWidthMm: Number(w),
          desiredHeightMm: Number(h),
          rotateCabinets: rotate,
          // S1 inputs (only sent when set).
          ...(orientation ? { orientation } : {}),
          ...(aspectRatioId ? { aspectRatioId: Number(aspectRatioId) } : {}),
          components: componentPayload(),
          // Options & services FKs (only the selected ones).
          ...optionFks,
          backCover,
          ...(frameNote.trim() ? { frameNote: frameNote.trim() } : {}),
          ...(serviceDescriptionSuffix.trim() ? { serviceDescriptionSuffix: serviceDescriptionSuffix.trim() } : {}),
        }),
      });
      // Reset the whole form for the next screen and re-open the selection accordion.
      setName('');
      setProductId('');
      setOptions(null);
      setTiers(null);
      setComponents([]);
      setOrientation('');
      setAspectRatioId('');
      setSelectedOpts(Object.fromEntries(LED_OPTION_TABLES.map((t) => [t.key, ''])) as unknown as Record<LedOptionKey, string>);
      setBackCover(false);
      setFrameNote('');
      setServiceDescriptionSuffix('');
      setAccordionOpen(true);
      await onChange();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  // Selecting a Configure / Good-Better-Best option sets the product + rotation and collapses the
  // selection accordion to its summary — it does NOT add the screen yet. Width/height stay the
  // entered opening; the merged details form below then attaches to this product before finalising.
  const selectProduct = (chosenProductId: string, rotated: boolean) => {
    setProductId(chosenProductId);
    setRotate(rotated);
    setErr(null);
    setAccordionOpen(false);
  };

  // The selected product's model name, for the collapsed accordion summary.
  const selectedModel = products.find((p) => p.id === productId)?.model ?? '';

  // Required-field gating (P1-12.3): the essentials before "+ Add screen".
  const missing: string[] = [];
  if (!productId) missing.push('select a product above');
  if (!(Number(w) > 0)) missing.push('width');
  if (!(Number(h) > 0)) missing.push('height');
  const canAddSpecific = missing.length === 0;

  return (
    <div>
      {/* Screen-selection accordion: collapses to a compact summary once a product is selected. */}
      {!accordionOpen && productId ? (
        <div className="card">
          <div className="list-row" style={{ alignItems: 'center' }}>
            <div>
              <span className="pill" style={{ marginRight: 6 }}>Selected</span>
              <b>{selectedModel || `Product ${productId}`}</b>{rotate ? ' (rot)' : ''}{' '}
              <span className="muted">· {w}×{h}mm</span>
            </div>
            <button className="ghost" onClick={() => setAccordionOpen(true)}>Expand / change</button>
          </div>
        </div>
      ) : (
      <div className="card">
        <div className="list-row" style={{ alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>Screen selection</h3>
          {productId && <button className="ghost" onClick={() => setAccordionOpen(false)}>Collapse</button>}
        </div>
        <p className="muted">Enter the opening size; the engine ranks every LED product that fits. Pick one to attach the screen details below.</p>
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
          <button onClick={loadTiers} disabled={busy} style={{ marginLeft: 8 }}>
            {busy ? 'Comparing…' : '⚖️ Good / Better / Best'}
          </button>
        </div>

      {tiers && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Good / Better / Best</h3>
          {tiers.length === 0 && <p className="muted">No options: {tierReasons.join(' ')}</p>}
          {tiers.length > 0 && (
            <>
              {distinctProducts < 3 && (
                <p className="muted">
                  Only {distinctProducts} distinct product{distinctProducts === 1 ? '' : 's'} fit this opening —
                  some tiers reuse the same product.
                </p>
              )}
              <p className="muted">
                Prices shown are the LED <strong>supply</strong> figure (panel material) for a like-for-like
                comparison; install, frame and components are added when you place the screen.
              </p>
              <div className="grid3" style={{ alignItems: 'stretch' }}>
                {tiers.map((t) => (
                  <div
                    key={t.tier}
                    className="card"
                    style={{
                      margin: 0,
                      borderColor: t.tier === 'recommended' ? 'var(--accent, #4f46e5)' : undefined,
                      borderWidth: t.tier === 'recommended' ? 2 : undefined,
                    }}
                  >
                    <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700, marginBottom: 4 }}>
                      {t.label}
                    </div>
                    <p className="muted" style={{ marginTop: 0 }}>{t.rationale}</p>
                    <div style={{ fontWeight: 600 }}>{t.model}{t.rotated ? ' (rot)' : ''}</div>
                    <table style={{ width: '100%', fontSize: 13, margin: '8px 0' }}>
                      <tbody>
                        <tr><td className="muted">Manufacturer</td><td>{t.manufacturerName ?? '—'}</td></tr>
                        <tr><td className="muted">Lead time</td><td>{t.leadTimeDays != null ? `${t.leadTimeDays} d` : '—'}</td></tr>
                        <tr><td className="muted">Size (mm)</td><td>{t.widthMm}×{t.heightMm}</td></tr>
                        <tr><td className="muted">Resolution</td><td>{t.resolutionWpx}×{t.resolutionHpx}</td></tr>
                        <tr>
                          <td className="muted">Ratio</td>
                          <td>
                            {t.ratioLabel ?? '—'}
                            {!t.ratioPreferred && t.ratioGuidance && (
                              <span title={t.ratioGuidance} style={{ marginLeft: 4, cursor: 'help' }}>⚠️</span>
                            )}
                          </td>
                        </tr>
                        <tr><td className="muted">Fill %</td><td>{t.fillPercent}</td></tr>
                        <tr><td className="muted">Cabinets</td><td>{t.cabinetCount}</td></tr>
                        <tr><td className="muted">Cut?</td><td>{t.cutCabinetSuggested ? '⚠️ yes' : '—'}</td></tr>
                        <tr><td className="muted">Supply sell</td><td>${t.supplySellAud}</td></tr>
                        {getRole() === 'admin' && (
                          <>
                            <tr><td className="muted">Supply cost</td><td>{t.supplyCostAud ? `$${t.supplyCostAud}` : '—'}</td></tr>
                            <tr><td className="muted">Margin</td><td>{t.margin ? `${(Number(t.margin) * 100).toFixed(1)}%` : '—'}</td></tr>
                          </>
                        )}
                      </tbody>
                    </table>
                    <button className="primary" onClick={() => selectProduct(t.productId, t.rotated)} disabled={busy} style={{ width: '100%' }}>
                      Select this option
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {options && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Ranked configurations ({options.length})</h3>
          {options.length === 0 && <p className="muted">No fit: {reasons.join(' ')}</p>}
          {options.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Product</th><th>Manufacturer</th><th className="cell-num">Lead (d)</th>
                    <th>Size (mm)</th><th>Sizing</th><th>Resolution</th><th>Ratio</th>
                    <th className="cell-num">Fill %</th><th className="cell-num">Cabinets</th><th>Cut?</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {options.slice(0, 25).map((o, i) => (
                    <tr key={`${o.productId}-${o.rotated}-${o.sizeMode}-${i}`}>
                      <td>{o.model}{o.rotated ? ' (rot)' : ''}</td>
                      <td>{o.manufacturerName ?? '—'}</td>
                      <td className="cell-num">{o.leadTimeDays ?? '—'}</td>
                      <td>{o.widthMm}×{o.heightMm}</td>
                      <td>
                        <span
                          title={`Δ ${o.deltaWidthMm >= 0 ? '+' : ''}${o.deltaWidthMm}mm × ${o.deltaHeightMm >= 0 ? '+' : ''}${o.deltaHeightMm}mm vs opening · within ±${o.toleranceBand}% band`}
                          style={{
                            color:
                              o.sizeMode === 'over' ? 'var(--danger, #dc2626)'
                                : o.sizeMode === 'under' ? 'var(--warn, #b45309)'
                                  : 'var(--ok, #15803d)',
                          }}
                        >
                          {sizeLabel(o)}
                        </span>
                      </td>
                      <td>{o.resolutionWpx}×{o.resolutionHpx}</td>
                      <td>
                        {o.ratioLabel ?? '—'}
                        {!o.ratioPreferred && o.ratioGuidance && (
                          <span title={o.ratioGuidance} style={{ marginLeft: 4, cursor: 'help' }}>⚠️</span>
                        )}
                      </td>
                      <td className="cell-num">{o.fillPercent}</td>
                      <td className="cell-num">{o.cabinetCount}</td>
                      <td>{o.cutCabinetSuggested ? '⚠️' : '—'}</td>
                      <td className="actions">
                        <button className="primary" onClick={() => selectProduct(o.productId, o.rotated)} disabled={busy}>
                          Select
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
      </div>
      )}

      {/* Merged details form — only once a product is selected via the accordion. */}
      {productId && (
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Screen details</h3>
        <p className="muted">Geometry, orientation, components and options &amp; services for the selected product — all sent in one go when you add the screen.</p>
        <div className="grid3">
          <div>
            <label style={Number(w) > 0 ? undefined : { color: 'var(--danger, #dc2626)' }}>Width (mm) *</label>
            <input type="number" value={w} onChange={(e) => recalcDim('w', e.target.value)} />
          </div>
          <div>
            <label style={Number(h) > 0 ? undefined : { color: 'var(--danger, #dc2626)' }}>Height (mm) *</label>
            <input type="number" value={h} onChange={(e) => recalcDim('h', e.target.value)} />
          </div>
          <div>
            <label>Orientation</label>
            <SearchSelect
              value={orientation}
              onChange={onOrientationChange}
              allowEmpty
              placeholder="Select orientation…"
              options={[{ value: 'Landscape', label: 'Landscape' }, { value: 'Portrait', label: 'Portrait' }]}
            />
          </div>
          <div>
            <label>Aspect ratio</label>
            <SearchSelect
              value={aspectRatioId}
              onChange={onRatioChange}
              allowEmpty
              placeholder="Select aspect ratio…"
              options={ratios.map((r) => ({ value: r.id, label: r.ratioLabel }))}
            />
          </div>
        </div>
        <p className="muted" style={{ marginTop: 4 }}>
          Pick orientation + an aspect ratio and one dimension auto-fills the other (still editable).
        </p>

        <h4 style={{ margin: '16px 0 4px' }}>Components</h4>
        <p className="muted" style={{ marginTop: 0 }}>
          Attach controllers, mediaplayers and peripherals — add as many as needed; each is priced with the screen.
        </p>
        <div className="grid3">
          <div>
            <label>Type</label>
            <SearchSelect
              value={draftType}
              onChange={(v) => { setDraftType(v as LedComponentType); setDraftItem(''); }}
              options={LED_COMPONENT_TABLES.map((t) => ({ value: t.componentType, label: t.label }))}
            />
          </div>
          <div>
            <label>Item</label>
            <SearchSelect
              value={draftItem}
              onChange={setDraftItem}
              allowEmpty
              placeholder="Search items…"
              options={(componentRows[draftType] ?? []).map((o) => ({ value: o.id, label: o.model ?? o.name ?? '' }))}
            />
          </div>
          <div>
            <label>Qty</label>
            <input type="number" min={1} value={draftQty} onChange={(e) => setDraftQty(e.target.value)} />
          </div>
        </div>
        <div className="step-actions">
          <button className="ghost" onClick={addComponent} disabled={!draftItem}>+ Add component</button>
        </div>
        {components.length > 0 && (
          <div style={{ marginTop: 8 }}>
            {components.map((c, i) => {
              const def = LED_COMPONENT_TABLES.find((t) => t.componentType === c.componentType)!;
              const item = (componentRows[c.componentType] ?? []).find((o) => o.id === c.itemId);
              return (
                <div className="list-row" key={i}>
                  <span>
                    <span className="pill" style={{ marginRight: 6 }}>{def.label}</span>
                    {item?.model ?? item?.name ?? c.itemId} <span className="muted">× {c.qty}</span>
                  </span>
                  <button className="danger" onClick={() => removeComponent(i)}>Remove</button>
                </div>
              );
            })}
          </div>
        )}

        <h4 style={{ margin: '16px 0 4px' }}>Options &amp; services</h4>
        <p className="muted" style={{ marginTop: 0 }}>
          Frame, trim, GOB, install, freight, warranty and more — all optional; each is priced with the screen.
        </p>
        <div className="grid3">
          {LED_OPTION_TABLES.map((t) => (
            <div key={t.key}>
              <label>{t.label}</label>
              <SearchSelect
                value={selectedOpts[t.key]}
                onChange={(v) => setSelectedOpts((p) => ({ ...p, [t.key]: v }))}
                allowEmpty
                placeholder={`Select ${t.label.toLowerCase()}…`}
                options={(optionRows[t.key] ?? []).map((o) => ({ value: o.id, label: o.name ?? o.model ?? '' }))}
              />
            </div>
          ))}
        </div>
        <h4 style={{ margin: '14px 0 4px' }}>Housing &amp; descriptions</h4>
        <div className="grid3">
          <div>
            <label>Back cover</label>
            <input type="checkbox" checked={backCover} onChange={(e) => setBackCover(e.target.checked)} style={{ width: 'auto' }} />
          </div>
          <div>
            <label>Frame / housing description</label>
            <input value={frameNote} onChange={(e) => setFrameNote(e.target.value)} placeholder="optional" />
          </div>
          <div>
            <label>Service description suffix</label>
            <input value={serviceDescriptionSuffix} onChange={(e) => setServiceDescriptionSuffix(e.target.value)} placeholder="optional" />
          </div>
        </div>

        {err && <div className="error" style={{ marginTop: 8 }}>{err}</div>}
        {!canAddSpecific && (
          <p className="muted" style={{ marginTop: 12 }}>
            ⚠️ Required before pricing: {missing.join(', ')}.
          </p>
        )}
        <p className="muted" style={{ marginTop: 12 }}>
          Adds the LED screen with the panel, geometry, components and the options &amp; services above —
          all in one. You can still tweak options later in the per-screen editor.
        </p>
        <div className="step-actions">
          <button className="primary" onClick={() => addScreen()} disabled={busy || !canAddSpecific}>
            {busy ? 'Pricing…' : '+ Add screen'}
          </button>
        </div>
      </div>
      )}
    </div>
  );
}

// ── LCD-1 questionnaire model ──────────────────────────────────────────────
// The LCD-1 sheet is a structured line-item form grouped into sections. Each section maps display_catalog
// rows (filtered by category keyword) to one of the lcdItemSchema itemTypes; the Configuration / Seen
// Labour / Location sections also allow fixed/manual rows (e.g. Parking 50, Travel 75). The server
// resolves catalog prices authoritatively and applies the fixed LCD margin + out-of-hours uplift.
type LcdItemType = 'display' | 'mediaplayer' | 'bracket' | 'install' | 'labour' | 'location_fee';
interface LcdSectionDef {
  key: string;
  title: string;
  itemType: LcdItemType;
  // Substrings (lower-case) of display_catalog.category that belong in this section's picker.
  catMatch: string[];
  allowManual?: boolean;
}
const LCD_SECTIONS: LcdSectionDef[] = [
  { key: 'display', title: 'Display', itemType: 'display', catMatch: ['indoor', 'outdoor', 'screen', 'video wall', 'touch', 'stretch', 'smartv', 'videri', 'projector', 'redback', 'high bright', 'all in one'] },
  { key: 'mediaplayer', title: 'Mediaplayer & Peripherals', itemType: 'mediaplayer', catMatch: ['mediaplayer', 'peripheral', 'networking', 'chromecast', 'nexmosphere'] },
  { key: 'bracket', title: 'Bracket & Shroud', itemType: 'bracket', catMatch: ['bracket', 'shroud', 'culpan', 'wall kit'] },
  { key: 'install', title: 'Configuration / Installation', itemType: 'install', catMatch: ['service'], allowManual: true },
  { key: 'labour', title: 'Seen Labour', itemType: 'labour', catMatch: ['service', 'consumable', 'spare'], allowManual: true },
  { key: 'location_fee', title: 'Location Fees', itemType: 'location_fee', catMatch: ['freight', 'rental'], allowManual: true },
];
// Common fixed rows from the sheet, offered as quick-add manual templates.
const LCD_MANUAL_TEMPLATES: Record<string, Array<{ description: string; unitCost: number }>> = {
  install: [
    { description: 'Parking', unitCost: 50 },
    { description: 'Travel', unitCost: 75 },
    { description: 'Induction', unitCost: 0 },
    { description: 'Installation, Per hour', unitCost: 95 },
  ],
  labour: [
    { description: 'Consumables', unitCost: 30 },
    { description: 'Rubbish Allowance', unitCost: 25 },
  ],
  location_fee: [
    { description: 'Other Freight, Packaging and Handling', unitCost: 25 },
  ],
};

interface LcdLine { sectionKey: string; itemType: LcdItemType; displayId?: string; description: string; qty: number; unitCost?: number; manual: boolean }

function LcdAddForm({ quote, onChange }: { quote: Quote; onChange: () => Promise<void> }) {
  const [catalog, setCatalog] = useState<Opt[]>([]);
  const [serviceHoursId, setServiceHoursId] = useState('');
  const [warrantyId, setWarrantyId] = useState('');
  const [installMethodId, setInstallMethodId] = useState('');
  const [serviceHours, setServiceHours] = useState<Opt[]>([]);
  const [warranties, setWarranties] = useState<Opt[]>([]);
  const [installMethods, setInstallMethods] = useState<Opt[]>([]);
  const [orientation, setOrientation] = useState('');
  const [screenName, setScreenName] = useState('');
  const [lines, setLines] = useState<LcdLine[]>([]);
  // Per-section draft (catalog pick + qty) and per-section manual draft.
  const [pick, setPick] = useState<Record<string, string>>({});
  const [pickQty, setPickQty] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ rows: Opt[] }>('/admin/display-catalog?take=500&activeOnly=true').then((r) => setCatalog(r.rows));
    api<{ rows: Opt[] }>('/admin/service-hours?take=200').then((r) => setServiceHours(r.rows));
    api<{ rows: Opt[] }>('/admin/warranties?take=200').then((r) => setWarranties(r.rows));
    api<{ rows: Opt[] }>('/admin/install-methods?take=200').then((r) => setInstallMethods(r.rows));
  }, []);

  const catFor = (def: LcdSectionDef): Opt[] =>
    catalog.filter((r) => {
      const c = (r.category ?? '').toLowerCase();
      return def.catMatch.some((m) => c.includes(m));
    });

  const ohName = serviceHours.find((x) => x.id === serviceHoursId)?.name;
  const outOfHours = !!ohName && ohName !== 'Business Hours';

  const addCatalog = (def: LcdSectionDef) => {
    const id = pick[def.key];
    if (!id) return;
    const row = catalog.find((x) => x.id === id);
    setLines((ls) => [
      ...ls,
      { sectionKey: def.key, itemType: def.itemType, displayId: id, description: row?.model ?? '', qty: Number(pickQty[def.key] ?? '1') || 1, manual: false },
    ]);
    setPick((p) => ({ ...p, [def.key]: '' }));
    setPickQty((q) => ({ ...q, [def.key]: '1' }));
  };
  const addManual = (def: LcdSectionDef, tpl?: { description: string; unitCost: number }) => {
    setLines((ls) => [
      ...ls,
      { sectionKey: def.key, itemType: def.itemType, description: tpl?.description ?? '', qty: 1, unitCost: tpl?.unitCost ?? 0, manual: true },
    ]);
  };
  const updateLine = (idx: number, patch: Partial<LcdLine>) =>
    setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  const removeLine = (idx: number) => setLines((ls) => ls.filter((_, i) => i !== idx));

  // Live preview totals (server is authoritative; this mirrors the same fixed-margin gross-up).
  const MARGIN = 0.3; // lcd_margin (Reference Data F12) — display-only preview
  const sellOf = (l: LcdLine): number => {
    if (l.manual) return Math.round((l.unitCost ?? 0) / (1 - MARGIN));
    const row = catalog.find((x) => x.id === l.displayId);
    const cost = Number(row?.totalCost ?? row?.usd ?? 0);
    return Math.round(cost / (1 - MARGIN));
  };
  const grand = Math.round(lines.reduce((a, l) => a + sellOf(l) * l.qty, 0) / 10) * 10;

  const save = async () => {
    setBusy(true);
    try {
      const items = lines.map((l) => ({
        itemType: l.itemType,
        displayId: l.manual ? undefined : l.displayId ? Number(l.displayId) : undefined,
        description: l.description || undefined,
        qty: l.qty,
        unitCost: l.manual ? (l.unitCost ?? 0) : undefined,
      }));
      const firstDisplay = lines.find((l) => l.itemType === 'display' && l.displayId)?.displayId;
      await api(`/quotes/${quote.id}/lcd-screens`, {
        method: 'POST',
        body: JSON.stringify({
          screenName: screenName || undefined,
          orientation: orientation || undefined,
          displayId: firstDisplay ? Number(firstDisplay) : undefined,
          serviceHoursId: serviceHoursId ? Number(serviceHoursId) : undefined,
          warrantyId: warrantyId ? Number(warrantyId) : undefined,
          installMethodId: installMethodId ? Number(installMethodId) : undefined,
          items,
        }),
      });
      setLines([]);
      setScreenName('');
      await onChange();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>New LCD screen (LCD-1)</h3>
        <div className="grid3">
          <div><label>Screen name</label><input value={screenName} onChange={(e) => setScreenName(e.target.value)} placeholder="e.g. Foyer menu board" /></div>
          <div>
            <label>Orientation</label>
            <SearchSelect value={orientation} onChange={setOrientation} allowEmpty placeholder="—"
              options={[{ value: 'L', label: 'Landscape' }, { value: 'P', label: 'Portrait' }]} />
          </div>
          <div>
            <label>Service hours</label>
            <SearchSelect value={serviceHoursId} onChange={setServiceHoursId} allowEmpty placeholder="—"
              options={serviceHours.map((o) => ({ value: o.id, label: o.name ?? o.id }))} />
          </div>
          <div>
            <label>Warranty</label>
            <SearchSelect value={warrantyId} onChange={setWarrantyId} allowEmpty placeholder="—"
              options={warranties.map((o) => ({ value: o.id, label: o.name ?? o.id }))} />
          </div>
          <div>
            <label>Install method</label>
            <SearchSelect value={installMethodId} onChange={setInstallMethodId} allowEmpty placeholder="—"
              options={installMethods.map((o) => ({ value: o.id, label: o.name ?? o.id }))} />
          </div>
        </div>
        {outOfHours && (
          <p className="muted" style={{ marginBottom: 0 }}>Out-of-hours service hours selected — an out-of-hours labour uplift will be added on save (F31).</p>
        )}
      </div>

      {LCD_SECTIONS.map((def) => {
        const opts = catFor(def);
        const secLines = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.sectionKey === def.key);
        const subtotal = secLines.reduce((a, { l }) => a + sellOf(l) * l.qty, 0);
        return (
          <div className="card" key={def.key}>
            <h3 style={{ marginTop: 0, display: 'flex', justifyContent: 'space-between' }}>
              <span>{def.title}</span>
              <span className="muted">{quote.currency?.code} {subtotal.toLocaleString()}</span>
            </h3>
            <div className="grid3">
              <div style={{ gridColumn: 'span 2' }}>
                <label>Catalog item</label>
                <SearchSelect value={pick[def.key] ?? ''} onChange={(v) => setPick((p) => ({ ...p, [def.key]: v }))} allowEmpty
                  placeholder={`Search ${def.title.toLowerCase()}…`}
                  options={opts.map((d) => ({ value: d.id, label: `${d.model}${d.sell ? ` ($${d.sell})` : ''}` }))} />
              </div>
              <div>
                <label>Qty</label>
                <input type="number" min="1" value={pickQty[def.key] ?? '1'} onChange={(e) => setPickQty((q) => ({ ...q, [def.key]: e.target.value }))} />
              </div>
            </div>
            <div className="step-actions" style={{ gap: 8, flexWrap: 'wrap' }}>
              <button onClick={() => addCatalog(def)} disabled={!pick[def.key]}>+ Add item</button>
              {def.allowManual && <button onClick={() => addManual(def)}>+ Manual row</button>}
              {(LCD_MANUAL_TEMPLATES[def.key] ?? []).map((tpl) => (
                <button key={tpl.description} onClick={() => addManual(def, tpl)} title={`$${tpl.unitCost} cost`}>+ {tpl.description}</button>
              ))}
            </div>
            {secLines.map(({ l, i }) => (
              <div className="list-row" key={i} style={{ gap: 8, alignItems: 'center' }}>
                {l.manual ? (
                  <>
                    <input style={{ flex: 1 }} value={l.description} placeholder="Description" onChange={(e) => updateLine(i, { description: e.target.value })} />
                    <input style={{ width: 90 }} type="number" value={l.unitCost ?? 0} title="Unit cost" onChange={(e) => updateLine(i, { unitCost: Number(e.target.value) })} />
                  </>
                ) : (
                  <span style={{ flex: 1 }}>{l.description}</span>
                )}
                <input style={{ width: 64 }} type="number" min="1" value={l.qty} onChange={(e) => updateLine(i, { qty: Number(e.target.value) || 1 })} />
                <span style={{ width: 100, textAlign: 'right' }}>{quote.currency?.code} {(sellOf(l) * l.qty).toLocaleString()}</span>
                <button onClick={() => removeLine(i)} aria-label="Remove">✕</button>
              </div>
            ))}
          </div>
        );
      })}

      <div className="card">
        <div className="list-row" style={{ fontWeight: 600 }}>
          <span>Screen total (at fixed margin, rounded)</span>
          <span>{quote.currency?.code} {grand.toLocaleString()}</span>
        </div>
        <div className="step-actions">
          <button className="primary" onClick={save} disabled={busy || lines.length === 0}>+ Add LCD screen</button>
        </div>
      </div>
    </div>
  );
}

// Form 2 (U1): per-screen secondary options & services, shown after an LED screen is finalised and
// tied to that screen. Pre-filled from the screen's stored FK scalars + housing/notes; saved via
// PATCH /quotes/:id/led-screens/:screenId which re-prices the screen.
function LedOptionsEditor({ quote, screen, onChange }: { quote: Quote; screen: LedScreen; onChange: () => Promise<void> }) {
  const canWrite = getRole() !== 'viewer';
  const [optionRows, setOptionRows] = useState<Record<LedOptionKey, Opt[]>>(
    () => Object.fromEntries(LED_OPTION_TABLES.map((t) => [t.key, [] as Opt[]])) as unknown as Record<LedOptionKey, Opt[]>,
  );
  // Pre-fill each option field from the screen's stored FK scalar.
  const initial = (): Record<LedOptionKey, string> =>
    Object.fromEntries(
      LED_OPTION_TABLES.map((t) => {
        const v = (screen as unknown as Record<string, unknown>)[t.key];
        return [t.key, v != null ? String(v) : ''];
      }),
    ) as unknown as Record<LedOptionKey, string>;
  const [selected, setSelected] = useState<Record<LedOptionKey, string>>(initial);
  const [backCover, setBackCover] = useState(!!screen.backCover);
  const [frameNote, setFrameNote] = useState(screen.frameNote ?? '');
  const [serviceDescriptionSuffix, setServiceDescriptionSuffix] = useState(screen.serviceDescriptionSuffix ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    Promise.all(
      LED_OPTION_TABLES.map((t) =>
        api<{ rows: Opt[] }>(`/admin/${t.slug}?take=200&activeOnly=true`)
          .then((r) => [t.key, r.rows] as const)
          .catch(() => [t.key, [] as Opt[]] as const),
      ),
    ).then((entries) => setOptionRows(Object.fromEntries(entries) as unknown as Record<LedOptionKey, Opt[]>));
  }, []);

  const save = async () => {
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      const body: Record<string, unknown> = {
        backCover,
        frameNote: frameNote.trim() ? frameNote.trim() : null,
        serviceDescriptionSuffix: serviceDescriptionSuffix.trim() ? serviceDescriptionSuffix.trim() : null,
      };
      for (const t of LED_OPTION_TABLES) body[t.key] = selected[t.key] ? Number(selected[t.key]) : null;
      await api(`/quotes/${quote.id}/led-screens/${screen.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      setSaved(true);
      await onChange();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed var(--border)' }}>
      <p className="muted" style={{ marginTop: 0 }}>
        Options &amp; services for this screen — all optional. Saving re-prices the screen.
      </p>
      <div className="grid3">
        {LED_OPTION_TABLES.map((t) => (
          <div key={t.key}>
            <label>{t.label}</label>
            <SearchSelect
              value={selected[t.key]}
              onChange={(v) => { setSelected((p) => ({ ...p, [t.key]: v })); setSaved(false); }}
              allowEmpty
              placeholder={`Select ${t.label.toLowerCase()}…`}
              options={(optionRows[t.key] ?? []).map((o) => ({ value: o.id, label: o.name ?? o.model ?? '' }))}
              disabled={!canWrite}
            />
          </div>
        ))}
      </div>
      <h4 style={{ margin: '14px 0 4px' }}>Housing &amp; descriptions</h4>
      <div className="grid3">
        <div>
          <label>Back cover</label>
          <input type="checkbox" checked={backCover} disabled={!canWrite} onChange={(e) => { setBackCover(e.target.checked); setSaved(false); }} style={{ width: 'auto' }} />
        </div>
        <div>
          <label>Frame / housing description</label>
          <input value={frameNote} disabled={!canWrite} onChange={(e) => { setFrameNote(e.target.value); setSaved(false); }} placeholder="optional" />
        </div>
        <div>
          <label>Service description suffix</label>
          <input value={serviceDescriptionSuffix} disabled={!canWrite} onChange={(e) => { setServiceDescriptionSuffix(e.target.value); setSaved(false); }} placeholder="optional" />
        </div>
      </div>
      {err && <div className="error" style={{ marginTop: 8 }}>{err}</div>}
      {canWrite && (
        <div className="row-actions" style={{ alignItems: 'center', marginTop: 10 }}>
          <button className="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save options & re-price'}</button>
          {saved && <span style={{ color: 'var(--ok, #16a34a)' }}>✓ Saved &amp; re-priced</span>}
        </div>
      )}
    </div>
  );
}

// Merged "Select Screens" step (U1): a LED/LCD type selector drives which add-flow shows; below, a
// combined list of every screen on the quote (LED + LCD), each labelled by type, with per-screen
// controls (LED: qty/duplicate/reorder/delete + expandable Options & services editor; LCD as today).
function SelectScreensStep({ quote, onChange }: { quote: Quote; onChange: () => Promise<void> }) {
  const canWrite = getRole() !== 'viewer';
  const [screenType, setScreenType] = useState<'LED' | 'LCD'>('LED');
  const [expanded, setExpanded] = useState<string | null>(null);
  const cur = quote.currency?.code ?? '';

  // LED list management.
  const removeLed = async (sid: string) => {
    await api(`/quotes/${quote.id}/led-screens/${sid}`, { method: 'DELETE' });
    await onChange();
  };
  const setLedQty = async (sid: string, qty: number) => {
    if (!(qty >= 1)) return;
    await api(`/quotes/${quote.id}/led-screens/${sid}/qty`, { method: 'PATCH', body: JSON.stringify({ qty }) });
    await onChange();
  };
  const duplicateLed = async (sid: string) => {
    await api(`/quotes/${quote.id}/led-screens/${sid}/duplicate`, { method: 'POST', body: JSON.stringify({}) });
    await onChange();
  };
  const moveLed = async (index: number, dir: -1 | 1) => {
    const ids = quote.ledScreens.map((s) => Number(s.id));
    const target = index + dir;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    await api(`/quotes/${quote.id}/led-screens/reorder`, { method: 'POST', body: JSON.stringify({ orderedIds: ids }) });
    await onChange();
  };

  const totalScreens = quote.ledScreens.length + quote.lcdScreens.length;

  return (
    <div>
      <div className="card">
        <div className="topbar">
          <h3 style={{ margin: 0 }}>Select Screens</h3>
          {canWrite && (
            <div style={{ display: 'flex', gap: 8 }}>
              <button className={screenType === 'LED' ? 'primary' : 'ghost'} onClick={() => setScreenType('LED')}>LED</button>
              <button className={screenType === 'LCD' ? 'primary' : 'ghost'} onClick={() => setScreenType('LCD')}>LCD</button>
            </div>
          )}
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
          Pick a screen type, then add screens with the {screenType} flow below. All screens on this
          quote appear in the combined list.
        </p>
      </div>

      {canWrite && screenType === 'LED' && <LedAddForm quote={quote} onChange={onChange} />}
      {canWrite && screenType === 'LCD' && <LcdAddForm quote={quote} onChange={onChange} />}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Screens on this quote ({totalScreens})</h3>
        {totalScreens === 0 && <p className="muted">None yet — this step is optional.</p>}

        {quote.ledScreens.map((s, i) => (
          <div key={`led-${s.id}`} style={{ borderBottom: '1px solid var(--border)', paddingBottom: 10, marginBottom: 10 }}>
            <div className="list-row">
              <div>
                <span className="pill" style={{ marginRight: 6 }}>LED</span>
                <b>{s.screenName || 'LED screen'}</b>{' '}
                <span className="muted">
                  {[
                    s.resolutionWpx && s.resolutionHpx ? `${s.resolutionWpx}×${s.resolutionHpx}px` : '',
                    s.orientation ?? '',
                    s.aspectRatio?.ratioLabel ?? '',
                  ].filter(Boolean).join(' · ')}
                </span>
              </div>
              <div className="row-actions">
                <button className="ghost" title="Move up" disabled={!canWrite || i === 0} onClick={() => moveLed(i, -1)}>▲</button>
                <button className="ghost" title="Move down" disabled={!canWrite || i === quote.ledScreens.length - 1} onClick={() => moveLed(i, 1)}>▼</button>
                <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 4, margin: 0 }}>
                  Qty
                  <input
                    type="number"
                    min={1}
                    defaultValue={s.qty}
                    disabled={!canWrite}
                    style={{ width: 60 }}
                    onBlur={(e) => { const v = Number(e.target.value); if (v !== s.qty) setLedQty(s.id, v); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                  />
                </label>
                <span>{cur} {(Number(s.priceTotal ?? 0) * s.qty).toLocaleString()}</span>
                <button className="ghost" onClick={() => setExpanded(expanded === s.id ? null : s.id)}>
                  {expanded === s.id ? '▴ Options & services' : '▾ Options & services'}
                </button>
                {canWrite && <button className="ghost" onClick={() => duplicateLed(s.id)}>Duplicate</button>}
                {canWrite && <button className="danger" onClick={() => removeLed(s.id)}>Delete</button>}
              </div>
            </div>
            {expanded === s.id && <LedOptionsEditor quote={quote} screen={s} onChange={onChange} />}
          </div>
        ))}

        {quote.lcdScreens.map((s) => (
          <div className="list-row" key={`lcd-${s.id}`}>
            <div>
              <span className="pill" style={{ marginRight: 6 }}>LCD</span>
              <b>{s.screenName || 'LCD screen'}</b>
            </div>
            <span>{cur} {Number(s.priceTotal ?? 0).toLocaleString()}</span>
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
interface PriceSection {
  type: 'led' | 'lcd' | 'licence'; name: string; lines: PriceLine[]; total: string;
  overridden?: boolean; targetId?: string; computedTotal?: string;
}
interface OverrideSummary {
  id: string; targetType: string; targetId: string | null; fieldName: string;
  originalValue: string; overrideValue: string; reason: string | null;
  createdBy: { id: string; name: string } | null; createdAt: string;
}
interface PriceResult {
  costVisible: boolean;
  sections: PriceSection[];
  overrides?: OverrideSummary[];
  hasOverrides?: boolean;
  licences: Array<{ screenType: string; tier: string; qty: number; isInteractive: boolean; annual: string }>;
  // U3/U5 — effective client discount; `scope` decides the base (one-off upfront vs every renewal).
  discount?: { pct: number; source: 'quote' | 'client' | 'system'; scope?: 'one_off' | 'recurring'; amount: string };
  totals: {
    equipment: string; services: string; recurring: string; grandTotal: string;
    margin: string | null; marginFloor: number | null;
  };
}
interface OverrideResult { override: OverrideSummary; warning: string | null }

// Two-stage Review & Approval (T1 / BR-001). A review is a reviewer's decision at one stage,
// recorded against the revision (lockVersion) it was signed off on; history is preserved.
interface Review {
  id: string;
  stage: 'technical' | 'commercial';
  decision: 'approved' | 'rejected';
  lockVersion: number;
  comment: string | null;
  reviewer: { id: string; name: string } | null;
  createdAt: string;
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
  // Two-stage Review & Approval (T1): history + per-stage comment drafts + busy flag.
  const [reviews, setReviews] = useState<Review[]>([]);
  const [reviewComment, setReviewComment] = useState<{ technical: string; commercial: string }>({ technical: '', commercial: '' });
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [price, setPrice] = useState<PriceResult | null>(null);
  const [pricing, setPricing] = useState(false);
  const [priceError, setPriceError] = useState<string | null>(null);
  // Manual price overrides (P1-17): which screen is being edited + its draft value + last warning.
  const [editOverride, setEditOverride] = useState<string | null>(null);
  const [overrideDraft, setOverrideDraft] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [overrideWarning, setOverrideWarning] = useState<string | null>(null);
  const [overrideBusy, setOverrideBusy] = useState(false);
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

  // Assumptions & risks register (T4): assumptions reuse `assumptionsText` above; risks are an
  // editable table here. High-severity risks are highlighted; flows into the proposal PDF + PM handoff.
  const [risks, setRisks] = useState<Risk[]>([]);
  const [risksSaving, setRisksSaving] = useState(false);
  const [risksSaved, setRisksSaved] = useState(false);
  const [risksError, setRisksError] = useState<string | null>(null);

  // Per-job documents + re-run (P1-19e).
  const [docs, setDocs] = useState<QuoteDoc[]>([]);
  const [uploading, setUploading] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);
  const [rerunning, setRerunning] = useState(false);
  const [rerunNote, setRerunNote] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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

  const loadRisks = useCallback(() => {
    api<Risk[]>(`/quotes/${quote.id}/risks`)
      .then(setRisks)
      .catch(() => setRisksError('Could not load risks'));
  }, [quote.id]);

  const updateRisk = (i: number, patch: Partial<Risk>) => {
    setRisks((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
    setRisksSaved(false);
  };
  const addRisk = () => {
    setRisks((rs) => [...rs, { category: 'technical', description: '', severity: 'medium', mitigation: '' }]);
    setRisksSaved(false);
  };
  const removeRisk = (i: number) => {
    setRisks((rs) => rs.filter((_, idx) => idx !== i));
    setRisksSaved(false);
  };

  const saveRisks = async () => {
    setRisksSaving(true);
    setRisksError(null);
    setRisksSaved(false);
    const payload = {
      risks: risks
        .filter((r) => r.description.trim().length > 0)
        .map((r) => ({
          category: r.category,
          description: r.description.trim(),
          severity: r.severity,
          mitigation: r.mitigation && r.mitigation.trim() ? r.mitigation.trim() : undefined,
        })),
    };
    try {
      await api(`/quotes/${quote.id}/risks`, { method: 'PUT', body: JSON.stringify(payload) });
      setRisksSaved(true);
      loadRisks();
      loadAudit();
    } catch (e) {
      setRisksError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setRisksSaving(false);
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

  // ── Manual price overrides (P1-17.3) ──
  const overrideFor = (targetId?: string): OverrideSummary | undefined =>
    targetId ? price?.overrides?.find((o) => o.targetType === 'led_screen_price' && o.targetId === targetId) : undefined;

  const saveOverride = async (targetId: string) => {
    const value = Number(overrideDraft);
    if (!(Number.isFinite(value) && value >= 0)) {
      setOverrideWarning('Enter a non-negative number.');
      return;
    }
    setOverrideBusy(true);
    setOverrideWarning(null);
    try {
      const res = await api<OverrideResult>(`/quotes/${quote.id}/overrides`, {
        method: 'POST',
        body: JSON.stringify({ targetType: 'led_screen_price', targetId: Number(targetId), value, reason: overrideReason || undefined }),
      });
      setEditOverride(null);
      setOverrideReason('');
      setOverrideWarning(res.warning); // null clears; a below-floor warning shows.
      await loadPrice(); // re-price → refreshes sections + flags + totals.
      await onChange();  // refresh the parent quote (LED step totals).
    } catch (e) {
      setOverrideWarning(e instanceof Error ? e.message : 'Override failed');
    } finally {
      setOverrideBusy(false);
    }
  };

  const clearOverride = async (overrideId: string) => {
    setOverrideBusy(true);
    setOverrideWarning(null);
    try {
      await api(`/quotes/${quote.id}/overrides/${overrideId}`, { method: 'DELETE' });
      await loadPrice();
      await onChange();
    } catch (e) {
      setOverrideWarning(e instanceof Error ? e.message : 'Clear failed');
    } finally {
      setOverrideBusy(false);
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
  const loadDocs = useCallback(() => {
    api<QuoteDoc[]>(`/quotes/${quote.id}/documents`).then(setDocs).catch(() => setDocs([]));
  }, [quote.id]);
  const loadReviews = useCallback(() => {
    api<Review[]>(`/quotes/${quote.id}/reviews`).then(setReviews).catch(() => setReviews([]));
  }, [quote.id]);

  useEffect(() => {
    loadAudit();
    loadVersions();
    loadValidation();
    loadTerms();
    loadRisks();
    loadDocs();
    loadReviews();
  }, [loadAudit, loadVersions, loadValidation, loadTerms, loadRisks, loadDocs, loadReviews]);

  // Record a technical/commercial review decision (T1). Advances or kicks back the workflow server-side.
  const recordReview = async (stage: 'technical' | 'commercial', decision: 'approved' | 'rejected') => {
    setReviewBusy(true);
    setReviewError(null);
    try {
      await api(`/quotes/${quote.id}/reviews`, {
        method: 'POST',
        body: JSON.stringify({ stage, decision, comment: reviewComment[stage] || undefined }),
      });
      setReviewComment((p) => ({ ...p, [stage]: '' }));
      await onChange();
      loadReviews();
      loadAudit();
    } catch (e) {
      setReviewError(e instanceof Error ? e.message : 'Review failed');
    } finally {
      setReviewBusy(false);
    }
  };

  const uploadDoc = async (file: File) => {
    setUploading(true);
    setDocError(null);
    try {
      await uploadFile<QuoteDoc>(`/quotes/${quote.id}/documents`, file);
      loadDocs();
      loadAudit();
    } catch (e) {
      setDocError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const deleteDoc = async (docId: string) => {
    if (!window.confirm('Delete this document? This cannot be undone.')) return;
    setDocError(null);
    try {
      await api(`/quotes/${quote.id}/documents/${docId}`, { method: 'DELETE' });
      loadDocs();
      loadAudit();
    } catch (e) {
      setDocError(e instanceof Error ? e.message : 'Delete failed');
    }
  };

  const rerun = async () => {
    setRerunning(true);
    setRerunNote(null);
    try {
      const v = await api<Version>(`/quotes/${quote.id}/rerun`, { method: 'POST' });
      setRerunNote(`Re-ran — saved v${v.revisionNo}${v.label ? `: ${v.label}` : ''}`);
      await onChange();
      loadVersions();
      loadAudit();
      loadValidation();
    } catch (e) {
      setRerunNote(e instanceof Error ? e.message : 'Re-run failed');
    } finally {
      setRerunning(false);
    }
  };

  const fmtBytes = (n: number): string => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  };

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
            {overrideWarning && <div className="error" style={{ marginTop: 10 }}>⚠️ {overrideWarning}</div>}
            {price.sections.length === 0 && <p className="muted">No priced lines yet.</p>}
            {price.sections.map((sec, si) => {
              const ov = overrideFor(sec.targetId);
              const editable = sec.type === 'led' && sec.targetId && canWrite;
              return (
              <div key={si} style={{ marginBottom: 14 }}>
                <div className="topbar">
                  <b>
                    {sec.name} <span className="muted">· {sec.type.toUpperCase()}</span>
                    {sec.overridden && ov && (
                      <span
                        className="pill"
                        style={{ marginLeft: 8, background: 'var(--warn-bg, #fef3c7)', color: 'var(--warn-fg, #92400e)' }}
                        title={`Override: computed ${cur} ${Number(ov.originalValue).toLocaleString()} → ${cur} ${Number(ov.overrideValue).toLocaleString()}\nBy ${ov.createdBy?.name ?? 'unknown'}${ov.reason ? `\nReason: ${ov.reason}` : ''}`}
                      >
                        🚩 Overridden
                      </span>
                    )}
                  </b>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {sec.overridden && sec.computedTotal && (
                      <span className="muted" style={{ textDecoration: 'line-through' }}>
                        {cur} {Number(sec.computedTotal).toLocaleString()}
                      </span>
                    )}
                    <span>{cur} {Number(sec.total).toLocaleString()}</span>
                    {editable && editOverride !== sec.targetId && (
                      <button
                        className="ghost"
                        onClick={() => { setEditOverride(sec.targetId!); setOverrideDraft(sec.total); setOverrideReason(ov?.reason ?? ''); setOverrideWarning(null); }}
                      >
                        {sec.overridden ? 'Edit override' : 'Override price'}
                      </button>
                    )}
                    {sec.overridden && ov && canWrite && (
                      <button className="danger" disabled={overrideBusy} onClick={() => clearOverride(ov.id)}>Clear</button>
                    )}
                  </span>
                </div>
                {editable && editOverride === sec.targetId && (
                  <div className="list-row" style={{ alignItems: 'center', gap: 8, marginTop: 6 }}>
                    <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 4, margin: 0 }}>
                      Sell price ({cur})
                      <input type="number" min={0} step="0.01" value={overrideDraft} style={{ width: 120 }}
                        onChange={(e) => setOverrideDraft(e.target.value)} />
                    </label>
                    <input type="text" placeholder="Reason (optional)" value={overrideReason} style={{ flex: 1, minWidth: 160 }}
                      onChange={(e) => setOverrideReason(e.target.value)} />
                    <button className="primary" disabled={overrideBusy} onClick={() => saveOverride(sec.targetId!)}>
                      {overrideBusy ? 'Saving…' : 'Apply'}
                    </button>
                    <button className="ghost" disabled={overrideBusy} onClick={() => { setEditOverride(null); setOverrideWarning(null); }}>Cancel</button>
                  </div>
                )}
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
              );
            })}
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
              {price.discount && price.discount.pct > 0 && (
                <div className="stat">
                  <div className="label">
                    Discount ({(price.discount.pct * 100).toFixed(price.discount.pct * 100 % 1 ? 1 : 0)}% · {price.discount.scope === 'recurring' ? 'per renewal' : 'one-off'})
                  </div>
                  <div className="value" style={{ color: 'var(--danger, #dc2626)' }}>
                    − {cur} {Number(price.discount.amount).toLocaleString()}
                  </div>
                </div>
              )}
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
        <div className="topbar">
          <h3 style={{ margin: 0 }}>Files &amp; re-run</h3>
          {canWrite && (
            <button className="primary" onClick={rerun} disabled={rerunning}>
              {rerunning ? 'Re-running…' : '↻ Re-run'}
            </button>
          )}
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
          Attach supporting files (briefs, drawings, emails…) to this job. Re-run recomputes the quote
          from its current inputs and saves a new version with a change summary (P1-19e).
        </p>
        {canWrite && (
          <div className="row-actions" style={{ alignItems: 'center' }}>
            <input
              ref={fileInputRef}
              type="file"
              disabled={uploading}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void uploadDoc(f);
              }}
            />
            {uploading && <span className="muted">Uploading…</span>}
          </div>
        )}
        {docError && <div className="error" style={{ marginTop: 10 }}>{docError}</div>}
        {rerunNote && <div className="muted" style={{ marginTop: 10 }}>{rerunNote}</div>}
        {docs.length === 0 ? (
          <p className="muted" style={{ marginTop: 12 }}>No files uploaded yet.</p>
        ) : (
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table>
              <thead>
                <tr>
                  <th>Name</th><th className="cell-num">Version</th><th className="cell-num">Size</th>
                  <th>Uploaded by</th><th>When</th><th></th>
                </tr>
              </thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.id}>
                    <td>{d.originalName}</td>
                    <td className="cell-num">v{d.version}</td>
                    <td className="cell-num">{fmtBytes(d.sizeBytes)}</td>
                    <td className="muted">{d.uploadedBy?.name ?? '—'}</td>
                    <td className="muted">{new Date(d.createdAt).toLocaleString()}</td>
                    <td className="actions">
                      <button
                        className="ghost"
                        onClick={() => downloadFile(`/quotes/${quote.id}/documents/${d.id}/download`, d.originalName)}
                      >
                        ⬇ Download
                      </button>
                      {canWrite && (
                        <button className="danger" onClick={() => deleteDoc(d.id)}>Delete</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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

      <div className="card" style={{ borderLeft: '4px solid var(--accent, #6d6bf6)' }}>
        <h3 style={{ marginTop: 0 }}>Assumptions &amp; risks</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          Manual register highlighted before finalisation. Assumptions come from the proposal text
          above (Assumptions group); risks are captured here. Both flow into the proposal PDF and the
          PM handoff. High-severity risks are highlighted.
        </p>

        <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>Assumptions</label>
        {(() => {
          const items = assumptionsText.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
          return items.length > 0 ? (
            <ul style={{ marginTop: 0, paddingLeft: 18, fontSize: 13 }}>
              {items.map((a, i) => <li key={i}>{a}</li>)}
            </ul>
          ) : (
            <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
              No assumptions captured — edit the Assumptions group in Proposal text above.
            </p>
          );
        })()}

        <label style={{ display: 'block', fontWeight: 600, margin: '14px 0 6px' }}>Risks</label>
        {risks.length === 0 && (
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>No risks captured yet.</p>
        )}
        {risks.length > 0 && (
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left' }}>
                <th style={{ width: 120 }}>Category</th>
                <th>Description</th>
                <th style={{ width: 110 }}>Severity</th>
                <th>Mitigation</th>
                {canWrite && <th style={{ width: 32 }} />}
              </tr>
            </thead>
            <tbody>
              {risks.map((r, i) => {
                const high = r.severity === 'high';
                return (
                  <tr key={i} style={high ? { background: 'rgba(220,38,38,0.08)' } : undefined}>
                    <td>
                      <select value={r.category} disabled={!canWrite} onChange={(e) => updateRisk(i, { category: e.target.value as Risk['category'] })} style={{ width: '100%' }}>
                        <option value="technical">technical</option>
                        <option value="commercial">commercial</option>
                        <option value="delivery">delivery</option>
                      </select>
                    </td>
                    <td>
                      <input value={r.description} disabled={!canWrite} onChange={(e) => updateRisk(i, { description: e.target.value })} placeholder="Describe the risk…" style={{ width: '100%' }} />
                    </td>
                    <td>
                      <select
                        value={r.severity}
                        disabled={!canWrite}
                        onChange={(e) => updateRisk(i, { severity: e.target.value as Risk['severity'] })}
                        style={{ width: '100%', fontWeight: high ? 700 : 400, color: high ? 'var(--danger, #dc2626)' : undefined }}
                      >
                        <option value="low">low</option>
                        <option value="medium">medium</option>
                        <option value="high">high</option>
                      </select>
                    </td>
                    <td>
                      <input value={r.mitigation ?? ''} disabled={!canWrite} onChange={(e) => updateRisk(i, { mitigation: e.target.value })} placeholder="(optional)" style={{ width: '100%' }} />
                    </td>
                    {canWrite && (
                      <td>
                        <button className="danger" onClick={() => removeRisk(i)} title="Remove risk">✕</button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {canWrite && (
          <div className="row-actions" style={{ alignItems: 'center', marginTop: 10 }}>
            <button onClick={addRisk}>+ Add risk</button>
            <button className="primary" onClick={saveRisks} disabled={risksSaving}>
              {risksSaving ? 'Saving…' : 'Save risks'}
            </button>
            {risksSaved && <span style={{ color: 'var(--ok, #16a34a)' }}>✓ Saved</span>}
            {risksError && <span style={{ color: 'var(--danger, #dc2626)' }}>{risksError}</span>}
          </div>
        )}
        {!canWrite && risksError && <div className="error" style={{ marginTop: 10 }}>{risksError}</div>}
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

      {(() => {
        // BR-001 gate: issuing requires an `approved` review at BOTH stages for the CURRENT revision.
        // A review only counts for the lockVersion it was signed off on (editing re-arms the gate).
        const approvedFor = (stage: 'technical' | 'commercial') =>
          reviews.some((r) => r.stage === stage && r.decision === 'approved' && r.lockVersion === quote.lockVersion);
        const techApproved = approvedFor('technical');
        const commApproved = approvedFor('commercial');
        const bothApproved = techApproved && commApproved;
        const stageBadge = (ok: boolean) => (
          <span className="pill" style={{ background: ok ? 'var(--ok, #dcfce7)' : 'var(--warn, #fef3c7)', color: ok ? '#166534' : '#92400e' }}>
            {ok ? '✓ approved' : 'pending'}
          </span>
        );
        const stagePanel = (stage: 'technical' | 'commercial', ok: boolean) => (
          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <b style={{ textTransform: 'capitalize' }}>{stage} review</b>
              {stageBadge(ok)}
            </div>
            {canWrite ? (
              <>
                <textarea
                  rows={2}
                  placeholder="Comment (optional)"
                  value={reviewComment[stage]}
                  onChange={(e) => setReviewComment((p) => ({ ...p, [stage]: e.target.value }))}
                  style={{ width: '100%' }}
                />
                <div className="row-actions" style={{ marginTop: 6 }}>
                  <button className="primary" disabled={reviewBusy} onClick={() => recordReview(stage, 'approved')}>Approve</button>
                  <button className="danger" disabled={reviewBusy} onClick={() => recordReview(stage, 'rejected')}>Reject</button>
                </div>
              </>
            ) : (
              <p className="muted" style={{ margin: 0 }}>Review actions are restricted to admin/sales.</p>
            )}
          </div>
        );
        return (
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Review &amp; approval</h3>
            <p className="muted" style={{ marginTop: 0 }}>
              BR-001: a quote must pass a technical review then a commercial review before it can be issued.
              Approvals count only for the current revision (v{quote.lockVersion}).
            </p>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              {stagePanel('technical', techApproved)}
              {stagePanel('commercial', commApproved)}
            </div>
            {reviewError && <div className="error" style={{ marginTop: 10 }}>{reviewError}</div>}

            {reviews.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <h4 style={{ margin: '0 0 6px' }}>Approval history</h4>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr><th>Stage</th><th>Decision</th><th>Reviewer</th><th>Revision</th><th>Comment</th><th>When</th></tr>
                    </thead>
                    <tbody>
                      {reviews.map((r) => (
                        <tr key={r.id}>
                          <td style={{ textTransform: 'capitalize' }}>{r.stage}</td>
                          <td style={{ color: r.decision === 'approved' ? '#166534' : 'var(--danger, #dc2626)' }}>{r.decision}</td>
                          <td>{r.reviewer?.name ?? '—'}</td>
                          <td>v{r.lockVersion}</td>
                          <td>{r.comment ?? '—'}</td>
                          <td className="muted">{new Date(r.createdAt).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <h3 style={{ margin: '18px 0 0' }}>Workflow</h3>
            <div className="row-actions">
              <button onClick={() => setStatus('in_review')}>Send to review</button>
              <button onClick={() => setStatus('technical_review')}>Start technical review</button>
              <button
                onClick={() => setStatus('approved')}
                disabled={!isAdmin && validation != null && !validation.canFinalise}
                title={!isAdmin && validation != null && !validation.canFinalise ? 'Resolve validation errors first' : undefined}
              >
                Approve
              </button>
              <button
                onClick={() => setStatus('issued')}
                disabled={!bothApproved || (!isAdmin && validation != null && !validation.canFinalise)}
                title={!bothApproved ? 'Both technical and commercial reviews must be approved for this revision before issuing (BR-001)' : (!isAdmin && validation != null && !validation.canFinalise ? 'Resolve validation errors first' : undefined)}
              >
                Issue
              </button>
            </div>
            {!bothApproved && (
              <div className="muted" style={{ marginTop: 8, fontSize: 13 }}>
                Issuing is blocked until both reviews are approved for revision v{quote.lockVersion}
                {techApproved !== commApproved ? ` (still need ${techApproved ? 'commercial' : 'technical'} approval).` : '.'} This is absolute — admins cannot bypass human review (BR-001).
              </div>
            )}
            {validation != null && !validation.canFinalise && (
              <div className="muted" style={{ marginTop: 8, fontSize: 13 }}>
                {isAdmin
                  ? `${validation.counts.error} validation error(s) present — you may override as admin (the override is audited).`
                  : `Finalisation is blocked: ${validation.counts.error} validation error(s) must be resolved.`}
              </div>
            )}
            {statusError && <div className="error" style={{ marginTop: 10 }}>{statusError}</div>}
          </div>
        );
      })()}

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
