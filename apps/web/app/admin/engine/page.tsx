'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, getRole } from '@/lib/api';

// ── Types (match the generic admin CRUD payloads) ──
interface SettingRow {
  id: string;
  key: string;
  label: string;
  value: string | null; // Decimal serialises as string
  valueText: string | null;
  unit: string | null;
}
interface AnomalyRow {
  id: string;
  key: string;
  label: string;
  description: string | null;
  enabled: boolean;
  severity: 'block' | 'warn';
  paramNum: string | null; // Decimal serialises as string
  paramText: string | null;
}
interface ListResp<T> {
  rows: T[];
  total: number;
}

// ── Financial bumpers: the SIX curated settings, in mockup order + copy ──
type BumperFmt = 'pct' | 'days' | 'rate' | 'toggle';
const BUMPERS: Array<{ key: string; title: string; sub: string; fmt: BumperFmt; note?: string }> = [
  { key: 'min_gross_margin', title: 'Minimum gross margin', sub: 'System blocks send below this threshold.', fmt: 'pct' },
  { key: 'walk_away_margin', title: 'Walk-away margin', sub: 'Hard floor — requires Director approval.', fmt: 'pct' },
  { key: 'discount_cap_pct', title: 'Max client-level discount', sub: 'Per line item, A & A+ tiers only.', fmt: 'pct' },
  { key: 'lead_time_buffer_days', title: 'Lead-time buffer', sub: 'Added to vendor lead-time on every quote.', fmt: 'days' },
  {
    key: 'aud_usd_rate',
    title: 'AUD:USD assumption',
    sub: 'Auto-fed from RBA daily.',
    fmt: 'rate',
    note: 'Live USD→AUD conversion uses the Currencies exchange rate; this is the assumption of record.',
  },
  { key: 'human_in_the_loop', title: 'Human-in-the-loop', sub: 'AI never emails client directly.', fmt: 'toggle' },
];

/** Render a setting's stored numeric value in the mockup's display form. */
function displayValue(fmt: BumperFmt, raw: string | null): string {
  const n = Number(raw ?? 0);
  switch (fmt) {
    case 'pct':
      return `${Math.round(n * 100 * 100) / 100}%`;
    case 'days':
      return `${n} day${n === 1 ? '' : 's'}`;
    case 'rate':
      return `1:${n}`;
    case 'toggle':
      return n > 0 ? 'On' : 'Off';
  }
}

export default function EnginePage() {
  const router = useRouter();
  const [settings, setSettings] = useState<SettingRow[] | null>(null);
  const [rules, setRules] = useState<AnomalyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // which bumper key / rule id is being edited inline
  const [editBumper, setEditBumper] = useState<string | null>(null);
  const [editRule, setEditRule] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = () => {
    setError(null);
    Promise.all([
      api<ListResp<SettingRow>>('/admin/settings?take=200'),
      api<ListResp<AnomalyRow>>('/admin/anomaly-rules?take=50'),
    ])
      .then(([s, r]) => {
        setSettings(s.rows);
        setRules(r.rows);
      })
      .catch((e) => setError((e as Error).message));
  };

  useEffect(() => {
    if (getRole() !== 'admin') {
      router.replace('/quotes');
      return;
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  if (getRole() !== 'admin') return null;
  if (error && !settings) return <div className="error">{error}</div>;
  if (!settings || !rules) return <div className="muted">Loading…</div>;

  const byKey = new Map(settings.map((s) => [s.key, s]));

  // ── Save a bumper: convert display → stored numeric, PATCH /admin/settings/:id ──
  const saveBumper = async (row: SettingRow, fmt: BumperFmt, input: string, toggleTo?: boolean) => {
    setSaving(true);
    setError(null);
    try {
      let value: number;
      if (fmt === 'toggle') value = toggleTo ? 1 : 0;
      else if (fmt === 'pct') value = Number(input) / 100;
      else if (fmt === 'days') value = Math.round(Number(input));
      else value = Number(input); // rate: stored as decimal
      await api(`/admin/settings/${row.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ value }),
      });
      setEditBumper(null);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // ── Save an anomaly rule: PATCH /admin/anomaly-rules/:id ──
  const saveRule = async (
    row: AnomalyRow,
    patch: { enabled: boolean; severity: 'block' | 'warn'; paramNum: number | null },
  ) => {
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        enabled: patch.enabled,
        severity: patch.severity,
      };
      if (row.paramNum !== null) body.paramNum = patch.paramNum;
      await api(`/admin/anomaly-rules/${row.id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      setEditRule(null);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="topbar">
        <h1>Engine constraints &amp; systemic rules</h1>
      </div>
      <p className="muted" style={{ maxWidth: 720 }}>
        These rules are enforced on every quote. The engine flags or blocks any draft that violates
        them — the Director must approve any exception.
      </p>
      {error && <div className="error">{error}</div>}

      {/* ── Section 1: Financial bumpers ── */}
      <div className="nav-group" style={{ margin: '22px 0 8px' }}>
        Financial bumpers
      </div>
      <div className="card" style={{ padding: 0 }}>
        {BUMPERS.map((b, i) => {
          const row = byKey.get(b.key);
          const editing = editBumper === b.key;
          return (
            <div
              key={b.key}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 16,
                padding: '14px 16px',
                borderTop: i === 0 ? 'none' : '1px solid var(--border)',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{b.title}</div>
                <div className="muted" style={{ fontSize: 13 }}>
                  {b.sub}
                </div>
                {b.note && (
                  <div className="muted" style={{ fontSize: 12, marginTop: 4, fontStyle: 'italic' }}>
                    {b.note}
                  </div>
                )}
              </div>

              {!row ? (
                <span className="muted" style={{ fontSize: 13 }}>
                  not seeded
                </span>
              ) : editing ? (
                <BumperEditor
                  row={row}
                  fmt={b.fmt}
                  saving={saving}
                  onCancel={() => setEditBumper(null)}
                  onSave={(input, toggleTo) => saveBumper(row, b.fmt, input, toggleTo)}
                />
              ) : (
                <>
                  <div style={{ fontWeight: 600, minWidth: 90, textAlign: 'right' }}>
                    {displayValue(b.fmt, row.value)}
                  </div>
                  <span
                    className="pill"
                    style={{
                      background: 'rgba(48,164,108,0.15)',
                      borderColor: 'var(--ok)',
                      color: 'var(--ok)',
                      fontWeight: 600,
                    }}
                  >
                    ● ACTIVE
                  </span>
                  <button onClick={() => setEditBumper(b.key)}>Edit</button>
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Section 2: Anomaly rules ── */}
      <div className="nav-group" style={{ margin: '22px 0 8px' }}>
        Anomaly rules
      </div>
      <div className="card" style={{ padding: 0 }}>
        {rules.map((r, i) => {
          const editing = editRule === r.id;
          const off = !r.enabled;
          return (
            <div
              key={r.id}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 16,
                padding: '14px 16px',
                borderTop: i === 0 ? 'none' : '1px solid var(--border)',
                opacity: off && !editing ? 0.5 : 1,
              }}
            >
              <div style={{ minWidth: 70, paddingTop: 2 }}>
                <SeverityBadge severity={r.severity} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>
                  {r.label}
                  {off && (
                    <span className="pill" style={{ marginLeft: 8, fontSize: 11 }}>
                      OFF
                    </span>
                  )}
                </div>
                <div className="muted" style={{ fontSize: 13 }}>
                  {r.description}
                </div>
                {editing && (
                  <RuleEditor
                    row={r}
                    saving={saving}
                    onCancel={() => setEditRule(null)}
                    onSave={(patch) => saveRule(r, patch)}
                  />
                )}
              </div>
              {!editing && (
                <button onClick={() => setEditRule(r.id)}>Configure</button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Severity badge: BLOCK (dark/red) vs WARN (amber) ──
function SeverityBadge({ severity }: { severity: 'block' | 'warn' }) {
  if (severity === 'block') {
    return (
      <span
        className="pill"
        style={{
          background: 'rgba(229,72,77,0.18)',
          borderColor: 'var(--danger)',
          color: 'var(--danger)',
          fontWeight: 700,
          letterSpacing: '0.04em',
        }}
      >
        BLOCK
      </span>
    );
  }
  return (
    <span
      className="pill"
      style={{
        background: 'rgba(240,180,41,0.18)',
        borderColor: '#f0b429',
        color: '#f0b429',
        fontWeight: 700,
        letterSpacing: '0.04em',
      }}
    >
      WARN
    </span>
  );
}

// ── Inline editor for a financial bumper ──
function BumperEditor({
  row,
  fmt,
  saving,
  onCancel,
  onSave,
}: {
  row: SettingRow;
  fmt: BumperFmt;
  saving: boolean;
  onCancel: () => void;
  onSave: (input: string, toggleTo?: boolean) => void;
}) {
  const initial =
    fmt === 'pct'
      ? String(Math.round(Number(row.value ?? 0) * 100 * 100) / 100)
      : String(Number(row.value ?? 0));
  const [input, setInput] = useState(initial);
  const [on, setOn] = useState(Number(row.value ?? 0) > 0);

  if (fmt === 'toggle') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0 }}>
          <input
            type="checkbox"
            checked={on}
            style={{ width: 'auto' }}
            onChange={(e) => setOn(e.target.checked)}
          />
          <span style={{ color: 'var(--text)' }}>{on ? 'On' : 'Off'}</span>
        </label>
        <button className="primary" disabled={saving} onClick={() => onSave('', on)}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button className="ghost" disabled={saving} onClick={onCancel}>
          Cancel
        </button>
      </div>
    );
  }

  const suffix = fmt === 'pct' ? '%' : fmt === 'days' ? 'days' : '';
  const prefix = fmt === 'rate' ? '1:' : '';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {prefix && <span className="muted">{prefix}</span>}
      <input
        type="number"
        step={fmt === 'days' ? '1' : 'any'}
        value={input}
        style={{ width: 100 }}
        onChange={(e) => setInput(e.target.value)}
      />
      {suffix && <span className="muted">{suffix}</span>}
      <button className="primary" disabled={saving} onClick={() => onSave(input)}>
        {saving ? 'Saving…' : 'Save'}
      </button>
      <button className="ghost" disabled={saving} onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

// ── Inline editor for an anomaly rule ──
const UNIT_HINT: Record<string, string> = {
  discount_over_cap_aplus: '%',
  outdoor_low_nit: 'nit',
  air_freight_short_lead: 'weeks',
  custom_engineering: '$',
};

function RuleEditor({
  row,
  saving,
  onCancel,
  onSave,
}: {
  row: AnomalyRow;
  saving: boolean;
  onCancel: () => void;
  onSave: (patch: { enabled: boolean; severity: 'block' | 'warn'; paramNum: number | null }) => void;
}) {
  const [enabled, setEnabled] = useState(row.enabled);
  const [severity, setSeverity] = useState<'block' | 'warn'>(row.severity);
  const [param, setParam] = useState(row.paramNum ?? '');
  const hint = UNIT_HINT[row.key];
  const hasParam = row.paramNum !== null;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        flexWrap: 'wrap',
        gap: 14,
        marginTop: 12,
        padding: 12,
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        background: 'var(--surface-2)',
      }}
    >
      <div>
        <label>Enabled</label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0 }}>
          <input
            type="checkbox"
            checked={enabled}
            style={{ width: 'auto' }}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span style={{ color: 'var(--text)' }}>{enabled ? 'On' : 'Off'}</span>
        </label>
      </div>
      <div>
        <label>Severity</label>
        <select
          value={severity}
          style={{ width: 120 }}
          onChange={(e) => setSeverity(e.target.value as 'block' | 'warn')}
        >
          <option value="block">block</option>
          <option value="warn">warn</option>
        </select>
      </div>
      {hasParam && (
        <div>
          <label>Threshold{hint ? ` (${hint})` : ''}</label>
          <input
            type="number"
            step="any"
            value={param}
            style={{ width: 120 }}
            onChange={(e) => setParam(e.target.value)}
          />
        </div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          className="primary"
          disabled={saving}
          onClick={() =>
            onSave({
              enabled,
              severity,
              paramNum: hasParam ? Number(param) : null,
            })
          }
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button className="ghost" disabled={saving} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
