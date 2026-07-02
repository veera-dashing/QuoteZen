'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { api, ApiError, downloadFile, getRole, uploadFile } from '@/lib/api';
import SearchSelect from '@/components/SearchSelect';

interface Opt { id: string; name?: string; model?: string; sell?: string | null; totalCost?: string | null; usd?: string | null; category?: string; code?: string; brand?: string | null }
// A stored LED component row (as returned on the screen) — carries the componentType + the one FK id.
interface LedComponent {
  id: string; componentType: string; qty: number;
  controllerId?: string | null; ledPeripheralId?: string | null;
  mediaplayerId?: string | null; peripheralId?: string | null;
}
interface LedScreen {
  id: string; screenName: string | null; qty: number;
  resolutionWpx: number | null; resolutionHpx: number | null; priceTotal: string | null;
  orientation?: string | null;
  aspectRatio?: { ratioLabel: string } | null;
  // Full-edit pre-fill (V4): the panel + geometry inputs finalised at add time.
  ledProductId?: string | null; desiredWidthMm?: number | null; desiredHeightMm?: number | null;
  rotateCabinets?: boolean; aspectRatioId?: string | null;
  recessDepthMm?: number | null; // AA1 — recess/cavity depth (mm)
  // The attached LED product (model) + its manufacturer, for the "Manufacturer - Model" row label.
  ledProduct?: { model: string; manufacturer?: { name: string } | null } | null;
  components?: LedComponent[];
  // Secondary options/services (Form 2) — raw FK scalars + housing/notes, used to pre-fill the editor.
  gobId?: string | null; frameId?: string | null; trimId?: string | null; hangingBarId?: string | null;
  engineeringId?: string | null; installMethodId?: string | null; freightOptionId?: string | null;
  warrantyId?: string | null; serviceHoursId?: string | null; accessEquipmentId?: string | null;
  coatingId?: string | null; highResolution?: boolean | null; // AA4 — coating + high-resolution add-ons
  backCover?: boolean; frameNote?: string | null; serviceDescriptionSuffix?: string | null;
  contentRatio?: string | null; contentSupplier?: string | null; flatnessRequired?: boolean | null;
}
// A stored LCD line item (as returned on the screen), used to pre-fill the LCD edit form.
interface LcdItem {
  id: string; itemType: LcdItemType; displayId?: string | null;
  description?: string | null; qty: number; unitCost?: string | null; unitSell?: string | null;
}
interface LcdScreen {
  id: string; screenName: string | null; priceTotal: string | null;
  // The attached display (model) for the row label.
  display?: { model: string } | null;
  // Full-edit pre-fill (V4).
  orientation?: string | null; displayId?: string | null;
  installMethodId?: string | null; serviceHoursId?: string | null; warrantyId?: string | null;
  recessDepthMm?: number | null; // AA1 — recess/cavity depth (mm)
  // AA3a — site/requirement fields (selection rules).
  requiresAndroid?: boolean | null; maxDepthMm?: number | null; needsPc?: boolean | null; needsHardDrive?: boolean | null;
  items?: LcdItem[];
}
interface Licence { id: string; screenType: string; tier: string; qty: number; isInteractive: boolean }
interface Quote {
  id: string; jobReference: string; status: string; lockVersion: number;
  clientId: string | null; locationId: string | null;
  // Resolved lookups (the API includes them) — used by the summary panel for display.
  client?: { name: string } | null; location?: { name: string } | null;
  // Uploaded quote documents (present when included) — the summary shows the count only.
  documents?: QuoteDoc[];
  // Quote-level PI / commercial fields (U1).
  requestedShippingDate?: string | null; siteAddress?: string | null; projectNotes?: string | null;
  // AA1 — site/context intake fields (one-per-quote site details).
  endCustomer?: string | null; airsideLandside?: string | null; sunExposure?: string | null;
  wallSubstrate?: string | null; powerDataAvailable?: string | null; controllerLocation?: string | null;
  windowFacing?: boolean | null;
  // AA5 — software/hardware dependency intake fields (Group E). Descriptive; no pricing impact.
  mediaPlayerSupply?: string | null; sharedDevicePlayers?: number | null; sharedDeviceScreens?: number | null;
  storeSizeSqm?: string | null; customContentCuration?: boolean | null;
  pcRequired?: boolean | null; hardDriveRequired?: boolean | null;
  // AA6a — commercial intake fields (Group F). Descriptive/advisory; no pricing impact.
  priceSensitivity?: 'budget' | 'balanced' | 'premium' | null;
  budgetAud?: string | null; tenureMonths?: number | null;
  clientMustHaves?: string | null; needsSolutionsEngineer?: boolean | null;
  discountPct?: string | null; // stored as a fraction 0..1
  discountNote?: string | null; // manager justification, required above 5%
  discountScope?: 'one_off' | 'recurring' | null; // U5 — upfront vs every renewal
  discountMode?: 'stack' | 'item_only' | null; // V2 — item+quote discount vs per-item only
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
  const searchParams = useSearchParams();
  // Unified create + edit: `/quotes/new` renders this same wizard with the Details step in CREATE mode
  // (no separate create page). On first save the Details step navigates to /quotes/:id?step=1.
  const isNew = id === 'new';
  const [quote, setQuote] = useState<Quote | null>(null);
  const [step, setStep] = useState(() => (isNew ? 0 : Number(searchParams.get('step')) || 0));
  const [error, setError] = useState<string | null>(null);
  // Collapsible Quote-summary panel — remembered across steps/quotes (handy on smaller screens).
  const [summaryOpen, setSummaryOpen] = useState(true);
  useEffect(() => {
    if (typeof window !== 'undefined') setSummaryOpen(window.localStorage.getItem('quotezen_summary_open') !== '0');
  }, []);
  const toggleSummary = useCallback((open: boolean) => {
    setSummaryOpen(open);
    if (typeof window !== 'undefined') window.localStorage.setItem('quotezen_summary_open', open ? '1' : '0');
  }, []);

  const refetch = useCallback(async () => {
    if (isNew) return;
    setQuote(await api<Quote>(`/quotes/${id}`));
  }, [id, isNew]);

  useEffect(() => {
    refetch().catch((e) => setError(e.message));
  }, [refetch]);

  if (error) return <div className="error">{error}</div>;
  if (!isNew && !quote) return <div className="muted">Loading…</div>;

  return (
    <div>
      <div className="topbar">
        <h1>
          {isNew ? 'New quote' : quote!.jobReference}{' '}
          {!isNew && <span className="pill status-badge">{quote!.status.replace('_', ' ')}</span>}
        </h1>
        {!isNew && (
          <span className="muted">
            {quote!.currency?.code} {Number(quote!.grandTotal).toLocaleString()}
          </span>
        )}
      </div>

      <div className="stepper">
        {STEPS.map((s, i) => {
          // In create mode only Details is reachable until the draft exists; later steps are disabled.
          const locked = isNew && i > 0;
          return (
            <div
              key={s}
              className={`step${i === step ? ' active' : ''}${locked ? ' disabled' : ''}`}
              style={locked ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
              onClick={() => { if (!locked) setStep(i); }}
            >
              {i + 1}. {s}
            </div>
          );
        })}
      </div>

      {/* In create mode there's no persisted quote yet, so the summary aside isn't shown. */}
      {isNew ? (
        <>{step === 0 && <DetailsStep quote={quote} onChange={refetch} />}</>
      ) : (
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ flex: '1 1 480px', minWidth: 0 }}>
            {!summaryOpen && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
                <button className="ghost" onClick={() => toggleSummary(true)} title="Show quote summary">
                  ◀ Summary
                </button>
              </div>
            )}
            {step === 0 && <DetailsStep quote={quote} onChange={refetch} />}
            {step === 1 && <SelectScreensStep quote={quote!} onChange={refetch} />}
            {step === 2 && <LicenceStep quote={quote!} onChange={refetch} />}
            {step === 3 && <ReviewStep quote={quote!} onChange={refetch} />}
          </div>
          {summaryOpen && <QuoteSummary quote={quote!} stepIndex={step} onHide={() => toggleSummary(false)} />}
        </div>
      )}

      {!isNew && (
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
      )}
    </div>
  );
}

// A small helper: money formatted with the quote's currency code (falls back to a plain number).
function fmtMoney(value: string | number | null | undefined, code?: string | null): string {
  const n = Number(value ?? 0);
  const s = n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return code ? `${code} ${s}` : s;
}

// A screen's display label: user-set name wins; else "LED/LCD <manufacturer?> - <model?>"; else "Screen N".
function ledSummaryLabel(s: LedScreen, i: number): string {
  if (s.screenName?.trim()) return s.screenName.trim();
  const mfr = s.ledProduct?.manufacturer?.name;
  const model = s.ledProduct?.model;
  if (model) return `LED ${mfr ? `${mfr} - ` : ''}${model}`;
  return `Screen ${i + 1}`;
}
function lcdSummaryLabel(s: LcdScreen, i: number): string {
  if (s.screenName?.trim()) return s.screenName.trim();
  const model = s.display?.model;
  if (model) return `LCD ${model}`;
  return `Screen ${i + 1}`;
}

// Persistent, stage-aware right-hand summary of the live quote. Read-only; purely reflects `quote`
// (+ the current step for emphasis). Shown only in edit mode (a real quote exists).
function QuoteSummary({ quote, stepIndex, onHide }: { quote: Quote; stepIndex: number; onHide?: () => void }) {
  // Discount cap/threshold from the admin-maintained policy (same shape DetailsStep fetches). Fetched
  // once here so the summary can flag over-cap without lifting state through the wizard.
  const [capPct, setCapPct] = useState(12);
  useEffect(() => {
    api<{ capPct: number; noteThresholdPct: number }>('/quotes/discount-policy')
      .then((p) => setCapPct(Math.round(p.capPct * 1000) / 10))
      .catch(() => {});
  }, []);

  const code = quote.currency?.code ?? null;
  const led = quote.ledScreens ?? [];
  const lcd = quote.lcdScreens ?? [];
  const lineCount = led.length + lcd.length;
  // Units = Σ screen qty (LED carries qty; LCD qty lives on item rows → default 1 per screen).
  const unitCount = led.reduce((a, s) => a + (Number(s.qty) || 1), 0) + lcd.length;
  const docCount = quote.documents?.length ?? 0;

  // Discount: quote-level %, or "—" when it inherits the client/system default.
  const discPctNum =
    quote.discountPct != null && quote.discountPct !== '' ? Number(quote.discountPct) * 100 : null;
  const discOverCap = discPctNum != null && discPctNum > capPct;

  // Completeness checklist — a sensible set of required fields; count satisfied vs total.
  const checks: boolean[] = [
    !!quote.jobReference?.trim(),                 // job reference set
    !!quote.clientId,                             // client set
    !!quote.locationId,                           // location set
    lineCount > 0,                                // at least one screen
    // each LED screen has product + width + height
    led.every((s) => s.ledProductId != null && (s.desiredWidthMm ?? 0) > 0 && (s.desiredHeightMm ?? 0) > 0),
    // each LCD screen has at least one display item
    lcd.every((s) => (s.items ?? []).some((it) => it.itemType === 'display' && it.displayId != null)),
  ];
  const satisfied = checks.filter(Boolean).length;
  const total = checks.length;
  const unsatisfied = total - satisfied;
  const pct = total === 0 ? 0 : Math.round((satisfied / total) * 100);

  // Stage-aware emphasis: which section gets the accent border for the current step.
  //  0 Details → Completeness + Discount · 1 Select Screens → Screens + Stats
  //  2 Licences → Totals · 3 Review → Totals + Completeness
  const emph = (section: 'stats' | 'screens' | 'discount' | 'completeness' | 'totals'): boolean => {
    switch (stepIndex) {
      case 0: return section === 'completeness' || section === 'discount';
      case 1: return section === 'screens' || section === 'stats';
      case 2: return section === 'totals';
      case 3: return section === 'totals' || section === 'completeness';
      default: return false;
    }
  };
  const accent = (on: boolean): CSSProperties =>
    on ? { borderLeft: '3px solid var(--accent)', paddingLeft: 11 } : {};

  const sectionTitle: CSSProperties = {
    fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em',
    color: 'var(--muted)', margin: '0 0 8px', fontWeight: 600,
  };

  const MAX_SCREENS = 8;
  const screenRows: Array<{ kind: 'LED' | 'LCD'; label: string }> = [
    ...led.map((s, i) => ({ kind: 'LED' as const, label: ledSummaryLabel(s, i) })),
    ...lcd.map((s, i) => ({ kind: 'LCD' as const, label: lcdSummaryLabel(s, i) })),
  ];

  return (
    <aside
      style={{
        // Prefer ~300px; may shrink (not grow) so it wraps cleanly and never overflows narrow viewports.
        flex: '1 1 300px', maxWidth: 340, minWidth: 240,
        position: 'sticky', top: 16, alignSelf: 'flex-start',
      }}
    >
      <div className="card" style={{ marginBottom: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>Quote summary</h3>
          {onHide && (
            <button className="ghost" onClick={onHide} title="Hide summary" aria-label="Hide summary" style={{ padding: '2px 8px' }}>
              ✕ Hide
            </button>
          )}
        </div>

        {/* 1 — identity */}
        <div style={{ marginBottom: 16 }}>
          <div className="list-row" style={{ padding: '5px 0' }}>
            <span className="muted">Client</span><span>{quote.client?.name ?? '—'}</span>
          </div>
          <div className="list-row" style={{ padding: '5px 0' }}>
            <span className="muted">Site</span>
            <span style={{ textAlign: 'right' }}>{quote.location?.name ?? quote.siteAddress ?? '—'}</span>
          </div>
          <div className="list-row" style={{ padding: '5px 0', borderBottom: 'none' }}>
            <span className="muted">Job ref</span><span>{quote.jobReference || '—'}</span>
          </div>
        </div>

        {/* 2 — stats */}
        <div style={{ ...accent(emph('stats')), marginBottom: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
            {[
              { label: 'Lines', value: lineCount },
              { label: 'Units', value: unitCount },
              { label: 'Docs', value: docCount },
            ].map((s) => (
              <div key={s.label} style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '8px 10px', textAlign: 'center' }}>
                <div style={{ fontSize: 18, fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>{s.value}</div>
                <div className="muted" style={{ fontSize: 11 }}>{s.label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* 3 — screens */}
        <div style={{ ...accent(emph('screens')), marginBottom: 16 }}>
          <p style={sectionTitle}>Screens</p>
          {screenRows.length === 0 ? (
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>No screens yet.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {screenRows.slice(0, MAX_SCREENS).map((r, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                  <span className="pill" style={{ fontSize: 10, padding: '0 6px', flex: '0 0 auto' }}>{r.kind}</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
                </div>
              ))}
              {screenRows.length > MAX_SCREENS && (
                <span className="muted" style={{ fontSize: 12 }}>+{screenRows.length - MAX_SCREENS} more</span>
              )}
            </div>
          )}
        </div>

        {/* 4 — discount */}
        <div style={{ ...accent(emph('discount')), marginBottom: 16 }}>
          <p style={sectionTitle}>Discount</p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>{discPctNum != null ? `${discPctNum}%` : '—'}</span>
            <span
              className="pill"
              style={{
                fontSize: 11,
                color: discOverCap ? 'var(--danger)' : 'var(--ok)',
                borderColor: discOverCap ? 'var(--danger)' : 'var(--ok)',
              }}
            >
              {discOverCap ? 'Over cap' : 'Within cap'}
            </span>
          </div>
          {quote.discountMode && (
            <p className="muted" style={{ margin: '4px 0 0', fontSize: 12 }}>
              Mode: {quote.discountMode === 'stack' ? 'Stack (item + quote)' : 'Per-item only'}
            </p>
          )}
        </div>

        {/* 5 — completeness */}
        <div style={{ ...accent(emph('completeness')), marginBottom: 16 }}>
          <p style={sectionTitle}>Completeness</p>
          <div style={{ height: 8, borderRadius: 999, background: 'var(--surface-2)', border: '1px solid var(--border)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: unsatisfied === 0 ? 'var(--ok)' : 'var(--accent)', transition: 'width 0.2s' }} />
          </div>
          <p className="muted" style={{ margin: '6px 0 0', fontSize: 13, color: unsatisfied === 0 ? 'var(--ok)' : undefined }}>
            {unsatisfied === 0 ? 'All required fields complete ✓' : `${unsatisfied} required left`}
          </p>
        </div>

        {/* 6 — totals */}
        <div style={{ ...accent(emph('totals')) }}>
          <p style={sectionTitle}>Totals</p>
          <div className="list-row" style={{ padding: '5px 0' }}>
            <span className="muted">Grand total</span>
            <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(quote.grandTotal, code)}</span>
          </div>
          {Number(quote.totalRecurring) > 0 && (
            <div className="list-row" style={{ padding: '5px 0', borderBottom: 'none' }}>
              <span className="muted">Recurring</span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(quote.totalRecurring, code)}</span>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

function DetailsStep({ quote, onChange }: { quote: Quote | null; onChange: () => Promise<void> }) {
  // Dual mode: `quote === null` → CREATE (no separate /quotes/new page); else EDIT the existing quote.
  const isNew = quote === null;
  const router = useRouter();
  const canWrite = getRole() !== 'viewer';
  const [jobReference, setJobReference] = useState(quote?.jobReference ?? '');
  const [clientId, setClientId] = useState(quote?.clientId ?? '');
  const [locationId, setLocationId] = useState(quote?.locationId ?? '');
  const [currencyCode, setCurrencyCode] = useState(quote?.currency?.code ?? 'AUD');
  // Project information / commercial (U1). discountPct is stored as a fraction (0..1) but shown as %.
  const [requestedShippingDate, setRequestedShippingDate] = useState(
    quote?.requestedShippingDate ? quote.requestedShippingDate.slice(0, 10) : '',
  );
  const [siteAddress, setSiteAddress] = useState(quote?.siteAddress ?? '');
  const [projectNotes, setProjectNotes] = useState(quote?.projectNotes ?? '');
  // AA1 — site/context intake fields (one-per-quote site details from the intake questionnaire).
  const [endCustomer, setEndCustomer] = useState(quote?.endCustomer ?? '');
  const [airsideLandside, setAirsideLandside] = useState(quote?.airsideLandside ?? '');
  const [sunExposure, setSunExposure] = useState(quote?.sunExposure ?? '');
  const [wallSubstrate, setWallSubstrate] = useState(quote?.wallSubstrate ?? '');
  const [powerDataAvailable, setPowerDataAvailable] = useState(quote?.powerDataAvailable ?? '');
  const [controllerLocation, setControllerLocation] = useState(quote?.controllerLocation ?? '');
  const [windowFacing, setWindowFacing] = useState<boolean>(quote?.windowFacing ?? false);
  // AA5 — software/hardware dependency intake fields (Group E).
  const [mediaPlayerSupply, setMediaPlayerSupply] = useState(quote?.mediaPlayerSupply ?? '');
  const [sharedDevicePlayers, setSharedDevicePlayers] = useState(
    quote?.sharedDevicePlayers != null ? String(quote.sharedDevicePlayers) : '',
  );
  const [sharedDeviceScreens, setSharedDeviceScreens] = useState(
    quote?.sharedDeviceScreens != null ? String(quote.sharedDeviceScreens) : '',
  );
  const [storeSizeSqm, setStoreSizeSqm] = useState(
    quote?.storeSizeSqm != null && quote.storeSizeSqm !== '' ? String(quote.storeSizeSqm) : '',
  );
  const [customContentCuration, setCustomContentCuration] = useState<boolean>(quote?.customContentCuration ?? false);
  const [pcRequired, setPcRequired] = useState<boolean>(quote?.pcRequired ?? false);
  const [hardDriveRequired, setHardDriveRequired] = useState<boolean>(quote?.hardDriveRequired ?? false);
  // AA6a — commercial intake fields (Group F).
  const [priceSensitivity, setPriceSensitivity] = useState(quote?.priceSensitivity ?? '');
  const [budgetAud, setBudgetAud] = useState(
    quote?.budgetAud != null && quote.budgetAud !== '' ? String(quote.budgetAud) : '',
  );
  const [tenureMonths, setTenureMonths] = useState(
    quote?.tenureMonths != null ? String(quote.tenureMonths) : '',
  );
  const [clientMustHaves, setClientMustHaves] = useState(quote?.clientMustHaves ?? '');
  const [needsSolutionsEngineer, setNeedsSolutionsEngineer] = useState<boolean>(quote?.needsSolutionsEngineer ?? false);
  const [discountPctInput, setDiscountPctInput] = useState(
    quote?.discountPct != null && quote.discountPct !== '' ? String(Number(quote.discountPct) * 100) : '',
  );
  // A+ discount guardrail: a manager note is required above the note threshold; the cap is a hard limit
  // for non-admins (admin-overridable). Both come from the admin-maintained DB settings (fetched below).
  const [discountNote, setDiscountNote] = useState(quote?.discountNote ?? '');
  const [capPct, setCapPct] = useState(12);
  const [noteThreshold, setNoteThreshold] = useState(5);
  const isAdmin = getRole() === 'admin';
  const discPctNum = discountPctInput.trim() === '' ? null : Number(discountPctInput);
  const needsNote = discPctNum != null && discPctNum > noteThreshold && !discountNote.trim();
  const overCap = discPctNum != null && discPctNum > capPct;
  const capBlocked = overCap && !isAdmin;
  const discountBlocked = needsNote || capBlocked;
  // Client + Location are mandatory on the Details step — gate save/auto-save until both are set.
  const detailsIncomplete = !clientId || !locationId;
  // Non-admins can't type above the cap (clamped). Admins MAY exceed it — no hard stop; a visible
  // warning banner flags it (so it isn't accidental) and the server audits the override.
  const onDiscountChange = (raw: string) => {
    if (!isAdmin && raw.trim() !== '' && Number(raw) > capPct) { setDiscountPctInput(String(capPct)); setDirty(true); return; }
    setDiscountPctInput(raw); setDirty(true);
  };
  // U5 — where the discount applies (one-off upfront vs every renewal).
  const [discountScope, setDiscountScope] = useState<'one_off' | 'recurring'>(
    quote?.discountScope === 'recurring' ? 'recurring' : 'one_off',
  );
  const [selectedViewers, setSelectedViewers] = useState<Set<string>>(
    () => new Set((quote?.viewers ?? []).map((v) => v.user.id)),
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
      api<{ capPct: number; noteThresholdPct: number }>('/quotes/discount-policy'),
    ]).then(([c, l, cur, v, policy]) => {
      setClients(c.rows);
      setLocations(l.rows);
      setCurrencies(cur);
      setViewers(v);
      setCapPct(Math.round(policy.capPct * 1000) / 10);
      setNoteThreshold(Math.round(policy.noteThresholdPct * 1000) / 10);
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
    // Shared body for create + edit; discountPct converts % → fraction, blanks clear the field.
    const body = {
      jobReference,
      currencyCode,
      clientId: clientId ? Number(clientId) : null,
      locationId: locationId ? Number(locationId) : null,
      viewerUserIds: [...selectedViewers].map(Number),
      requestedShippingDate: requestedShippingDate || null,
      siteAddress: siteAddress.trim() ? siteAddress.trim() : null,
      projectNotes: projectNotes.trim() ? projectNotes.trim() : null,
      // AA1 — site/context intake fields (null clears; windowFacing is a boolean flag).
      endCustomer: endCustomer.trim() ? endCustomer.trim() : null,
      airsideLandside: airsideLandside || null,
      sunExposure: sunExposure || null,
      wallSubstrate: wallSubstrate.trim() ? wallSubstrate.trim() : null,
      powerDataAvailable: powerDataAvailable || null,
      controllerLocation: controllerLocation.trim() ? controllerLocation.trim() : null,
      windowFacing,
      // AA5 — software/hardware dependency intake fields (null clears; the flags are booleans).
      mediaPlayerSupply: mediaPlayerSupply || null,
      sharedDevicePlayers: sharedDevicePlayers.trim() === '' ? null : Number(sharedDevicePlayers),
      sharedDeviceScreens: sharedDeviceScreens.trim() === '' ? null : Number(sharedDeviceScreens),
      storeSizeSqm: storeSizeSqm.trim() === '' ? null : Number(storeSizeSqm),
      customContentCuration,
      pcRequired,
      hardDriveRequired,
      // AA6a — commercial intake fields (null clears; needsSolutionsEngineer is a boolean flag).
      priceSensitivity: priceSensitivity || null,
      budgetAud: budgetAud.trim() === '' ? null : Number(budgetAud),
      tenureMonths: tenureMonths.trim() === '' ? null : Number(tenureMonths),
      clientMustHaves: clientMustHaves.trim() ? clientMustHaves.trim() : null,
      needsSolutionsEngineer,
      discountPct: discountPctInput.trim() === '' ? null : Number(discountPctInput) / 100,
      discountNote: discountNote.trim() ? discountNote.trim() : null,
      discountScope,
    };
    try {
      if (isNew) {
        // CREATE the draft, then continue straight to Select Screens (Details is shown only once).
        // createQuoteSchema treats these fields as optional (not nullable), so drop null/empty values.
        const createBody = Object.fromEntries(
          Object.entries(body).filter(([, v]) => v !== null && !(Array.isArray(v) && v.length === 0)),
        );
        const created = await api<{ id: string }>('/quotes', { method: 'POST', body: JSON.stringify(createBody) });
        router.replace(`/quotes/${created.id}?step=1`);
        return; // navigation unmounts this component
      }
      await api(`/quotes/${quote!.id}`, {
        method: 'PATCH',
        // Optimistic concurrency: server rejects (409) if the quote moved since we loaded it.
        body: JSON.stringify({ ...body, expectedVersion: quote!.lockVersion }),
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
  }, [isNew, router, quote, jobReference, currencyCode, clientId, locationId, selectedViewers, requestedShippingDate, siteAddress, projectNotes, endCustomer, airsideLandside, sunExposure, wallSubstrate, powerDataAvailable, controllerLocation, windowFacing, mediaPlayerSupply, sharedDevicePlayers, sharedDeviceScreens, storeSizeSqm, customContentCuration, pcRequired, hardDriveRequired, priceSensitivity, budgetAud, tenureMonths, clientMustHaves, needsSolutionsEngineer, discountPctInput, discountNote, discountScope, onChange]);

  const save = persist;

  // Save/Create. An admin over the cap is NOT hard-stopped — the inline warning banner flags it and the
  // server audits the override; a non-admin over the cap is blocked (disabled button + server 403).
  const handleSave = () => {
    setDirty(false);
    void save();
  };

  // Debounced auto-save (~1.5s after the last edit). `dirty` gates it so it never fires on mount or
  // on the prop-sync re-render after a save/refetch — only genuine user edits arm the timer. When a
  // conflict is showing, auto-save is suspended until the user reloads (which resets dirty).
  useEffect(() => {
    // No auto-save in CREATE mode (nothing to PATCH yet — the user clicks "Create & continue").
    // Suspend auto-save while the discount guardrail is unmet (missing note / non-admin over cap) so the
    // user isn't hit with a mid-typing 422/403; the explicit Save still surfaces the server error.
    if (isNew || !canWrite || !dirty || conflict || !jobReference || discountBlocked || detailsIncomplete) return;
    const t = setTimeout(() => {
      setDirty(false);
      void persist();
    }, 1500);
    return () => clearTimeout(t);
  }, [isNew, dirty, conflict, canWrite, jobReference, discountBlocked, persist]);

  // A viewer can't create a quote; guard the create route (the "+ New quote" button is writer-only).
  if (isNew && !canWrite) {
    return <div className="card"><p className="muted">You don't have permission to create a quote.</p></div>;
  }

  if (!canWrite && quote) {
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
        <h4 style={{ margin: '16px 0 4px' }}>Site context</h4>
        <div className="grid3">
          <div><label>End customer</label><input value={quote.endCustomer ?? ''} readOnly /></div>
          <div><label>Airside / Landside</label><input value={quote.airsideLandside ?? ''} readOnly /></div>
          <div><label>Sun exposure</label><input value={quote.sunExposure ?? ''} readOnly /></div>
          <div><label>Wall substrate</label><input value={quote.wallSubstrate ?? ''} readOnly /></div>
          <div><label>Power &amp; data available</label><input value={quote.powerDataAvailable ?? ''} readOnly /></div>
          <div><label>Controller / media-player location</label><input value={quote.controllerLocation ?? ''} readOnly /></div>
          <div><label>Window-facing / glare risk</label><input value={quote.windowFacing == null ? '' : quote.windowFacing ? 'Yes' : 'No'} readOnly /></div>
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
          {!isNew && <span className="muted" title="Optimistic-locking token; bumped on every change">v{quote!.lockVersion}</span>}
        </span>
      </div>
      <div className="grid3">
        <div><label>Job reference</label><input value={jobReference} onChange={(e) => { setJobReference(e.target.value); setDirty(true); }} /></div>
        <div>
          <label>Client <span style={{ color: 'var(--danger, #dc2626)' }}>*</span></label>
          <SearchSelect
            value={clientId}
            onChange={(v) => { setClientId(v); setDirty(true); }}
            allowEmpty
            placeholder="Select client…"
            options={clients.map((c) => ({ value: c.id, label: c.name ?? '' }))}
          />
        </div>
        <div>
          <label>Location <span style={{ color: 'var(--danger, #dc2626)' }}>*</span></label>
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
        <div><label>Status</label><input value={quote?.status ?? 'draft'} readOnly /></div>
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
          <input type="number" min={0} max={isAdmin ? 99 : capPct} step="0.5" value={discountPctInput} onChange={(e) => onDiscountChange(e.target.value)} placeholder="(default)" />
          <p className="muted" style={{ margin: '4px 0 0', fontSize: 12, color: capBlocked ? 'var(--danger, #dc2626)' : undefined }}>
            {capBlocked
              ? `Exceeds the ${capPct}% cap — admin approval required.`
              : `Cap ${capPct}%. Above ${noteThreshold}% requires a manager note.`}
          </p>
        </div>
        <div>
          <label>Discount applies to</label>
          <select value={discountScope} onChange={(e) => { setDiscountScope(e.target.value as 'one_off' | 'recurring'); setDirty(true); }}>
            <option value="one_off">One-off (upfront)</option>
            <option value="recurring">Every renewal (recurring)</option>
          </select>
        </div>
      </div>
      {/* Admin over-cap: a visible warning (not a hard stop) so it isn't done accidentally; audited on save. */}
      {isAdmin && overCap && (
        <div
          style={{
            marginTop: 10,
            padding: '8px 12px',
            borderRadius: 6,
            border: '1px solid #f59e0b',
            background: 'rgba(245,158,11,0.12)',
            color: '#f59e0b',
            fontSize: 13,
          }}
        >
          ⚠ This discount ({discPctNum}%) exceeds the {capPct}% cap. You can proceed as an admin, but the
          override will be recorded in the audit log{discPctNum != null && discPctNum > noteThreshold ? ' (a manager note is required)' : ''}.
        </div>
      )}
      {discPctNum != null && discPctNum > noteThreshold && (
        <div style={{ marginTop: 8 }}>
          <label>Manager note (required for discounts above {noteThreshold}%){needsNote && <span style={{ color: 'var(--danger, #dc2626)' }}> *</span>}</label>
          <textarea
            value={discountNote}
            onChange={(e) => { setDiscountNote(e.target.value); setDirty(true); }}
            rows={2}
            style={{ width: '100%', fontFamily: 'inherit', fontSize: 13, padding: 8, boxSizing: 'border-box', borderColor: needsNote ? 'var(--danger, #dc2626)' : undefined }}
            placeholder="Justification for the discount (e.g. strategic account, competitive tender)…"
          />
        </div>
      )}
      <div style={{ marginTop: 8 }}>
        <label>Project notes</label>
        <textarea value={projectNotes} onChange={(e) => { setProjectNotes(e.target.value); setDirty(true); }} rows={3} style={{ width: '100%', fontFamily: 'inherit', fontSize: 13, padding: 8, boxSizing: 'border-box' }} placeholder="Internal project notes…" />
      </div>

      {/* AA1 — site/context intake fields (one-per-quote site details from the intake questionnaire). */}
      <h4 style={{ margin: '18px 0 4px' }}>Site context</h4>
      <p className="muted" style={{ marginTop: 0 }}>Intake / site-prep details captured for the install location.</p>
      <div className="grid3">
        <div>
          <label>End customer</label>
          <input value={endCustomer} onChange={(e) => { setEndCustomer(e.target.value); setDirty(true); }} placeholder="Where it's installed (e.g. Airport retailer)" />
        </div>
        <div>
          <label>Airside / Landside</label>
          <SearchSelect
            value={airsideLandside}
            onChange={(v) => { setAirsideLandside(v); setDirty(true); }}
            allowEmpty
            placeholder="—"
            options={[
              { value: 'Airside', label: 'Airside' },
              { value: 'Landside', label: 'Landside' },
              { value: 'N/A', label: 'N/A' },
            ]}
          />
        </div>
        <div>
          <label>Sun exposure</label>
          <SearchSelect
            value={sunExposure}
            onChange={(v) => { setSunExposure(v); setDirty(true); }}
            allowEmpty
            placeholder="—"
            options={[
              { value: 'None', label: 'None' },
              { value: 'Indirect', label: 'Indirect' },
              { value: 'Direct', label: 'Direct' },
            ]}
          />
        </div>
        <div>
          <label>Wall substrate</label>
          <input value={wallSubstrate} onChange={(e) => { setWallSubstrate(e.target.value); setDirty(true); }} placeholder="e.g. plasterboard, brick, concrete" />
        </div>
        <div>
          <label>Power &amp; data available</label>
          <SearchSelect
            value={powerDataAvailable}
            onChange={(v) => { setPowerDataAvailable(v); setDirty(true); }}
            allowEmpty
            placeholder="—"
            options={[
              { value: 'Yes', label: 'Yes' },
              { value: 'No', label: 'No' },
              { value: 'Unknown', label: 'Unknown' },
            ]}
          />
        </div>
        <div>
          <label>Controller / media-player location</label>
          <input value={controllerLocation} onChange={(e) => { setControllerLocation(e.target.value); setDirty(true); }} placeholder="e.g. comms room, behind screen" />
        </div>
      </div>
      <div style={{ marginTop: 8 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text)', cursor: 'pointer' }}>
          <input type="checkbox" checked={windowFacing} onChange={(e) => { setWindowFacing(e.target.checked); setDirty(true); }} style={{ width: 'auto' }} />
          Window-facing / glare risk
        </label>
      </div>

      {/* AA5 — software/hardware dependency intake fields (Group E). Descriptive; no pricing impact. */}
      <h4 style={{ margin: '18px 0 4px' }}>Software &amp; dependencies</h4>
      <p className="muted" style={{ marginTop: 0 }}>Media-player supply, shared-device ratio, and content/hardware dependencies (informational — feeds the PM handoff).</p>
      <div className="grid3">
        <div>
          <label>Media player supply</label>
          <SearchSelect
            value={mediaPlayerSupply}
            onChange={(v) => { setMediaPlayerSupply(v); setDirty(true); }}
            allowEmpty
            placeholder="—"
            options={[
              { value: 'Seen', label: 'Seen' },
              { value: 'Client-supplied', label: 'Client-supplied' },
              { value: 'Mandated', label: 'Mandated' },
            ]}
          />
        </div>
        <div>
          <label>Shared-device ratio (players)</label>
          <input type="number" min={0} value={sharedDevicePlayers} onChange={(e) => { setSharedDevicePlayers(e.target.value); setDirty(true); }} placeholder="e.g. 1" />
        </div>
        <div>
          <label>… per (screens)</label>
          <input type="number" min={0} value={sharedDeviceScreens} onChange={(e) => { setSharedDeviceScreens(e.target.value); setDirty(true); }} placeholder="e.g. 4" />
        </div>
        <div>
          <label>Store size (m²)</label>
          <input type="number" min={0} step="0.01" value={storeSizeSqm} onChange={(e) => { setStoreSizeSqm(e.target.value); setDirty(true); }} placeholder="for music sizing" />
        </div>
      </div>
      <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 16 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text)', cursor: 'pointer' }}>
          <input type="checkbox" checked={customContentCuration} onChange={(e) => { setCustomContentCuration(e.target.checked); setDirty(true); }} style={{ width: 'auto' }} />
          Custom content curation
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text)', cursor: 'pointer' }}>
          <input type="checkbox" checked={pcRequired} onChange={(e) => { setPcRequired(e.target.checked); setDirty(true); }} style={{ width: 'auto' }} />
          PC required
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text)', cursor: 'pointer' }}>
          <input type="checkbox" checked={hardDriveRequired} onChange={(e) => { setHardDriveRequired(e.target.checked); setDirty(true); }} style={{ width: 'auto' }} />
          Hard drive required
        </label>
      </div>

      {/* AA6a — commercial intake (Group F). Advisory only; emphasises the matching G/B/B tier + feeds the PM handoff. */}
      <h4 style={{ margin: '18px 0 4px' }}>Commercial</h4>
      <p className="muted" style={{ marginTop: 0 }}>Price posture, budget, tenure, and client must-haves (advisory — emphasises the matching Good/Better/Best tier and feeds the PM handoff; no pricing effect).</p>
      <div className="grid3">
        <div>
          <label>Price sensitivity</label>
          <SearchSelect
            value={priceSensitivity}
            onChange={(v) => { setPriceSensitivity(v as 'budget' | 'balanced' | 'premium' | ''); setDirty(true); }}
            allowEmpty
            placeholder="—"
            options={[
              { value: 'budget', label: 'Budget' },
              { value: 'balanced', label: 'Balanced' },
              { value: 'premium', label: 'Premium' },
            ]}
          />
        </div>
        <div>
          <label>Budget (AUD)</label>
          <input type="number" min={0} step="0.01" value={budgetAud} onChange={(e) => { setBudgetAud(e.target.value); setDirty(true); }} placeholder="indicative" />
        </div>
        <div>
          <label>Tenure (months)</label>
          <input type="number" min={0} value={tenureMonths} onChange={(e) => { setTenureMonths(e.target.value); setDirty(true); }} placeholder="e.g. 36" />
        </div>
      </div>
      <div style={{ marginTop: 8 }}>
        <label>Client must-haves</label>
        <textarea rows={2} value={clientMustHaves} onChange={(e) => { setClientMustHaves(e.target.value); setDirty(true); }} placeholder="Assumed-but-not-separately-quoted requirements (folded into the register)." />
      </div>
      <div style={{ marginTop: 8 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text)', cursor: 'pointer' }}>
          <input type="checkbox" checked={needsSolutionsEngineer} onChange={(e) => { setNeedsSolutionsEngineer(e.target.checked); setDirty(true); }} style={{ width: 'auto' }} />
          Needs solutions engineer
        </label>
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
        <button className="primary" onClick={handleSave} disabled={busy || !jobReference || discountBlocked || detailsIncomplete}>
          {busy ? (isNew ? 'Creating…' : 'Saving…') : isNew ? 'Create & continue' : 'Save details'}
        </button>
        {isNew && (
          <button type="button" className="ghost" onClick={() => router.push('/quotes')} disabled={busy}>
            Cancel
          </button>
        )}
        {detailsIncomplete ? (
          <span className="muted" style={{ color: 'var(--danger, #dc2626)', alignSelf: 'center' }}>
            {!clientId && !locationId
              ? 'Client and location are required.'
              : !clientId
                ? 'Client is required.'
                : 'Location is required.'}
          </span>
        ) : (
          discountBlocked && (
            <span className="muted" style={{ color: 'var(--danger, #dc2626)', alignSelf: 'center' }}>
              {needsNote ? `Add a manager note to save (discount above ${noteThreshold}%).` : `Discount exceeds the ${capPct}% cap.`}
            </span>
          )
        )}
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
  cabinetsWide: number;
  cabinetsHigh: number;
  cabinetCount: number;
  resolutionWpx: number;
  resolutionHpx: number;
  ratioLabel: string | null;
  fillPercent: string;
  cutCabinetSuggested: boolean;
  // U8: deterministic 0–100 confidence score for this configuration.
  confidence: number;
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
  /** Per-model recommendation priority (admin-set, lower = preferred) — secondary ranking key. */
  modelPriority: number;
  toleranceBand: number;
  // W0: pixel pitch (mm) + a fine-pitch GOB recommendation flag (from env/viewing-distance selection).
  pixelPitchMm: number;
  gobRecommended: boolean;
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

// AA6a — commercial recommendation hints returned alongside G/B/B tiers (LED + LCD). Advisory
// labelling only: the client's typical-selection caption + which tier matches the price sensitivity.
interface CommercialHints {
  typicalSelectionNote: string | null;
  priceSensitivity: 'budget' | 'balanced' | 'premium' | null;
  emphasisTier: 'value' | 'recommended' | 'premium' | null;
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
  { key: 'coatingId', slug: 'coating-options', label: 'Coating' }, // AA4 — protective / gold coating
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

// U2: human "Tolerance" indicator — how far the panel sits from the opening, as a ±% band.
function toleranceLabel(o: Pick<ConfigOption, 'sizeMode' | 'toleranceBand'>): string {
  if (o.sizeMode === 'exact' || o.toleranceBand === 0) return 'exact';
  return `±${o.toleranceBand}%`;
}

// A view filter: keep options within the selected tolerance band. `band === null` means "All"; an
// exact/0-delta option always passes. Over-band options are already excluded server-side.
function withinBand<T extends Pick<ConfigOption, 'sizeMode' | 'toleranceBand'>>(rows: T[], band: number | null): T[] {
  if (band === null) return rows;
  return rows.filter((o) => o.sizeMode === 'exact' || o.toleranceBand <= band);
}

// U9: sortable columns for the Ranked configurations table. Each key maps to a comparable value.
type ConfigSortKey =
  | 'model' | 'manufacturerName' | 'leadTimeDays' | 'size' | 'sizeDeltaPct'
  | 'toleranceBand' | 'resolution' | 'ratioLabel' | 'fillPercent' | 'cabinetCount'
  | 'cutCabinetSuggested' | 'confidence' | 'pixelPitchMm' | 'modelPriority';

// The human header labels shown in the table (also used as the clickable sort targets).
const CONFIG_COLUMNS: Array<{ key: ConfigSortKey; label: string; num?: boolean }> = [
  { key: 'model', label: 'Product' },
  { key: 'manufacturerName', label: 'Manufacturer' },
  { key: 'modelPriority', label: 'Model pri.', num: true },
  { key: 'pixelPitchMm', label: 'Pitch (mm)', num: true },
  { key: 'leadTimeDays', label: 'Lead (d)', num: true },
  { key: 'size', label: 'Size (mm)' },
  { key: 'sizeDeltaPct', label: 'Sizing' },
  { key: 'toleranceBand', label: 'Tolerance' },
  { key: 'resolution', label: 'Resolution' },
  { key: 'ratioLabel', label: 'Ratio' },
  { key: 'fillPercent', label: 'Fill %', num: true },
  { key: 'cabinetCount', label: 'Cabinets', num: true },
  { key: 'cutCabinetSuggested', label: 'Cut?' },
  { key: 'confidence', label: 'Confidence', num: true },
];

// U9: the free-text haystack for a config row — human-readable fields joined + lowercased.
function configSearchText(o: ConfigOption): string {
  return [
    o.model, o.manufacturerName, o.ratioLabel,
    `${o.widthMm}×${o.heightMm}`, `${o.widthMm}x${o.heightMm}`,
    o.sizeMode, sizeLabel(o), toleranceLabel(o),
    o.rotated ? 'rotated rot' : '',
  ].filter(Boolean).join(' ').toLowerCase();
}

// U9: extract the comparable value for a sort key. Numeric keys → number|null; text/bool → string|null.
function configSortValue(o: ConfigOption, key: ConfigSortKey): number | string | null {
  switch (key) {
    case 'model': return o.model ?? null;
    case 'manufacturerName': return o.manufacturerName ?? null;
    case 'modelPriority': return o.modelPriority;
    case 'ratioLabel': return o.ratioLabel ?? null;
    case 'leadTimeDays': return o.leadTimeDays ?? null;
    case 'pixelPitchMm': return o.pixelPitchMm ?? null;
    case 'size': return o.widthMm * 100000 + o.heightMm; // width primary, height tiebreak
    case 'sizeDeltaPct': return Number(o.sizeDeltaPct);
    case 'toleranceBand': return o.toleranceBand;
    case 'resolution': return o.resolutionWpx * o.resolutionHpx;
    case 'fillPercent': return Number(o.fillPercent);
    case 'cabinetCount': return o.cabinetCount;
    case 'cutCabinetSuggested': return o.cutCabinetSuggested ? 1 : 0;
    case 'confidence': return o.confidence;
    default: return null;
  }
}

// U9: sort a copy of the rows by key/direction. Nulls always sort last (regardless of direction);
// falls back to a stable no-op when key is null (preserves the server's manufacturer-priority order).
function sortConfigs(rows: ConfigOption[], key: ConfigSortKey | null, dir: 'asc' | 'desc'): ConfigOption[] {
  if (key === null) return rows;
  const mult = dir === 'asc' ? 1 : -1;
  return rows
    .map((o, i) => ({ o, i }))
    .sort((a, b) => {
      const va = configSortValue(a.o, key);
      const vb = configSortValue(b.o, key);
      if (va === null && vb === null) return a.i - b.i;
      if (va === null) return 1; // nulls last
      if (vb === null) return -1;
      let cmp: number;
      if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb;
      else cmp = String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' });
      return cmp !== 0 ? cmp * mult : a.i - b.i; // stable tiebreak by original index
    })
    .map((x) => x.o);
}

// U8: what CabinetPreview needs from an option (both ConfigOption + TierOption satisfy this).
type PreviewOption = Pick<
  ConfigOption,
  | 'model' | 'widthMm' | 'heightMm' | 'cabinetsWide' | 'cabinetsHigh'
  | 'deltaWidthMm' | 'deltaHeightMm' | 'resolutionWpx' | 'resolutionHpx'
  | 'ratioLabel' | 'fillPercent' | 'confidence' | 'rotated'
>;

// U8 — read-only cabinet / LED-screen visual preview for one configuration. Renders an SVG grid of
// cabinetsWide × cabinetsHigh cabinet cells scaled to the built aspect, overlays the *requested
// opening* (built − delta) as a dashed rectangle from the top-left origin, and colours each cabinet
// teal (inside the opening) or amber (build buffer / over-cabinets). No Col/Row/Rotate editing.
function CabinetPreview({ option }: { option: PreviewOption }) {
  const cols = Math.max(1, option.cabinetsWide);
  const rows = Math.max(1, option.cabinetsHigh);
  const builtW = option.widthMm || 1;
  const builtH = option.heightMm || 1;
  // Requested opening = built − delta (deltaWidthMm/Height = built − requested, signed).
  const openingWmm = Math.max(0, builtW - (option.deltaWidthMm ?? 0));
  const openingHmm = Math.max(0, builtH - (option.deltaHeightMm ?? 0));

  // Scale the drawing so the LONGER built axis fits a fixed box; keep the built aspect ratio.
  const BOX = 320; // px, longest side of the drawn grid
  const scale = BOX / Math.max(builtW, builtH);
  const gridW = builtW * scale;
  const gridH = builtH * scale;
  const cabWmm = builtW / cols;
  const cabHmm = builtH / rows;
  const cabW = gridW / cols;
  const cabH = gridH / rows;
  const gap = 1.5;

  // How many whole cabinets fall inside the opening rectangle (from the origin).
  const openCols = Math.max(0, Math.floor(openingWmm / cabWmm + 1e-6));
  const openRows = Math.max(0, Math.floor(openingHmm / cabHmm + 1e-6));

  // Opening rectangle in px (may exceed the grid when the build is UNDER the opening).
  const openW = openingWmm * scale;
  const openH = openingHmm * scale;

  const teal = 'var(--ok, #5eead4)';
  const tealStroke = 'var(--ok, #0d9488)';
  const amber = 'var(--warn, #fcd34d)';
  const amberStroke = 'var(--warn, #b45309)';

  // Pad the viewBox so the (possibly larger) dashed opening isn't clipped.
  const vw = Math.max(gridW, openW) + 4;
  const vh = Math.max(gridH, openH) + 4;

  const cells: ReactElement[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const inOpening = c < openCols && r < openRows;
      cells.push(
        <rect
          key={`${r}-${c}`}
          x={2 + c * cabW + gap / 2}
          y={2 + r * cabH + gap / 2}
          width={Math.max(0, cabW - gap)}
          height={Math.max(0, cabH - gap)}
          rx={2}
          fill={inOpening ? teal : amber}
          fillOpacity={0.55}
          stroke={inOpening ? tealStroke : amberStroke}
          strokeWidth={1}
        />,
      );
    }
  }

  const two = (mm: number) => (mm / 1000).toFixed(2);

  return (
    <div>
      <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700, marginBottom: 8 }}>
        Preview — {option.model}{option.rotated ? ' (rotated)' : ''}
      </div>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
        <svg
          viewBox={`0 0 ${vw} ${vh}`}
          style={{ maxWidth: '100%', width: BOX, height: 'auto', display: 'block' }}
          role="img"
          aria-label={`Cabinet grid ${cols}×${rows} with requested opening overlay`}
        >
          {cells}
          {/* Requested opening — dashed rectangle from the top-left origin. */}
          <rect
            x={2}
            y={2}
            width={openW}
            height={openH}
            fill="none"
            stroke="var(--accent, #4f46e5)"
            strokeWidth={1.5}
            strokeDasharray="6 4"
            rx={2}
          />
        </svg>
      </div>
      <div style={{ display: 'flex', gap: 16, justifyContent: 'center', fontSize: 12, marginBottom: 10, flexWrap: 'wrap' }}>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, background: teal, opacity: 0.7, borderRadius: 2, marginRight: 4 }} />In opening</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, background: amber, opacity: 0.7, borderRadius: 2, marginRight: 4 }} />Build buffer / over</span>
        <span><span style={{ display: 'inline-block', width: 14, height: 0, borderTop: '2px dashed var(--accent, #4f46e5)', marginRight: 4, verticalAlign: 'middle' }} />Requested opening</span>
      </div>
      <table style={{ width: '100%', fontSize: 13 }}>
        <tbody>
          <tr><td className="muted">Built size</td><td>{two(builtW)} × {two(builtH)} m ({cols}×{rows} cabinets)</td></tr>
          <tr><td className="muted">Resolution</td><td>{option.resolutionWpx} × {option.resolutionHpx} px</td></tr>
          <tr><td className="muted">Aspect · fit</td><td>{option.ratioLabel ?? '—'} · {Math.round(Number(option.fillPercent))}%</td></tr>
          <tr><td className="muted">Confidence</td><td><b>{option.confidence}%</b></td></tr>
        </tbody>
      </table>
    </div>
  );
}

// A simple fixed-overlay modal: click-away on the backdrop + a ✕ button both close it.
function PreviewModal({ option, onClose }: { option: PreviewOption; onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <div
        className="card"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 420, width: '100%', margin: 0, maxHeight: '90vh', overflowY: 'auto', position: 'relative' }}
      >
        <button
          className="ghost"
          onClick={onClose}
          aria-label="Close preview"
          style={{ position: 'absolute', top: 8, right: 8 }}
        >
          ✕
        </button>
        <CabinetPreview option={option} />
      </div>
    </div>
  );
}

// Form 1 (U1): select & finalise an LED panel — opening size + orientation/ratio + configure /
// Good-Better-Best / specific-product selection + components + rotate. Adds the screen (POST
// /led-screens) with panel + geometry + components only; secondary options/services are set
// afterwards via the per-screen PATCH editor (LedOptionsEditor / Form 2).
function LedAddForm({ quote, onChange, editScreen, onCancelEdit }: { quote: Quote; onChange: () => Promise<void>; editScreen?: LedScreen; onCancelEdit?: () => void }) {
  const isEditing = !!editScreen;
  const [products, setProducts] = useState<Opt[]>([]);
  const [productId, setProductId] = useState(editScreen?.ledProductId != null ? String(editScreen.ledProductId) : '');
  const [name, setName] = useState(editScreen?.screenName ?? '');
  const [w, setW] = useState(editScreen?.desiredWidthMm != null ? String(editScreen.desiredWidthMm) : '1120');
  const [h, setH] = useState(editScreen?.desiredHeightMm != null ? String(editScreen.desiredHeightMm) : '1920');
  const [rotate, setRotate] = useState(editScreen ? !!editScreen.rotateCabinets : true);
  // W0: query-only selection drivers (not persisted on the screen) — environment + viewing distance.
  // These narrow/rank the suggestions server-side (brightness fallback + max-pitch filter). Kept
  // across configure() and loadTiers().
  const [environment, setEnvironment] = useState('');
  const [viewingDistanceM, setViewingDistanceM] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [options, setOptions] = useState<ConfigOption[] | null>(null);
  const [reasons, setReasons] = useState<string[]>([]);
  // U2: user-facing "Allowed size tolerance" — the bands come from the configure response
  // (size_tolerance_bands setting); `selectedBand` is a pure view filter (null = "All").
  const [toleranceBands, setToleranceBands] = useState<number[]>([]);
  const [selectedBand, setSelectedBand] = useState<number | null>(null);
  // U9: Ranked-configurations table search + sort (local view state, reset on each configure).
  const [configSearch, setConfigSearch] = useState('');
  const [sortKey, setSortKey] = useState<ConfigSortKey | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const toggleSort = (key: ConfigSortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  };
  // Good / Better / Best tiered options (T2).
  const [tiers, setTiers] = useState<TierOption[] | null>(null);
  const [tierReasons, setTierReasons] = useState<string[]>([]);
  const [distinctProducts, setDistinctProducts] = useState(0);
  // AA6a — commercial recommendation hints (client typical-selection note + price-sensitivity emphasis).
  const [commercialHints, setCommercialHints] = useState<CommercialHints | null>(null);
  // U8: the option currently shown in the read-only cabinet-preview modal (null = closed).
  const [preview, setPreview] = useState<PreviewOption | null>(null);
  // The "Screen selection" accordion is open until a product is selected, then collapses to a
  // compact summary; the user can re-open it any time to pick a different product. In edit mode a
  // product is already chosen → start collapsed.
  const [accordionOpen, setAccordionOpen] = useState(!isEditing);

  // S1: orientation + aspect ratio (with auto-dimension calc), components, back cover, notes.
  const [orientation, setOrientation] = useState(editScreen?.orientation ?? '');
  const [aspectRatioId, setAspectRatioId] = useState(editScreen?.aspectRatioId != null ? String(editScreen.aspectRatioId) : '');
  const [ratios, setRatios] = useState<Array<{ id: string; ratioLabel: string }>>([]);
  // Component pickers: catalog rows per type + the user's chosen component rows + the add-row draft.
  const [componentRows, setComponentRows] = useState<Record<LedComponentType, Opt[]>>(
    () => Object.fromEntries(LED_COMPONENT_TABLES.map((t) => [t.componentType, [] as Opt[]])) as unknown as Record<LedComponentType, Opt[]>,
  );
  // Pre-fill component rows from the screen's stored components (map its set FK id → itemId).
  const [components, setComponents] = useState<ComponentRow[]>(
    () => (editScreen?.components ?? []).flatMap((c) => {
      const def = LED_COMPONENT_TABLES.find((t) => t.componentType === c.componentType);
      if (!def) return [];
      const itemId = c[def.idField as keyof LedComponent];
      return itemId != null ? [{ componentType: def.componentType, itemId: String(itemId), qty: Number(c.qty) || 1 }] : [];
    }),
  );
  const [draftType, setDraftType] = useState<LedComponentType>('controller');
  const [draftItem, setDraftItem] = useState('');
  const [draftQty, setDraftQty] = useState('1');

  // Options & services lookups (merged in from the per-screen editor) — same admin tables, loaded
  // once so a single add POST can carry frame/trim/GOB/install/freight/warranty/etc.
  const [optionRows, setOptionRows] = useState<Record<LedOptionKey, Opt[]>>(
    () => Object.fromEntries(LED_OPTION_TABLES.map((t) => [t.key, [] as Opt[]])) as unknown as Record<LedOptionKey, Opt[]>,
  );
  const [selectedOpts, setSelectedOpts] = useState<Record<LedOptionKey, string>>(
    () => Object.fromEntries(LED_OPTION_TABLES.map((t) => {
      const v = editScreen ? (editScreen as unknown as Record<string, unknown>)[t.key] : undefined;
      return [t.key, v != null ? String(v) : ''];
    })) as unknown as Record<LedOptionKey, string>,
  );
  const [backCover, setBackCover] = useState(!!editScreen?.backCover);
  // AA4 — high-resolution supply upgrade (fractional uplift; priced only when the admin rate > 0).
  const [highResolution, setHighResolution] = useState(!!editScreen?.highResolution);
  // AA1 — recess/cavity depth (mm); descriptive site-prep detail.
  const [recessDepthMm, setRecessDepthMm] = useState(editScreen?.recessDepthMm != null ? String(editScreen.recessDepthMm) : '');
  const [frameNote, setFrameNote] = useState(editScreen?.frameNote ?? '');
  const [serviceDescriptionSuffix, setServiceDescriptionSuffix] = useState(editScreen?.serviceDescriptionSuffix ?? '');
  // AA2 — content ratio + supplier + flatness.
  const [contentRatio, setContentRatio] = useState(editScreen?.contentRatio ?? '');
  const [contentSupplier, setContentSupplier] = useState(editScreen?.contentSupplier ?? '');
  const [flatnessRequired, setFlatnessRequired] = useState(!!editScreen?.flatnessRequired);

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

  // W0: the selection query body shared by configure() and loadTiers(). Environment + viewing
  // distance are optional and only sent when set.
  const selectionBody = () => ({
    desiredWidthMm: Number(w),
    desiredHeightMm: Number(h),
    allowRotation: rotate,
    ...(environment ? { environment } : {}),
    ...(Number(viewingDistanceM) > 0 ? { viewingDistanceM: Number(viewingDistanceM) } : {}),
  });

  const configure = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await api<{ options: ConfigOption[]; reasons: string[]; toleranceBands?: number[] }>(
        `/quotes/${quote.id}/screens/configure`,
        { method: 'POST', body: JSON.stringify(selectionBody()) },
      );
      setOptions(res.options);
      setReasons(res.reasons);
      // Best-fit and Good/Better/Best are mutually exclusive views — showing one hides the other.
      setTiers(null);
      setTierReasons([]);
      // U9: reset the table search/sort when a fresh result set arrives.
      setConfigSearch('');
      setSortKey(null);
      setSortDir('asc');
      // Surface the allowed tolerance bands and default the filter to the widest (least restrictive).
      const bands = (res.toleranceBands ?? []).slice().sort((a, b) => a - b);
      setToleranceBands(bands);
      if (selectedBand === null && bands.length > 0) setSelectedBand(bands[bands.length - 1]!);
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
      const res = await api<{ options: TierOption[]; reasons: string[]; distinctProducts: number; toleranceBands?: number[]; commercialHints?: CommercialHints }>(
        `/quotes/${quote.id}/screens/options`,
        { method: 'POST', body: JSON.stringify(selectionBody()) },
      );
      setTiers(res.options);
      setTierReasons(res.reasons);
      setDistinctProducts(res.distinctProducts);
      setCommercialHints(res.commercialHints ?? null);
      // Best-fit and Good/Better/Best are mutually exclusive views — showing one hides the other.
      setOptions(null);
      setReasons([]);
      const bands = (res.toleranceBands ?? []).slice().sort((a, b) => a - b);
      if (bands.length > 0) {
        setToleranceBands(bands);
        if (selectedBand === null) setSelectedBand(bands[bands.length - 1]!);
      }
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
      // Selected option FKs (omit empties), housing/notes — all carried in the one add POST/PUT.
      const optionFks: Record<string, number> = {};
      for (const t of LED_OPTION_TABLES) if (selectedOpts[t.key]) optionFks[t.key] = Number(selectedOpts[t.key]);
      const body = {
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
        highResolution,
        ...(recessDepthMm.trim() !== '' ? { recessDepthMm: Number(recessDepthMm) } : {}),
        ...(frameNote.trim() ? { frameNote: frameNote.trim() } : {}),
        ...(serviceDescriptionSuffix.trim() ? { serviceDescriptionSuffix: serviceDescriptionSuffix.trim() } : {}),
        // AA2 — content ratio / supplier / flatness.
        ...(contentRatio.trim() ? { contentRatio: contentRatio.trim() } : {}),
        ...(contentSupplier.trim() ? { contentSupplier: contentSupplier.trim() } : {}),
        flatnessRequired,
      };
      if (isEditing && editScreen) {
        // V4 full re-edit — PUT the whole body (qty is preserved server-side when omitted).
        await api(`/quotes/${quote.id}/led-screens/${editScreen.id}`, { method: 'PUT', body: JSON.stringify(body) });
      } else {
        await api(`/quotes/${quote.id}/led-screens`, { method: 'POST', body: JSON.stringify(body) });
      }
      if (isEditing) {
        // Exit edit mode → parent resets the form back to a clean add flow + refetches.
        await onChange();
        onCancelEdit?.();
        return;
      }
      // Reset the whole form for the next screen and re-open the selection accordion.
      setName('');
      setProductId('');
      setOptions(null);
      setTiers(null);
      setSelectedBand(null);
      setComponents([]);
      setOrientation('');
      setAspectRatioId('');
      setSelectedOpts(Object.fromEntries(LED_OPTION_TABLES.map((t) => [t.key, ''])) as unknown as Record<LedOptionKey, string>);
      setBackCover(false);
      setHighResolution(false);
      setRecessDepthMm('');
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
  // Resolved aspect-ratio label (for the collapsed summary + tolerance filtering context).
  const selectedRatioLabel = ratios.find((r) => r.id === aspectRatioId)?.ratioLabel ?? '';

  // Required-field gating (P1-12.3): the essentials before "+ Add screen".
  const missing: string[] = [];
  if (!productId) missing.push('select a product above');
  if (!(Number(w) > 0)) missing.push('width');
  if (!(Number(h) > 0)) missing.push('height');
  const canAddSpecific = missing.length === 0;

  return (
    <div>
      {/* V4: editing an existing LED screen — banner + Cancel. */}
      {isEditing && (
        <div className="card" style={{ borderColor: 'var(--accent, #4f46e5)', background: 'var(--accent-bg, rgba(79,70,229,0.06))' }}>
          <div className="list-row" style={{ alignItems: 'center' }}>
            <span><b>Editing:</b> {editScreen?.screenName || 'LED screen'} <span className="muted">— change any field below and Save changes.</span></span>
            <button className="ghost" onClick={() => onCancelEdit?.()} disabled={busy}>Cancel edit</button>
          </div>
        </div>
      )}
      {/* U8: read-only cabinet preview for the option the user clicked "Preview" on. */}
      {preview && <PreviewModal option={preview} onClose={() => setPreview(null)} />}
      {/* Screen-selection accordion: collapses to a compact summary once a product is selected. */}
      {!accordionOpen && productId ? (
        <div className="card">
          <div className="list-row" style={{ alignItems: 'center' }}>
            <div>
              <span className="pill" style={{ marginRight: 6 }}>Selected</span>
              <b>{selectedModel || `Product ${productId}`}</b>{rotate ? ' (rot)' : ''}{' '}
              <span className="muted">
                · {w}×{h}mm
                {(orientation || selectedRatioLabel) ? ` · ${[orientation, selectedRatioLabel].filter(Boolean).join(' ')}` : ''}
              </span>
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
        <p className="muted">Enter the full screen details — opening size, orientation and aspect ratio — then the engine ranks every LED product that fits. Pick one to attach components &amp; services below.</p>
        <div className="grid3">
          <div><label>Screen name</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
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
          <div>
            <label>Allow rotation</label>
            <input type="checkbox" checked={rotate} onChange={(e) => setRotate(e.target.checked)} style={{ width: 'auto' }} />
          </div>
        </div>
        <p className="muted" style={{ marginTop: 4 }}>
          Pick orientation + an aspect ratio and one dimension auto-fills the other (still editable).
        </p>
        {/* W0: environment + viewing distance + GOB drive the suggestions. */}
        <h4 style={{ margin: '14px 0 4px' }}>Environment &amp; suitability</h4>
        <div className="grid3">
          <div>
            <label>Viewing distance (m)</label>
            <input
              type="number"
              min="0"
              step="0.5"
              value={viewingDistanceM}
              onChange={(e) => setViewingDistanceM(e.target.value)}
              placeholder="optional"
            />
            <p className="muted" style={{ margin: '2px 0 0', fontSize: 12 }}>
              Filters to panels sharp at this distance (max pitch ≈ distance in metres).
            </p>
          </div>
          <div>
            <label>Environment</label>
            <SearchSelect
              value={environment}
              onChange={setEnvironment}
              allowEmpty
              placeholder="Any"
              options={[{ value: 'indoor', label: 'Indoor' }, { value: 'outdoor', label: 'Outdoor' }]}
            />
          </div>
          <div>
            <label>GOB (fine pitch)</label>
            <SearchSelect
              value={selectedOpts.gobId}
              onChange={(v) => setSelectedOpts((p) => ({ ...p, gobId: v }))}
              allowEmpty
              placeholder="Select GOB…"
              options={(optionRows.gobId ?? []).map((o) => ({ value: o.id, label: o.name ?? o.model ?? '' }))}
            />
            <p className="muted" style={{ margin: '2px 0 0', fontSize: 12 }}>
              GOB (glass-on-board) protects fine-pitch (&lt;2.5mm) screens.
            </p>
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

        {/* U2: user-facing "Allowed size tolerance" — a segmented filter over the returned bands. */}
        {toleranceBands.length > 0 && (options || tiers) && (
          <div style={{ marginTop: 14 }}>
            <label style={{ display: 'block', marginBottom: 4 }}>Allowed size tolerance <span className="muted" style={{ fontWeight: 400 }}>(LED build buffer)</span></label>
            <p className="muted" style={{ margin: '0 0 6px' }}>
              LED screens are built up from whole cabinets, so an exact match to the opening isn’t always
              possible. Show only builds whose size lands within this % of the required opening.
            </p>
            <div role="group" style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
              {toleranceBands.map((b) => (
                <button
                  key={b}
                  className={selectedBand === b ? 'primary' : 'ghost'}
                  onClick={() => setSelectedBand(b)}
                  type="button"
                >
                  ±{b}%
                </button>
              ))}
              <button
                className={selectedBand === null ? 'primary' : 'ghost'}
                onClick={() => setSelectedBand(null)}
                type="button"
              >
                All
              </button>
            </div>
          </div>
        )}

      {tiers && (() => {
        const shownTiers = withinBand(tiers, selectedBand);
        return (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Good / Better / Best</h3>
          {tiers.length === 0 && <p className="muted">No options: {tierReasons.join(' ')}</p>}
          {tiers.length > 0 && shownTiers.length === 0 && (
            <p className="muted">No tiers within ±{selectedBand}% — widen the allowed size tolerance above.</p>
          )}
          {shownTiers.length > 0 && (
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
                {shownTiers.map((t) => {
                  const emphasised = commercialHints?.emphasisTier === t.tier;
                  return (
                  <div
                    key={t.tier}
                    className="card"
                    style={{
                      margin: 0,
                      borderColor: t.tier === 'recommended' || emphasised ? 'var(--accent, #4f46e5)' : undefined,
                      borderWidth: t.tier === 'recommended' || emphasised ? 2 : undefined,
                    }}
                  >
                    <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700, marginBottom: 4 }}>
                      {t.label}
                      {emphasised && (
                        <span
                          title={`Matches the client's ${commercialHints?.priceSensitivity} price sensitivity`}
                          style={{
                            marginLeft: 6, padding: '0 6px', borderRadius: 10, fontSize: 10, fontWeight: 700,
                            textTransform: 'none', letterSpacing: 0,
                            background: 'var(--accent-bg, rgba(79,70,229,0.12))', color: 'var(--accent, #4f46e5)',
                            cursor: 'help', whiteSpace: 'nowrap',
                          }}
                        >
                          Matches price sensitivity
                        </span>
                      )}
                    </div>
                    <p className="muted" style={{ marginTop: 0 }}>{t.rationale}</p>
                    {t.tier === 'recommended' && commercialHints?.typicalSelectionNote && (
                      <p className="muted" style={{ marginTop: 0, fontStyle: 'italic' }}>
                        Client typically selects: {commercialHints.typicalSelectionNote}
                      </p>
                    )}
                    <div style={{ fontWeight: 600 }}>
                      {t.model}{t.rotated ? ' (rot)' : ''}
                      {t.gobRecommended && (
                        <span
                          title="Fine pitch — GOB recommended"
                          style={{
                            marginLeft: 6, padding: '0 6px', borderRadius: 10, fontSize: 11, fontWeight: 700,
                            background: 'var(--accent-bg, rgba(79,70,229,0.12))', color: 'var(--accent, #4f46e5)',
                            cursor: 'help', whiteSpace: 'nowrap',
                          }}
                        >
                          GOB
                        </span>
                      )}
                    </div>
                    <table style={{ width: '100%', fontSize: 13, margin: '8px 0' }}>
                      <tbody>
                        <tr><td className="muted">Manufacturer</td><td>{t.manufacturerName ?? '—'}</td></tr>
                        <tr><td className="muted">Pitch (mm)</td><td>{t.pixelPitchMm != null ? t.pixelPitchMm : '—'}</td></tr>
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
                        <tr><td className="muted">Cut?</td><td>{t.cutCabinetSuggested ? <span title="Cabinets must be cut to fit the opening — adds cost and lead time" style={{ cursor: 'help' }}>⚠️ yes</span> : '—'}</td></tr>
                        <tr>
                          <td className="muted">Sizing</td>
                          <td style={{ color: t.sizeMode === 'over' ? 'var(--danger, #dc2626)' : t.sizeMode === 'under' ? 'var(--warn, #b45309)' : 'var(--ok, #15803d)' }}>
                            {sizeLabel(t)}
                          </td>
                        </tr>
                        <tr><td className="muted">Tolerance</td><td>{toleranceLabel(t)}</td></tr>
                        <tr><td className="muted">Supply sell</td><td>${t.supplySellAud}</td></tr>
                        {getRole() === 'admin' && (
                          <>
                            <tr><td className="muted">Supply cost</td><td>{t.supplyCostAud ? `$${t.supplyCostAud}` : '—'}</td></tr>
                            <tr><td className="muted">Margin</td><td>{t.margin ? `${(Number(t.margin) * 100).toFixed(1)}%` : '—'}</td></tr>
                          </>
                        )}
                      </tbody>
                    </table>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="primary" onClick={() => selectProduct(t.productId, t.rotated)} disabled={busy} style={{ flex: 1 }}>
                        Select this option
                      </button>
                      <button className="ghost" onClick={() => setPreview(t)} type="button">
                        👁 Preview
                      </button>
                    </div>
                  </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
        );
      })()}

      {options && (() => {
        // U9: band filter → search filter → sort → display slice.
        const CONFIG_CAP = 50;
        const banded = withinBand(options, selectedBand);
        const q = configSearch.trim().toLowerCase();
        const searched = q ? banded.filter((o) => configSearchText(o).includes(q)) : banded;
        const shownOptions = sortConfigs(searched, sortKey, sortDir);
        const capped = shownOptions.slice(0, CONFIG_CAP);
        return (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Ranked configurations ({shownOptions.length}{selectedBand !== null && banded.length !== options.length ? ` of ${options.length}` : ''})</h3>
          {options.length === 0 && <p className="muted">No fit: {reasons.join(' ')}</p>}
          {options.length > 0 && banded.length === 0 && (
            <p className="muted">No configurations within ±{selectedBand}% — widen the allowed size tolerance above.</p>
          )}
          {banded.length > 0 && (
            <div style={{ margin: '8px 0' }}>
              <input
                type="text"
                value={configSearch}
                onChange={(e) => setConfigSearch(e.target.value)}
                placeholder="Search configurations…"
                style={{ width: '100%', maxWidth: 360 }}
                aria-label="Search configurations"
              />
            </div>
          )}
          {banded.length > 0 && searched.length === 0 && (
            <p className="muted">No configurations match “{configSearch}”.</p>
          )}
          {shownOptions.length > 0 && (
            <>
            <p className="muted" style={{ margin: '4px 0' }}>Showing {capped.length} of {shownOptions.length}</p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    {CONFIG_COLUMNS.map((c) => (
                      <th
                        key={c.key}
                        className={c.num ? 'cell-num' : undefined}
                        onClick={() => toggleSort(c.key)}
                        style={{ cursor: 'pointer', userSelect: 'none' }}
                        title="Click to sort"
                      >
                        {c.label}{sortKey === c.key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                      </th>
                    ))}
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {capped.map((o, i) => (
                    <tr key={`${o.productId}-${o.rotated}-${o.sizeMode}-${i}`}>
                      <td>
                        {o.model}{o.rotated ? ' (rot)' : ''}
                        {o.gobRecommended && (
                          <span
                            title="Fine pitch — GOB recommended"
                            style={{
                              marginLeft: 6, padding: '0 6px', borderRadius: 10, fontSize: 11, fontWeight: 700,
                              background: 'var(--accent-bg, rgba(79,70,229,0.12))', color: 'var(--accent, #4f46e5)',
                              cursor: 'help', whiteSpace: 'nowrap',
                            }}
                          >
                            GOB
                          </span>
                        )}
                      </td>
                      <td>{o.manufacturerName ?? '—'}</td>
                      <td className="cell-num">{o.modelPriority}</td>
                      <td className="cell-num">{o.pixelPitchMm != null ? o.pixelPitchMm : '—'}</td>
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
                      <td>{toleranceLabel(o)}</td>
                      <td>{o.resolutionWpx}×{o.resolutionHpx}</td>
                      <td>
                        {o.ratioLabel ?? '—'}
                        {!o.ratioPreferred && o.ratioGuidance && (
                          <span title={o.ratioGuidance} style={{ marginLeft: 4, cursor: 'help' }}>⚠️</span>
                        )}
                      </td>
                      <td className="cell-num">{o.fillPercent}</td>
                      <td className="cell-num">{o.cabinetCount}</td>
                      <td>{o.cutCabinetSuggested ? <span title="Cabinets must be cut to fit the opening — adds cost and lead time" style={{ cursor: 'help' }}>⚠️</span> : '—'}</td>
                      <td className="cell-num">{o.confidence}</td>
                      <td className="actions">
                        <button className="ghost" onClick={() => setPreview(o)} type="button" style={{ marginRight: 4 }}>
                          👁 Preview
                        </button>
                        <button className="primary" onClick={() => selectProduct(o.productId, o.rotated)} disabled={busy}>
                          Select
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
          )}
        </div>
        );
      })()}
      </div>
      )}

      {/* Merged details form — only once a product is selected via the accordion. */}
      {productId && (
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Screen details</h3>
        <p className="muted">
          Components and options &amp; services for <b>{selectedModel || `product ${productId}`}</b>
          {rotate ? ' (rotated)' : ''} · {w}×{h}mm{(orientation || selectedRatioLabel) ? ` · ${[orientation, selectedRatioLabel].filter(Boolean).join(' ')}` : ''}.
          Panel &amp; geometry are set above; edit them via <b>Expand / change</b>. All sent in one go when you add the screen.
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
          Frame, trim, install, freight, warranty and more — all optional; each is priced with the screen.
          {selectedOpts.gobId && ' GOB is set in the Environment & suitability section above.'}
        </p>
        <div className="grid3">
          {/* GOB is its own up-front control in the first section (single source: selectedOpts.gobId). */}
          {LED_OPTION_TABLES.filter((t) => t.key !== 'gobId').map((t) => (
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
            <label title="Higher-resolution supply upgrade — priced only when the admin uplift rate is set">High-resolution</label>
            <input type="checkbox" checked={highResolution} onChange={(e) => setHighResolution(e.target.checked)} style={{ width: 'auto' }} />
          </div>
          <div>
            <label>Recess depth (mm)</label>
            <input type="number" min={0} value={recessDepthMm} onChange={(e) => setRecessDepthMm(e.target.value)} placeholder="optional" />
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
        <h4 style={{ margin: '14px 0 4px' }}>Content &amp; flatness</h4>
        <div className="grid3">
          <div>
            <label>Content ratio</label>
            <input value={contentRatio} onChange={(e) => setContentRatio(e.target.value)} placeholder="e.g. 16:9" />
          </div>
          <div>
            <label>Content supplier</label>
            <input value={contentSupplier} onChange={(e) => setContentSupplier(e.target.value)} placeholder="optional" />
          </div>
          <div>
            <label>Flatness critical</label>
            <input type="checkbox" checked={flatnessRequired} onChange={(e) => setFlatnessRequired(e.target.checked)} style={{ width: 'auto' }} />
          </div>
        </div>

        {err && <div className="error" style={{ marginTop: 8 }}>{err}</div>}
        {!canAddSpecific && (
          <p className="muted" style={{ marginTop: 12 }}>
            ⚠️ Required before pricing: {missing.join(', ')}.
          </p>
        )}
        <p className="muted" style={{ marginTop: 12 }}>
          {isEditing
            ? 'Saves all changes (panel, geometry, components, options & services) to this screen and re-prices it.'
            : 'Adds the LED screen with the panel, geometry, components and the options & services above — all in one. You can still tweak options later in the per-screen editor.'}
        </p>
        <div className="step-actions">
          <button className="primary" onClick={() => addScreen()} disabled={busy || !canAddSpecific}>
            {busy ? (isEditing ? 'Saving…' : 'Pricing…') : isEditing ? 'Save changes' : '+ Add screen'}
          </button>
          {isEditing && (
            <button className="ghost" onClick={() => onCancelEdit?.()} disabled={busy} style={{ marginLeft: 8 }}>
              Cancel edit
            </button>
          )}
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
type LcdItemType = 'display' | 'mediaplayer' | 'bracket' | 'install' | 'labour' | 'location_fee' | 'warranty';
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

// AA3b — LCD Good/Better/Best tier option (display pick at a price point; cost/margin admin-only).
interface LcdTierOption {
  tier: 'value' | 'recommended' | 'premium';
  label: string;
  rationale: string;
  displayId: string;
  model: string;
  brand: string | null;
  sizeIn: number | null;
  sellAud: string;
  costAud: string | null;
  margin: string | null;
}

function LcdAddForm({ quote, onChange, editScreen, onCancelEdit }: { quote: Quote; onChange: () => Promise<void>; editScreen?: LcdScreen; onCancelEdit?: () => void }) {
  const isEditing = !!editScreen;
  const [catalog, setCatalog] = useState<Opt[]>([]);
  const [serviceHoursId, setServiceHoursId] = useState(editScreen?.serviceHoursId != null ? String(editScreen.serviceHoursId) : '');
  const [warrantyId, setWarrantyId] = useState(editScreen?.warrantyId != null ? String(editScreen.warrantyId) : '');
  const [installMethodId, setInstallMethodId] = useState(editScreen?.installMethodId != null ? String(editScreen.installMethodId) : '');
  const [serviceHours, setServiceHours] = useState<Opt[]>([]);
  const [warranties, setWarranties] = useState<Opt[]>([]);
  const [installMethods, setInstallMethods] = useState<Opt[]>([]);
  const [orientation, setOrientation] = useState(editScreen?.orientation ?? '');
  // AA1 — recess/cavity depth (mm); descriptive site-prep detail.
  const [recessDepthMm, setRecessDepthMm] = useState(editScreen?.recessDepthMm != null ? String(editScreen.recessDepthMm) : '');
  // AA3a — site/requirement fields feeding the LCD selection rules.
  const [requiresAndroid, setRequiresAndroid] = useState(editScreen?.requiresAndroid ?? false);
  const [maxDepthMm, setMaxDepthMm] = useState(editScreen?.maxDepthMm != null ? String(editScreen.maxDepthMm) : '');
  const [needsPc, setNeedsPc] = useState(editScreen?.needsPc ?? false);
  const [needsHardDrive, setNeedsHardDrive] = useState(editScreen?.needsHardDrive ?? false);
  const [screenName, setScreenName] = useState(editScreen?.screenName ?? '');
  // Pre-fill line items from the screen's stored items (V4 edit). Manual = no displayId.
  const [lines, setLines] = useState<LcdLine[]>(
    // X2: exclude SERVER-GENERATED auto lines from the editable sections — the warranty line, the auto
    // install-method labour line ("Installation — …") and the Out-of-Hours uplift line. They are
    // regenerated server-side from warrantyId/installMethodId/serviceHoursId on save (the server also
    // strips them defensively), so surfacing them as manual rows here would confuse + double-count on edit.
    () => (editScreen?.items ?? []).filter((it) => {
      if (it.itemType === 'warranty') return false;
      const d = it.description ?? '';
      if (it.itemType === 'install' && (d.startsWith('Installation — ') || /^Out of Hours uplift/i.test(d))) return false;
      return true;
    }).map((it) => {
      const manual = it.displayId == null;
      const sectionKey = LCD_SECTIONS.find((d) => d.itemType === it.itemType)?.key ?? it.itemType;
      return {
        sectionKey,
        itemType: it.itemType,
        displayId: it.displayId != null ? String(it.displayId) : undefined,
        description: it.description ?? '',
        qty: Number(it.qty) || 1,
        unitCost: manual ? Number(it.unitCost ?? 0) : undefined,
        manual,
      };
    }),
  );
  // Per-section draft (catalog pick + qty) and per-section manual draft.
  const [pick, setPick] = useState<Record<string, string>>({});
  const [pickQty, setPickQty] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  // AA3b — LCD Good/Better/Best: 2–3 display picks at different price points.
  const [lcdTiers, setLcdTiers] = useState<LcdTierOption[] | null>(null);
  const [lcdTierReasons, setLcdTierReasons] = useState<string[]>([]);
  // AA6a — commercial recommendation hints for the LCD tier cards.
  const [lcdCommercialHints, setLcdCommercialHints] = useState<CommercialHints | null>(null);
  const [targetSizeIn, setTargetSizeIn] = useState('');

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
  // AA3b — fetch 2–3 display tiers (Value/Recommended/Premium) at different price points.
  const loadLcdTiers = async () => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = {};
      if (targetSizeIn.trim() !== '') body.targetSizeIn = Number(targetSizeIn);
      const res = await api<{ options: LcdTierOption[]; reasons: string[]; distinctProducts: number; commercialHints?: CommercialHints }>(
        `/quotes/${quote.id}/lcd-options`,
        { method: 'POST', body: JSON.stringify(body) },
      );
      setLcdTiers(res.options);
      setLcdTierReasons(res.reasons);
      setLcdCommercialHints(res.commercialHints ?? null);
    } finally {
      setBusy(false);
    }
  };
  // "Use this option" — set the chosen tier's display as the Display line, then close the compare view.
  const useLcdOption = (t: LcdTierOption) => {
    const displayDef = LCD_SECTIONS.find((d) => d.itemType === 'display')!;
    setLines((ls) => [
      // Replace any existing catalog display line so the chosen tier is the display for this screen.
      ...ls.filter((l) => !(l.itemType === 'display' && !l.manual)),
      { sectionKey: displayDef.key, itemType: 'display', displayId: t.displayId, description: t.model, qty: 1, manual: false },
    ]);
    setLcdTiers(null);
    setLcdTierReasons([]);
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

  // Live preview (server is authoritative). FAITHFUL TO THE (LCD 1) TAB:
  //  • each LINE shows the LIST Sell — catalog `sell` for a catalog row, Cost × service markup for a
  //    manual row — NOT a margin gross-up; Price = Sell × Qty; Margin = (Sell − Cost)/Sell;
  //  • the HEADLINE total is the total COST grossed at the fixed LCD margin, rounded to $10 (tab G54):
  //    ROUND(Σ(cost×qty) / (1 − margin), −1). The line prices are reference and do NOT sum to it.
  const isAdmin = getRole() === 'admin';
  const MARGIN = 0.3; // lcd_margin (Reference Data F12) — display-only preview (server is authoritative)
  const SERVICE_MARKUP = 1.65; // Reference Data F16 — manual-row list sell = Cost × markup
  const costOf = (l: LcdLine): number => {
    if (l.manual) return Number(l.unitCost ?? 0);
    const row = catalog.find((x) => x.id === l.displayId);
    return Number(row?.totalCost ?? row?.usd ?? 0);
  };
  const sellOf = (l: LcdLine): number => {
    if (l.manual) return Math.round(costOf(l) * SERVICE_MARKUP * 100) / 100;
    const row = catalog.find((x) => x.id === l.displayId);
    // Catalog list sell; fall back to the margin gross-up only when the catalog row has no list sell.
    return row?.sell != null ? Number(row.sell) : Math.round(costOf(l) / (1 - MARGIN));
  };
  const marginOf = (l: LcdLine): number => {
    const s = sellOf(l);
    return s > 0 ? (s - costOf(l)) / s : 0;
  };
  // priceTotal = ROUND(Σ cost×qty / (1 − margin), nearest $10) — mirrors the server (tab G54).
  const totalCost = lines.reduce((a, l) => a + costOf(l) * l.qty, 0);
  const grand = totalCost > 0 ? Math.round(totalCost / (1 - MARGIN) / 10) * 10 : 0;
  // Analysis block (tab rows 47–54): per-section fixed-margin values, mirroring the server
  // (priceScreenMediaplayer / priceBracketShroud / priceServices). grossFixed(cost) = ROUND(cost/(1−0.30),$10).
  // Preview-only over the editable lines (server-generated install/OOH/location/warranty lines are added
  // server-side and are authoritative). Same formula the server uses.
  const grossFixed = (cost: number): number => (cost > 0 ? Math.round(cost / (1 - MARGIN) / 10) * 10 : 0);
  const costWhere = (pred: (l: LcdLine) => boolean): number =>
    lines.filter(pred).reduce((a, l) => a + costOf(l) * l.qty, 0);
  const hardwareSell = grossFixed(costWhere((l) => l.itemType === 'display' || l.itemType === 'mediaplayer'));
  const bracketSell = grossFixed(costWhere((l) => l.itemType === 'bracket'));
  const servicesSell = grossFixed(
    costWhere((l) => l.itemType === 'install' || l.itemType === 'labour' || l.itemType === 'location_fee' || l.itemType === 'warranty'),
  );
  // AA3a — brand of the chosen display line, shown read-only in the site-requirements block.
  const chosenDisplayId = lines.find((l) => l.itemType === 'display' && l.displayId)?.displayId;
  const chosenDisplayBrand = chosenDisplayId ? (catalog.find((x) => x.id === chosenDisplayId)?.brand ?? null) : null;

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
      const body = {
        screenName: screenName || undefined,
        orientation: orientation || undefined,
        ...(recessDepthMm.trim() !== '' ? { recessDepthMm: Number(recessDepthMm) } : {}),
        // AA3a — site/requirement fields (rules; checkboxes always sent, depth only when set).
        requiresAndroid,
        needsPc,
        needsHardDrive,
        ...(maxDepthMm.trim() !== '' ? { maxDepthMm: Number(maxDepthMm) } : {}),
        displayId: firstDisplay ? Number(firstDisplay) : undefined,
        serviceHoursId: serviceHoursId ? Number(serviceHoursId) : undefined,
        warrantyId: warrantyId ? Number(warrantyId) : undefined,
        installMethodId: installMethodId ? Number(installMethodId) : undefined,
        items,
      };
      if (isEditing && editScreen) {
        // V4 full re-edit — PUT replaces fields + items and re-prices.
        await api(`/quotes/${quote.id}/lcd-screens/${editScreen.id}`, { method: 'PUT', body: JSON.stringify(body) });
        await onChange();
        onCancelEdit?.();
        return;
      }
      await api(`/quotes/${quote.id}/lcd-screens`, { method: 'POST', body: JSON.stringify(body) });
      setLines([]);
      setScreenName('');
      setRecessDepthMm('');
      setRequiresAndroid(false);
      setMaxDepthMm('');
      setNeedsPc(false);
      setNeedsHardDrive(false);
      await onChange();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {isEditing && (
        <div className="card" style={{ borderColor: 'var(--accent, #4f46e5)', background: 'var(--accent-bg, rgba(79,70,229,0.06))' }}>
          <div className="list-row" style={{ alignItems: 'center' }}>
            <span><b>Editing:</b> {editScreen?.screenName || 'LCD screen'} <span className="muted">— change any field below and Save changes.</span></span>
            <button className="ghost" onClick={() => onCancelEdit?.()} disabled={busy}>Cancel edit</button>
          </div>
        </div>
      )}
      <div className="card">
        <h3 style={{ marginTop: 0 }}>{isEditing ? 'Edit LCD screen (LCD-1)' : 'New LCD screen (LCD-1)'}</h3>
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
          <div>
            <label>Recess depth (mm)</label>
            <input type="number" min={0} value={recessDepthMm} onChange={(e) => setRecessDepthMm(e.target.value)} placeholder="optional" />
          </div>
        </div>
        {/* AA3a — site requirements feeding the LCD selection rules (validation warnings). */}
        <h4 style={{ marginBottom: 6 }}>Site requirements</h4>
        <div className="grid3">
          <div>
            <label>Max mounting depth (mm)</label>
            <input type="number" min={0} value={maxDepthMm} onChange={(e) => setMaxDepthMm(e.target.value)} placeholder="optional" />
          </div>
          <div>
            <label>Display brand</label>
            <input value={chosenDisplayBrand ?? ''} readOnly placeholder="— (from chosen display)" />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, justifyContent: 'flex-end' }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={requiresAndroid} onChange={(e) => setRequiresAndroid(e.target.checked)} /> Requires Android display
            </label>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={needsPc} onChange={(e) => setNeedsPc(e.target.checked)} /> Needs PC
            </label>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={needsHardDrive} onChange={(e) => setNeedsHardDrive(e.target.checked)} /> Needs hard drive
            </label>
          </div>
        </div>
        {outOfHours && (
          <p className="muted" style={{ marginBottom: 0 }}>Out-of-hours service hours selected — an out-of-hours labour uplift will be added on save (F31).</p>
        )}
      </div>

      {/* AA3b — Good/Better/Best display comparison ("we recommend the Philips, but here's a cheaper option"). */}
      <div className="card">
        <div className="list-row" style={{ alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ maxWidth: 180 }}>
            <label>Target size (in)</label>
            <input type="number" min={0} value={targetSizeIn} onChange={(e) => setTargetSizeIn(e.target.value)} placeholder="optional" />
          </div>
          <button type="button" onClick={loadLcdTiers} disabled={busy}>Compare options (Good/Better/Best)</button>
          {lcdTiers && <button type="button" className="ghost" onClick={() => { setLcdTiers(null); setLcdTierReasons([]); }}>Hide comparison</button>}
        </div>
        {lcdTiers && lcdTiers.length === 0 && (
          <p className="muted" style={{ marginBottom: 0 }}>No display options{lcdTierReasons.length ? `: ${lcdTierReasons.join(' ')}` : '.'}</p>
        )}
        {lcdTiers && lcdTiers.length > 0 && (
          <>
            {lcdTierReasons.length > 0 && <p className="muted">{lcdTierReasons.join(' ')}</p>}
            <div className="grid3" style={{ alignItems: 'stretch' }}>
              {lcdTiers.map((t) => {
                const emphasised = lcdCommercialHints?.emphasisTier === t.tier;
                return (
                <div
                  key={t.tier}
                  className="card"
                  style={{
                    margin: 0,
                    borderColor: t.tier === 'recommended' || emphasised ? 'var(--accent, #4f46e5)' : undefined,
                    borderWidth: t.tier === 'recommended' || emphasised ? 2 : undefined,
                  }}
                >
                  <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700, marginBottom: 4 }}>
                    {t.label}
                    {emphasised && (
                      <span
                        title={`Matches the client's ${lcdCommercialHints?.priceSensitivity} price sensitivity`}
                        style={{
                          marginLeft: 6, padding: '0 6px', borderRadius: 10, fontSize: 10, fontWeight: 700,
                          textTransform: 'none', letterSpacing: 0,
                          background: 'var(--accent-bg, rgba(79,70,229,0.12))', color: 'var(--accent, #4f46e5)',
                          cursor: 'help', whiteSpace: 'nowrap',
                        }}
                      >
                        Matches price sensitivity
                      </span>
                    )}
                  </div>
                  <p className="muted" style={{ marginTop: 0 }}>{t.rationale}</p>
                  {t.tier === 'recommended' && lcdCommercialHints?.typicalSelectionNote && (
                    <p className="muted" style={{ marginTop: 0, fontStyle: 'italic' }}>
                      Client typically selects: {lcdCommercialHints.typicalSelectionNote}
                    </p>
                  )}
                  <div style={{ fontWeight: 600 }}>{t.model}</div>
                  <table style={{ width: '100%', fontSize: 13, margin: '8px 0' }}>
                    <tbody>
                      <tr><td className="muted">Brand</td><td>{t.brand ?? '—'}</td></tr>
                      <tr><td className="muted">Size (in)</td><td>{t.sizeIn != null ? t.sizeIn : '—'}</td></tr>
                      <tr><td className="muted">Sell</td><td>${Number(t.sellAud).toLocaleString()}</td></tr>
                      {isAdmin && (
                        <>
                          <tr><td className="muted">Cost</td><td>{t.costAud ? `$${Number(t.costAud).toLocaleString()}` : '—'}</td></tr>
                          <tr><td className="muted">Margin</td><td>{t.margin ? `${(Number(t.margin) * 100).toFixed(1)}%` : '—'}</td></tr>
                        </>
                      )}
                    </tbody>
                  </table>
                  <button className="primary" onClick={() => useLcdOption(t)} disabled={busy} style={{ width: '100%' }}>
                    Use this option
                  </button>
                </div>
                );
              })}
            </div>
          </>
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
            {secLines.length > 0 && (
              <div className="list-row muted" style={{ gap: 8, alignItems: 'center', fontSize: 12, fontWeight: 600 }}>
                <span style={{ flex: 1 }}>Description</span>
                {isAdmin && <span style={{ width: 90, textAlign: 'right' }}>Cost</span>}
                <span style={{ width: 90, textAlign: 'right' }}>Sell</span>
                <span style={{ width: 64, textAlign: 'right' }}>Qty</span>
                <span style={{ width: 100, textAlign: 'right' }}>Price</span>
                {isAdmin && <span style={{ width: 64, textAlign: 'right' }}>Margin</span>}
                <span style={{ width: 24 }} />
              </div>
            )}
            {secLines.map(({ l, i }) => (
              <div className="list-row" key={i} style={{ gap: 8, alignItems: 'center' }}>
                {l.manual ? (
                  <input style={{ flex: 1 }} value={l.description} placeholder="Description" onChange={(e) => updateLine(i, { description: e.target.value })} />
                ) : (
                  <span style={{ flex: 1 }}>{l.description}</span>
                )}
                {isAdmin && (
                  l.manual ? (
                    <input style={{ width: 90, textAlign: 'right' }} type="number" value={l.unitCost ?? 0} title="Unit cost" onChange={(e) => updateLine(i, { unitCost: Number(e.target.value) })} />
                  ) : (
                    <span style={{ width: 90, textAlign: 'right' }}>{costOf(l).toLocaleString()}</span>
                  )
                )}
                <span style={{ width: 90, textAlign: 'right' }}>{sellOf(l).toLocaleString()}</span>
                <input style={{ width: 64 }} type="number" min="1" value={l.qty} onChange={(e) => updateLine(i, { qty: Number(e.target.value) || 1 })} />
                <span style={{ width: 100, textAlign: 'right' }}>{quote.currency?.code} {(sellOf(l) * l.qty).toLocaleString()}</span>
                {isAdmin && <span style={{ width: 64, textAlign: 'right' }}>{(marginOf(l) * 100).toFixed(0)}%</span>}
                <button onClick={() => removeLine(i)} aria-label="Remove">✕</button>
              </div>
            ))}
          </div>
        );
      })}

      <div className="card">
        <div className="list-row" style={{ fontWeight: 600 }}>
          <span>Total (fixed 30% margin)</span>
          <span>{quote.currency?.code} {grand.toLocaleString()}</span>
        </div>
        <p className="muted" style={{ margin: '2px 0 8px', fontSize: 12 }}>
          Line prices are list reference; the quote uses the fixed-margin total — ROUND(Σ cost ÷ (1 − 30%), $10). Server is authoritative.
        </p>
        {/* Analysis block (tab rows 47–54): per-section fixed-margin sells (server authoritative). */}
        <div style={{ borderTop: '1px solid var(--border, #e5e5e5)', margin: '4px 0 8px', paddingTop: 8 }}>
          <div className="list-row" style={{ fontWeight: 600, fontSize: 12 }}>
            <span style={{ flex: 1 }}>Analysis</span>
          </div>
          <div className="list-row" style={{ fontSize: 13 }}>
            <span style={{ flex: 1 }}>Total Hardware @ margin</span>
            <span>{quote.currency?.code} {hardwareSell.toLocaleString()}</span>
          </div>
          <div className="list-row" style={{ fontSize: 13 }}>
            <span style={{ flex: 1 }}>Bracket &amp; Shroud @ margin</span>
            <span>{quote.currency?.code} {bracketSell.toLocaleString()}</span>
          </div>
          <div className="list-row" style={{ fontSize: 13 }}>
            <span style={{ flex: 1 }}>Total Services @ margin</span>
            <span>{quote.currency?.code} {servicesSell.toLocaleString()}</span>
          </div>
          <div className="list-row" style={{ fontWeight: 700 }}>
            <span style={{ flex: 1 }}>Total At Fixed Margin</span>
            <span>{quote.currency?.code} {grand.toLocaleString()}</span>
          </div>
        </div>
        <div className="step-actions">
          <button className="primary" onClick={save} disabled={busy || lines.length === 0}>
            {busy ? 'Saving…' : isEditing ? 'Save changes' : '+ Add LCD screen'}
          </button>
          {isEditing && (
            <button className="ghost" onClick={() => onCancelEdit?.()} disabled={busy} style={{ marginLeft: 8 }}>
              Cancel edit
            </button>
          )}
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
  const [highResolution, setHighResolution] = useState(!!screen.highResolution); // AA4
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
        highResolution,
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
          <label title="Higher-resolution supply upgrade — priced only when the admin uplift rate is set">High-resolution</label>
          <input type="checkbox" checked={highResolution} disabled={!canWrite} onChange={(e) => { setHighResolution(e.target.checked); setSaved(false); }} style={{ width: 'auto' }} />
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

// The full PriceResult shape (mirrors service.ts priceQuote). Shared by the Review "Itemised price"
// card and the inline per-screen cost breakdown in Select Screens.
interface PriceResult {
  costVisible: boolean;
  sections: PriceSection[];
  overrides?: OverrideSummary[];
  hasOverrides?: boolean;
  licences: Array<{ screenType: string; tier: string; qty: number; isInteractive: boolean; annual: string }>;
  discount?: { pct: number; source: 'quote' | 'client' | 'system'; scope?: 'one_off' | 'recurring'; amount: string };
  discountMode?: 'stack' | 'item_only';
  hasLineDiscounts?: boolean;
  totals: {
    equipment: string; services: string; recurring: string; grandTotal: string;
    margin: string | null; marginFloor: number | null;
  };
}

// Inline per-screen cost-breakdown table (moved out of the old right-side drawer so the breakdown sits
// next to each screen in the list). Renders one price section's lines with cost (admin-only) / sell /
// editable per-line discount % / effective sell. The price fetch + discount-commit live in the parent
// (SelectScreensStep) so a single /price load feeds every row.
function ScreenBreakdownTable({
  section, cur, costVisible, canWrite, discDraft, setDiscDraft, commitDiscount,
}: {
  section: PriceSection;
  cur: string;
  costVisible: boolean;
  canWrite: boolean;
  discDraft: Record<string, string>;
  setDiscDraft: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  commitDiscount: (type: 'led' | 'lcd' | 'licence', lineId: string, raw: string) => void;
}) {
  if (section.lines.length === 0) return <p className="muted" style={{ margin: '6px 0 0' }}>No priced lines yet.</p>;
  return (
    <div className="table-wrap" style={{ marginTop: 6 }}>
      <table>
        <thead>
          <tr>
            <th>Label</th>
            <th className="cell-num">Qty</th>
            {costVisible && <th className="cell-num">Cost</th>}
            <th className="cell-num">Sell</th>
            <th className="cell-num">Disc %</th>
            <th className="cell-num">Effective sell</th>
          </tr>
        </thead>
        <tbody>
          {section.lines.map((l) => (
            <tr key={l.id}>
              <td>{l.label} <span className="muted">{l.category ? `· ${l.category}` : ''}</span></td>
              <td className="cell-num">{l.qty}</td>
              {costVisible && <td className="cell-num">{cur} {Number(l.cost ?? 0).toLocaleString()}</td>}
              <td className="cell-num">{cur} {Number(l.sell ?? 0).toLocaleString()}</td>
              <td className="cell-num">
                {canWrite && section.type !== 'licence' ? (
                  <input
                    type="number" min={0} max={100} step="0.5"
                    value={discDraft[l.id] ?? ''}
                    placeholder="—"
                    style={{ width: 68, textAlign: 'right' }}
                    onChange={(e) => setDiscDraft((p) => ({ ...p, [l.id]: e.target.value }))}
                    onBlur={(e) => commitDiscount(section.type, l.id, e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                    title="Per-line discount %. Clear to remove."
                  />
                ) : (
                  <span>{l.discountPct != null ? `${(l.discountPct * 100).toFixed(l.discountPct * 100 % 1 ? 1 : 0)}%` : '—'}</span>
                )}
              </td>
              <td className="cell-num">{cur} {Number(l.effectiveSell).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Row label for the screens list: prefer the user's own screen name, else "Manufacturer - Model"
// (e.g. "LEDFul - IAF250 / WALL1.9 COB") for LED, or the display model for LCD.
function ledScreenLabel(s: LedScreen): string {
  const named = s.screenName?.trim();
  if (named) return named;
  const model = s.ledProduct?.model?.trim();
  if (!model) return 'LED screen';
  const mfr = s.ledProduct?.manufacturer?.name?.trim();
  return mfr ? `${mfr} - ${model}` : model;
}
function lcdScreenLabel(s: LcdScreen): string {
  return s.screenName?.trim() || s.display?.model?.trim() || 'LCD screen';
}

/** One entry in a {@link RowMenu} — an action, or a 'divider' separator. */
type RowMenuItem = 'divider' | { label: string; onClick: () => void; danger?: boolean; disabled?: boolean };

/**
 * Compact "⋯" actions menu for a screen row — collapses the per-row action buttons (which overflowed
 * the card) into a click-away popover so the row stays within the frame. `active` highlights the
 * trigger when the row is the one currently being edited/expanded.
 */
function RowMenu({ items, active }: { items: RowMenuItem[]; active?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onEsc);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onEsc); };
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        className={active ? 'primary' : 'ghost'}
        title="Actions"
        aria-label="Actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        ⋯
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute', right: 0, top: 'calc(100% + 4px)', zIndex: 60, minWidth: 190,
            background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
            boxShadow: '0 10px 30px var(--shadow)', overflow: 'hidden', padding: 4,
          }}
        >
          {items.map((it, idx) =>
            it === 'divider' ? (
              <div key={idx} style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }} />
            ) : (
              <button
                key={idx}
                role="menuitem"
                className="ghost"
                disabled={it.disabled}
                onClick={() => { setOpen(false); it.onClick(); }}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', border: 'none', borderRadius: 6,
                  color: it.danger ? 'var(--danger)' : 'var(--text)', whiteSpace: 'nowrap',
                }}
              >
                {it.label}
              </button>
            ),
          )}
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
  // V4 Part A — which screen (if any) is being full-edited in-place, by type + id.
  const [editing, setEditing] = useState<{ type: 'LED' | 'LCD'; id: string } | null>(null);
  const cur = quote.currency?.code ?? '';

  // Inline cost breakdown (moved out of the old drawer): a single /price load feeds every row's
  // expandable breakdown + the bottom quote-totals summary. Keyed set of open breakdown rows.
  const [price, setPrice] = useState<PriceResult | null>(null);
  const [priceErr, setPriceErr] = useState<string | null>(null);
  const [discDraft, setDiscDraft] = useState<Record<string, string>>({});
  const [modeBusy, setModeBusy] = useState(false);
  const [bkOpen, setBkOpen] = useState<Set<string>>(new Set());
  const toggleBk = (key: string) =>
    setBkOpen((prev) => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; });

  const loadPrice = useCallback(async () => {
    try {
      const p = await api<PriceResult>(`/quotes/${quote.id}/price`, { method: 'POST' });
      setPrice(p);
      const seed: Record<string, string> = {};
      for (const sec of p.sections) for (const l of sec.lines) {
        seed[l.id] = l.discountPct != null ? String(Math.round(l.discountPct * 1000) / 10) : '';
      }
      setDiscDraft(seed);
      setPriceErr(null);
    } catch (e) {
      setPriceErr(e instanceof Error ? e.message : 'Pricing failed');
    }
  }, [quote.id]);

  // Reload the breakdown whenever the parent refetches the quote (add/edit/qty/delete/discount).
  useEffect(() => { void loadPrice(); }, [loadPrice, quote]);

  const sectionFor = (type: 'led' | 'lcd', id: string): PriceSection | null =>
    price?.sections.find((s) => s.type === type && s.screenId === id) ?? null;

  // Persist a per-line discount; routes by section type (LED cost-breakdown line vs LCD item).
  const commitDiscount = async (type: 'led' | 'lcd' | 'licence', lineId: string, raw: string) => {
    if (type === 'licence') return;
    const trimmed = raw.trim();
    let pct: number | null;
    if (trimmed === '') pct = null;
    else {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n < 0 || n > 100) { setPriceErr('Discount must be 0–100%.'); return; }
      pct = n / 100;
    }
    setPriceErr(null);
    const path = type === 'led'
      ? `/quotes/${quote.id}/led-lines/${lineId}/discount`
      : `/quotes/${quote.id}/lcd-items/${lineId}/discount`;
    try {
      await api(path, { method: 'PATCH', body: JSON.stringify({ discountPct: pct }) });
      await onChange(); // refetch quote → the effect above reloads price + totals.
    } catch (e) {
      setPriceErr(e instanceof Error ? e.message : 'Discount update failed');
    }
  };

  // Quote-wide discount mode (stack vs item_only) via updateQuote (optimistic lock).
  const setMode = async (mode: 'stack' | 'item_only') => {
    if (mode === (price?.discountMode ?? quote.discountMode ?? 'stack')) return;
    setModeBusy(true);
    setPriceErr(null);
    try {
      await api(`/quotes/${quote.id}`, { method: 'PATCH', body: JSON.stringify({ discountMode: mode, expectedVersion: quote.lockVersion }) });
      await onChange();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'conflict') { await onChange(); setPriceErr('Quote changed elsewhere — reloaded.'); }
      else setPriceErr(e instanceof Error ? e.message : 'Could not change discount mode');
    } finally {
      setModeBusy(false);
    }
  };

  const mode = price?.discountMode ?? quote.discountMode ?? 'stack';
  const costVisible = price?.costVisible ?? false;

  // Resolve the currently-edited screen record (kept in sync with the refetched quote).
  const editLed = editing?.type === 'LED' ? quote.ledScreens.find((s) => s.id === editing.id) : undefined;
  const editLcd = editing?.type === 'LCD' ? quote.lcdScreens.find((s) => s.id === editing.id) : undefined;
  const startEdit = (type: 'LED' | 'LCD', id: string) => {
    setScreenType(type);
    setEditing({ type, id });
    setExpanded(null);
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const cancelEdit = () => setEditing(null);

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
          <div style={{ display: 'flex', gap: 8 }}>
            {canWrite && !editing && (
              <>
                <button className={screenType === 'LED' ? 'primary' : 'ghost'} onClick={() => setScreenType('LED')}>LED</button>
                <button className={screenType === 'LCD' ? 'primary' : 'ghost'} onClick={() => setScreenType('LCD')}>LCD</button>
              </>
            )}
          </div>
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
          {editing
            ? `Editing a ${editing.type} screen below — Save changes or Cancel edit to return to the add flow.`
            : `Pick a screen type, then add screens with the ${screenType} flow below. All screens on this quote appear in the combined list — expand a row's Cost breakdown to see its priced lines.`}
        </p>
      </div>

      {canWrite && screenType === 'LED' && (
        <LedAddForm
          key={editLed ? `edit-${editLed.id}` : 'add'}
          quote={quote}
          onChange={onChange}
          editScreen={editLed}
          onCancelEdit={cancelEdit}
        />
      )}
      {canWrite && screenType === 'LCD' && (
        <LcdAddForm
          key={editLcd ? `edit-${editLcd.id}` : 'add'}
          quote={quote}
          onChange={onChange}
          editScreen={editLcd}
          onCancelEdit={cancelEdit}
        />
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Screens on this quote ({totalScreens})</h3>
        {totalScreens === 0 && <p className="muted">None yet — this step is optional.</p>}

        {quote.ledScreens.map((s, i) => (
          <div key={`led-${s.id}`} style={{ borderBottom: '1px solid var(--border)', paddingBottom: 10, marginBottom: 10 }}>
            <div className="list-row">
              <div>
                <span className="pill" style={{ marginRight: 6 }}>LED</span>
                <b>{ledScreenLabel(s)}</b>{' '}
                <span className="muted">
                  {[
                    s.resolutionWpx && s.resolutionHpx ? `${s.resolutionWpx}×${s.resolutionHpx}px` : '',
                    s.orientation ?? '',
                    s.aspectRatio?.ratioLabel ?? '',
                  ].filter(Boolean).join(' · ')}
                </span>
              </div>
              <div className="row-actions" style={{ alignItems: 'center' }}>
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
                <RowMenu
                  active={expanded === s.id || bkOpen.has(`led-${s.id}`) || (editing?.type === 'LED' && editing.id === s.id)}
                  items={[
                    { label: expanded === s.id ? 'Hide options & services' : 'Options & services', onClick: () => setExpanded(expanded === s.id ? null : s.id) },
                    { label: bkOpen.has(`led-${s.id}`) ? 'Hide cost breakdown' : 'Cost breakdown', onClick: () => toggleBk(`led-${s.id}`) },
                    ...(canWrite
                      ? ([
                          'divider',
                          { label: '✎ Edit', onClick: () => startEdit('LED', s.id) },
                          { label: 'Duplicate', onClick: () => duplicateLed(s.id) },
                          { label: '▲ Move up', disabled: i === 0, onClick: () => moveLed(i, -1) },
                          { label: '▼ Move down', disabled: i === quote.ledScreens.length - 1, onClick: () => moveLed(i, 1) },
                          'divider',
                          { label: 'Delete', danger: true, onClick: () => removeLed(s.id) },
                        ] as RowMenuItem[])
                      : []),
                  ]}
                />
              </div>
            </div>
            {expanded === s.id && <LedOptionsEditor quote={quote} screen={s} onChange={onChange} />}
            {bkOpen.has(`led-${s.id}`) && (
              sectionFor('led', s.id)
                ? <ScreenBreakdownTable section={sectionFor('led', s.id)!} cur={cur} costVisible={costVisible} canWrite={canWrite} discDraft={discDraft} setDiscDraft={setDiscDraft} commitDiscount={commitDiscount} />
                : <p className="muted" style={{ margin: '6px 0 0' }}>{priceErr ?? 'Loading breakdown…'}</p>
            )}
          </div>
        ))}

        {quote.lcdScreens.map((s) => (
          <div key={`lcd-${s.id}`} style={{ borderBottom: '1px solid var(--border)', paddingBottom: 10, marginBottom: 10 }}>
            <div className="list-row">
              <div>
                <span className="pill" style={{ marginRight: 6 }}>LCD</span>
                <b>{lcdScreenLabel(s)}</b>
              </div>
              <div className="row-actions" style={{ alignItems: 'center' }}>
                <span>{cur} {Number(s.priceTotal ?? 0).toLocaleString()}</span>
                <RowMenu
                  active={bkOpen.has(`lcd-${s.id}`) || (editing?.type === 'LCD' && editing.id === s.id)}
                  items={[
                    { label: bkOpen.has(`lcd-${s.id}`) ? 'Hide cost breakdown' : 'Cost breakdown', onClick: () => toggleBk(`lcd-${s.id}`) },
                    ...(canWrite ? ([{ label: '✎ Edit', onClick: () => startEdit('LCD', s.id) }] as RowMenuItem[]) : []),
                  ]}
                />
              </div>
            </div>
            {bkOpen.has(`lcd-${s.id}`) && (
              sectionFor('lcd', s.id)
                ? <ScreenBreakdownTable section={sectionFor('lcd', s.id)!} cur={cur} costVisible={costVisible} canWrite={canWrite} discDraft={discDraft} setDiscDraft={setDiscDraft} commitDiscount={commitDiscount} />
                : <p className="muted" style={{ margin: '6px 0 0' }}>{priceErr ?? 'Loading breakdown…'}</p>
            )}
          </div>
        ))}
      </div>

      {/* Quote-wide totals + discount mode (moved from the old drawer to sit under the list). */}
      {totalScreens > 0 && (
        <div className="card">
          <div className="topbar">
            <h3 style={{ margin: 0 }}>Quote totals</h3>
            <button className="ghost" onClick={() => void loadPrice()}>↻ Refresh</button>
          </div>
          {priceErr && <div className="error" style={{ marginTop: 8 }}>{priceErr}</div>}
          {!price && !priceErr && <p className="muted">Loading price…</p>}
          {price && (
            <>
              {canWrite ? (
                <div style={{ margin: '4px 0 12px' }}>
                  <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>Discount mode</label>
                  <div role="group" style={{ display: 'inline-flex', gap: 4 }}>
                    <button className={mode === 'stack' ? 'primary' : 'ghost'} disabled={modeBusy} onClick={() => setMode('stack')} type="button">Stack (item + quote discount)</button>
                    <button className={mode === 'item_only' ? 'primary' : 'ghost'} disabled={modeBusy} onClick={() => setMode('item_only')} type="button">Per-item only</button>
                  </div>
                  <p className="muted" style={{ margin: '6px 0 0' }}>
                    {mode === 'stack'
                      ? 'Per-line discounts and the quote/client discount both apply (they stack).'
                      : 'Only per-line discounts apply; the quote/client discount is suppressed while any line discount exists.'}
                  </p>
                </div>
              ) : (
                <p className="muted" style={{ marginTop: 4 }}>Read-only role — discounts and mode are view-only.</p>
              )}
              {!price.costVisible && <p className="muted">Cost hidden for your role.</p>}

              {price.licences.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <b>Licences</b>
                  <div className="table-wrap" style={{ marginTop: 6 }}>
                    <table>
                      <thead><tr><th>Screen type</th><th>Tier</th><th className="cell-num">Qty</th><th>Interactive</th><th className="cell-num">Annual</th></tr></thead>
                      <tbody>
                        {price.licences.map((l, li) => (
                          <tr key={li}>
                            <td>{l.screenType}</td><td className="muted">{l.tier}</td><td className="cell-num">{l.qty}</td>
                            <td>{l.isInteractive ? 'Yes' : 'No'}</td><td className="cell-num">{cur} {Number(l.annual).toLocaleString()}</td>
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
                    <div className="label">Discount ({(price.discount.pct * 100).toFixed(price.discount.pct * 100 % 1 ? 1 : 0)}% · {price.discount.scope === 'recurring' ? 'per renewal' : 'one-off'})</div>
                    <div className="value" style={{ color: 'var(--danger, #dc2626)' }}>− {cur} {Number(price.discount.amount).toLocaleString()}</div>
                  </div>
                )}
                <div className="stat"><div className="label">Grand total</div><div className="value">{cur} {Number(price.totals.grandTotal).toLocaleString()}</div></div>
                {price.totals.margin != null && (() => {
                  const margin = Number(price.totals.margin);
                  const floor = price.totals.marginFloor;
                  const below = floor != null && margin < floor;
                  return (
                    <>
                      <div className="stat"><div className="label">Margin</div><div className="value" style={below ? { color: 'var(--danger, #dc2626)' } : undefined}>{(margin * 100).toFixed(1)}%{below ? ' ⛔' : ''}</div></div>
                      {floor != null && <div className="stat"><div className="label">Margin floor</div><div className="value">{(floor * 100).toFixed(1)}%</div></div>}
                    </>
                  );
                })()}
              </div>
            </>
          )}
        </div>
      )}
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

// The immutable rule-set a version froze (snapshot.ruleSet). Every field is optional so OLD
// snapshots (created before this feature) render defensively — missing sections are skipped.
interface RuleSet {
  markups?: Record<string, number>;
  freight?: Record<string, number>;
  addOns?: Record<string, number>;
  rates?: Record<string, number>;
  financialBumpers?: Record<string, number | null>;
  marginFloor?: number;
  minGrossMargin?: number;
  walkAwayMargin?: number;
  discountCapPct?: number;
  discountNoteThresholdPct?: number;
  discount?: { pct?: number; source?: string; scope?: string };
  clientTier?: { name?: string; preferredFreight?: string; defaultDiscountPct?: number } | null;
  anomalyRules?: Array<{ key?: string; label?: string; enabled?: boolean; severity?: string; paramNum?: number | null }>;
  manufacturerPriorities?: Array<{ name?: string; priority?: number }>;
  capturedAt?: string;
}

// The full quote-tree snapshot a version captured. Only the fields this modal reads are typed;
// the rest of the tree is intentionally left loose (it's an immutable historical artifact).
interface VersionSnapshot {
  grandTotal?: string | number | null;
  createdAt?: string;
  createdBy?: { name?: string } | string | null;
  ledScreens?: unknown[];
  lcdScreens?: unknown[];
  ruleSet?: RuleSet;
}

interface VersionView {
  revisionNo: number;
  label: string | null;
  snapshot: VersionSnapshot;
}

// camelCase / snake_case key → "Title Case" human label.
function titleCase(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// n → "28%" (0 decimals) or "12.5%" (1 decimal only when needed).
function pct(n: number): string {
  const v = n * 100;
  return `${v.toFixed(v % 1 ? 1 : 0)}%`;
}

// Read-only modal showing one version's captured rule-set + a contents summary. Mirrors
// PreviewModal (click-away scrim + ✕). Renders `ruleSet` generically so it tolerates whatever
// keys a given snapshot froze — missing sections are skipped, never crashing on undefined.
function VersionViewModal({ view, cur, onClose }: { view: VersionView; cur: string; onClose: () => void }) {
  const { snapshot } = view;
  const rs = snapshot.ruleSet;

  // Esc closes (PreviewModal is click/✕ only; we extend it here to satisfy the spec's Esc note).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const money = (v: unknown): string => `${cur} ${Number(v ?? 0).toLocaleString()}`;
  const createdBy = typeof snapshot.createdBy === 'string'
    ? snapshot.createdBy
    : snapshot.createdBy?.name;
  const ledCount = snapshot.ledScreens?.length ?? 0;
  const lcdCount = snapshot.lcdScreens?.length ?? 0;

  // Scalar top-level rule fields, in a stable order with human labels. Margin/discount fractions
  // (< 1) are shown as percentages; everything else as-is.
  const scalarRows: Array<[string, number | undefined]> = [
    ['Min gross margin', rs?.minGrossMargin],
    ['Walk-away margin', rs?.walkAwayMargin],
    ['Margin floor', rs?.marginFloor],
    ['Discount cap', rs?.discountCapPct],
    ['Note threshold', rs?.discountNoteThresholdPct],
  ];
  const scalars = scalarRows.filter(([, v]) => typeof v === 'number') as Array<[string, number]>;

  // A titled 2-column key/value sub-block for an object group (markups, freight, …).
  const ObjBlock = ({ title, obj, asPct }: { title: string; obj: Record<string, unknown> | undefined; asPct?: (k: string) => boolean }) => {
    if (!obj || Object.keys(obj).length === 0) return null;
    return (
      <div style={{ marginTop: 12 }}>
        <h4 style={{ margin: '0 0 6px' }}>{title}</h4>
        <table style={{ width: '100%', fontSize: 13 }}>
          <tbody>
            {Object.entries(obj).map(([k, val]) => {
              const showPct = asPct?.(k) && typeof val === 'number';
              return (
                <tr key={k}>
                  <td className="muted" style={{ paddingRight: 12 }}>{titleCase(k)}</td>
                  <td>{val == null ? '—' : showPct ? pct(val as number) : String(val)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <div
        className="card"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 640, width: '100%', margin: 0, maxHeight: '90vh', overflowY: 'auto', position: 'relative' }}
      >
        <button className="ghost" onClick={onClose} aria-label="Close" style={{ position: 'absolute', top: 8, right: 8 }}>✕</button>
        <h3 style={{ marginTop: 0 }}>Version v{view.revisionNo}{view.label ? ` — ${view.label}` : ''}</h3>

        {/* Summary */}
        <div style={{ marginBottom: 8 }}>
          <h4 style={{ margin: '0 0 6px' }}>Summary</h4>
          <table style={{ width: '100%', fontSize: 13 }}>
            <tbody>
              <tr><td className="muted" style={{ paddingRight: 12 }}>Label</td><td>{view.label ?? '—'}</td></tr>
              <tr><td className="muted">Grand total</td><td>{money(snapshot.grandTotal)}</td></tr>
              {createdBy && <tr><td className="muted">Created by</td><td>{createdBy}</td></tr>}
              {snapshot.createdAt && <tr><td className="muted">Created at</td><td>{new Date(snapshot.createdAt).toLocaleString()}</td></tr>}
              {rs?.capturedAt && <tr><td className="muted">Rules captured</td><td>{new Date(rs.capturedAt).toLocaleString()}</td></tr>}
              <tr>
                <td className="muted">Contents</td>
                <td>
                  {ledCount} LED + {lcdCount} LCD screen{ledCount + lcdCount === 1 ? '' : 's'}
                  {rs?.discount && typeof rs.discount.pct === 'number'
                    ? ` · discount ${pct(rs.discount.pct)}${rs.discount.source ? ` (${rs.discount.source}` : ''}${rs.discount.scope ? `, ${rs.discount.scope})` : rs.discount.source ? ')' : ''}`
                    : ''}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Rules in force */}
        <h4 style={{ margin: '12px 0 6px' }}>Rules in force at this version</h4>
        {!rs && <p className="muted">This version predates rule-set capture — no rules were frozen.</p>}
        {rs && (
          <>
            {scalars.length > 0 && (
              <table style={{ width: '100%', fontSize: 13 }}>
                <tbody>
                  {scalars.map(([label, v]) => (
                    <tr key={label}>
                      <td className="muted" style={{ paddingRight: 12 }}>{label}</td>
                      <td>{v < 1 ? pct(v) : String(v)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <ObjBlock title="Markups" obj={rs.markups} />
            <ObjBlock title="Freight" obj={rs.freight} />
            <ObjBlock title="Add-ons" obj={rs.addOns} asPct={(k) => k.toLowerCase().endsWith('pct')} />
            <ObjBlock title="Financial bumpers" obj={rs.financialBumpers as Record<string, unknown> | undefined} />
            <ObjBlock title="Exchange rates" obj={rs.rates} />

            {rs.discount && (
              <div style={{ marginTop: 12 }}>
                <h4 style={{ margin: '0 0 6px' }}>Resolved discount</h4>
                <table style={{ width: '100%', fontSize: 13 }}>
                  <tbody>
                    <tr><td className="muted" style={{ paddingRight: 12 }}>Pct</td><td>{typeof rs.discount.pct === 'number' ? pct(rs.discount.pct) : '—'}</td></tr>
                    <tr><td className="muted">Source</td><td>{rs.discount.source ?? '—'}</td></tr>
                    <tr><td className="muted">Scope</td><td>{rs.discount.scope ?? '—'}</td></tr>
                  </tbody>
                </table>
              </div>
            )}

            <div style={{ marginTop: 12 }}>
              <h4 style={{ margin: '0 0 6px' }}>Client tier</h4>
              {rs.clientTier == null
                ? <p className="muted" style={{ margin: 0 }}>No tier</p>
                : (
                  <table style={{ width: '100%', fontSize: 13 }}>
                    <tbody>
                      <tr><td className="muted" style={{ paddingRight: 12 }}>Name</td><td>{rs.clientTier.name ?? '—'}</td></tr>
                      <tr><td className="muted">Preferred freight</td><td>{rs.clientTier.preferredFreight ?? '—'}</td></tr>
                      <tr><td className="muted">Default discount</td><td>{typeof rs.clientTier.defaultDiscountPct === 'number' ? pct(rs.clientTier.defaultDiscountPct) : '—'}</td></tr>
                    </tbody>
                  </table>
                )}
            </div>

            {rs.anomalyRules && rs.anomalyRules.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <h4 style={{ margin: '0 0 6px' }}>Anomaly rules</h4>
                <table style={{ width: '100%', fontSize: 13 }}>
                  <thead>
                    <tr><th style={{ textAlign: 'left' }}>Rule</th><th style={{ textAlign: 'left' }}>Severity</th><th style={{ textAlign: 'left' }}>Enabled</th><th style={{ textAlign: 'left' }}>Param</th></tr>
                  </thead>
                  <tbody>
                    {rs.anomalyRules.map((r, i) => (
                      <tr key={r.key ?? i}>
                        <td>{r.label ?? r.key ?? '—'}</td>
                        <td style={{ color: r.severity === 'block' ? 'var(--danger)' : r.severity === 'warn' ? 'var(--warn, #d97706)' : undefined }}>{r.severity ?? '—'}</td>
                        <td>{r.enabled ? '✓' : '✗'}</td>
                        <td>{r.paramNum ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {rs.manufacturerPriorities && rs.manufacturerPriorities.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <h4 style={{ margin: '0 0 6px' }}>Manufacturer priorities</h4>
                <table style={{ width: '100%', fontSize: 13 }}>
                  <thead>
                    <tr><th style={{ textAlign: 'left' }}>Manufacturer</th><th style={{ textAlign: 'left' }}>Priority</th></tr>
                  </thead>
                  <tbody>
                    {[...rs.manufacturerPriorities]
                      .sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity))
                      .map((m, i) => (
                        <tr key={m.name ?? i}><td>{m.name ?? '—'}</td><td>{m.priority ?? '—'}</td></tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// One field-level difference between two version snapshots. `from`/`to` is null when the
// path exists in only one snapshot (a field/screen added or removed structurally).
interface DiffEntry { path: string; from: unknown | null; to: unknown | null }

interface ValidationFinding { rule: string; severity: 'error' | 'warning' | 'cannot_evaluate'; message: string }
interface AnomalyFinding { rule: string; severity: 'error' | 'warning'; message: string; screenId?: string }
interface QuoteValidation {
  canFinalise: boolean;
  counts: { error: number; warning: number; cannotEvaluate: number };
  screens: Array<{ screenId: string; screenName: string; findings: ValidationFinding[] }>;
  anomalies: AnomalyFinding[];
}

interface PriceLine {
  id: string; label: string; category: string | null; qty: number;
  cost: string | null; sell: string | null;
  // V2 — per-line discount fraction 0..1 (null when none) + the effective (post-discount) sell.
  discountPct: number | null; effectiveSell: string;
}
interface PriceSection {
  type: 'led' | 'lcd' | 'licence'; name: string; screenId?: string; lines: PriceLine[]; total: string;
  overridden?: boolean; targetId?: string; computedTotal?: string;
}
interface OverrideSummary {
  id: string; targetType: string; targetId: string | null; fieldName: string;
  originalValue: string; overrideValue: string; reason: string | null;
  createdBy: { id: string; name: string } | null; createdAt: string;
}
interface OverrideResult { override: OverrideSummary; warning: string | null }
// (PriceResult is declared above, near ScreenBreakdownTable, and reused by ReviewStep.)

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
  // View a single version's full captured rule-set + contents (read-only modal).
  const [versionView, setVersionView] = useState<VersionView | null>(null);
  const [versionViewBusy, setVersionViewBusy] = useState<number | null>(null);
  const [versionViewError, setVersionViewError] = useState<string | null>(null);
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
  const viewVersion = async (rev: number) => {
    setVersionViewBusy(rev);
    setVersionViewError(null);
    try {
      const v = await api<VersionView>(`/quotes/${quote.id}/versions/${rev}`);
      setVersionView(v);
    } catch (e) {
      setVersionViewError(e instanceof Error ? e.message : 'Could not load version');
    } finally {
      setVersionViewBusy(null);
    }
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
        {validation && validation.screens.length === 0 && validation.anomalies.length === 0 && (
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
                      <span
                        title={
                          f.severity === 'error'
                            ? 'Error — blocks finalisation'
                            : f.severity === 'warning'
                              ? 'Warning — advisory, does not block'
                              : 'Cannot evaluate yet — needs more input'
                        }
                        style={{ cursor: 'help' }}
                      >
                        {f.severity === 'error' ? '⛔' : f.severity === 'warning' ? '⚠️' : 'ℹ️'}
                      </span>{' '}
                      <span className="muted">[{f.rule}]</span> {f.message}
                    </div>
                  ))}
                </div>
              ),
            )}
          </>
        )}
        {/* Z4 — configurable anomaly-rule findings (block → red / error, warn → amber / warning). */}
        {validation && validation.anomalies.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <b>Anomaly rules</b>
            {validation.anomalies.map((a, i) => (
              <div
                key={i}
                style={{
                  marginTop: 4,
                  fontSize: 13,
                  color: a.severity === 'error' ? 'var(--danger, #dc2626)' : 'var(--warn, #d97706)',
                }}
              >
                <span
                  title={a.severity === 'error' ? 'Block — prevents finalisation' : 'Warning — advisory, does not block'}
                  style={{ cursor: 'help' }}
                >
                  {a.severity === 'error' ? '⛔' : '⚠️'}
                </span>{' '}
                <span className="muted">[{a.rule}]</span> {a.message}
              </div>
            ))}
          </div>
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
                    <td className="actions">
                      <button className="ghost" onClick={() => viewVersion(v.revisionNo)} disabled={versionViewBusy === v.revisionNo}>
                        {versionViewBusy === v.revisionNo ? 'Loading…' : 'View'}
                      </button>{' '}
                      <button className="ghost" onClick={() => rollback(v.revisionNo)}>Roll back</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {versionViewError && <div className="error" style={{ marginTop: 10 }}>{versionViewError}</div>}
      </div>
      {versionView && <VersionViewModal view={versionView} cur={cur} onClose={() => setVersionView(null)} />}

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
