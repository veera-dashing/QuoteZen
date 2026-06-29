'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, downloadFile } from '@/lib/api';

interface Opt { id: string; name?: string; model?: string; sell?: string | null; category?: string }
interface LedScreen { id: string; screenName: string | null; resolutionWpx: number | null; resolutionHpx: number | null; priceTotal: string | null }
interface LcdScreen { id: string; screenName: string | null; priceTotal: string | null }
interface Licence { id: string; screenType: string; tier: string; qty: number; isInteractive: boolean }
interface Quote {
  id: string; jobReference: string; status: string;
  totalEquipment: string; totalServices: string; totalRecurring: string; grandTotal: string;
  currency?: { code: string } | null;
  ledScreens: LedScreen[]; lcdScreens: LcdScreen[]; licences: Licence[];
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

      {step === 0 && <DetailsStep quote={quote} />}
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

function DetailsStep({ quote }: { quote: Quote }) {
  return (
    <div className="card">
      <p className="muted">Quote header. Currency: {quote.currency?.code}. Edit client/location in the reference admin.</p>
      <div className="grid3">
        <div><label>Job reference</label><input value={quote.jobReference} readOnly /></div>
        <div><label>Status</label><input value={quote.status} readOnly /></div>
        <div><label>Currency</label><input value={quote.currency?.code ?? ''} readOnly /></div>
      </div>
    </div>
  );
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

  useEffect(() => {
    api<{ rows: Opt[] }>('/admin/led-products?take=300').then((r) => setProducts(r.rows));
  }, []);

  const add = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/quotes/${quote.id}/led-screens`, {
        method: 'POST',
        body: JSON.stringify({
          screenName: name || undefined,
          ledProductId: productId ? Number(productId) : undefined,
          desiredWidthMm: Number(w),
          desiredHeightMm: Number(h),
          rotateCabinets: rotate,
        }),
      });
      setName('');
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
        <h3 style={{ marginTop: 0 }}>Add LED screen</h3>
        <div className="grid3">
          <div>
            <label>Product</label>
            <select value={productId} onChange={(e) => setProductId(e.target.value)}>
              <option value="">— select —</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.model}
                </option>
              ))}
            </select>
          </div>
          <div><label>Screen name</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div>
            <label>Rotate cabinets</label>
            <input type="checkbox" checked={rotate} onChange={(e) => setRotate(e.target.checked)} style={{ width: 'auto' }} />
          </div>
          <div><label>Width (mm)</label><input type="number" value={w} onChange={(e) => setW(e.target.value)} /></div>
          <div><label>Height (mm)</label><input type="number" value={h} onChange={(e) => setH(e.target.value)} /></div>
        </div>
        {err && <div className="error">{err}</div>}
        <div className="step-actions">
          <button className="primary" onClick={add} disabled={busy || !productId}>
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
            <select value={displayId} onChange={(e) => setDisplayId(e.target.value)}>
              <option value="">— select —</option>
              {displays.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.model} {d.sell ? `($${d.sell})` : ''}
                </option>
              ))}
            </select>
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
            <select value={screenType} onChange={(e) => setScreenType(e.target.value)}>
              <option>LED</option>
              <option>LCD</option>
            </select>
          </div>
          <div>
            <label>Volume tier</label>
            <select value={tier} onChange={(e) => setTier(e.target.value)}>
              <option value="low">Low</option>
              <option value="high">High</option>
            </select>
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

function ReviewStep({ quote, onChange }: { quote: Quote; onChange: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [audit, setAudit] = useState<Audit[]>([]);

  const loadAudit = useCallback(() => {
    api<Audit[]>(`/quotes/${quote.id}/audit`).then(setAudit);
  }, [quote.id]);

  useEffect(() => {
    loadAudit();
  }, [loadAudit]);

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
    await api(`/quotes/${quote.id}/status`, { method: 'POST', body: JSON.stringify({ status }) });
    await onChange();
    loadAudit();
  };

  const cur = quote.currency?.code ?? '';
  return (
    <div>
      <div className="card">
        <div className="topbar">
          <h3 style={{ margin: 0 }}>Totals</h3>
          <div className="row-actions">
            <button
              onClick={() =>
                downloadFile(`/quotes/${quote.id}/export.pdf`, `quote-${quote.jobReference}.pdf`)
              }
            >
              ⬇ Export PDF
            </button>
            <button className="primary" onClick={recompute} disabled={busy}>
              {busy ? 'Recomputing…' : '↻ Recompute'}
            </button>
          </div>
        </div>
        <div className="totals">
          <div className="stat"><div className="label">Equipment</div><div className="value">{cur} {Number(quote.totalEquipment).toLocaleString()}</div></div>
          <div className="stat"><div className="label">Services</div><div className="value">{cur} {Number(quote.totalServices).toLocaleString()}</div></div>
          <div className="stat"><div className="label">Recurring / yr</div><div className="value">{cur} {Number(quote.totalRecurring).toLocaleString()}</div></div>
          <div className="stat"><div className="label">Grand total</div><div className="value">{cur} {Number(quote.grandTotal).toLocaleString()}</div></div>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Workflow</h3>
        <div className="row-actions">
          <button onClick={() => setStatus('in_review')}>Send to review</button>
          <button onClick={() => setStatus('approved')}>Approve</button>
          <button onClick={() => setStatus('issued')}>Issue</button>
        </div>
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
