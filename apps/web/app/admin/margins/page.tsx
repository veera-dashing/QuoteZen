'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, getRole } from '@/lib/api';

interface MarginRow {
  id: string;
  key: string;
  label: string;
  value: string; // Decimal serialises as string
  unit: string | null;
}

export default function MarginsPage() {
  const router = useRouter();
  const [rows, setRows] = useState<MarginRow[] | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // Margins editor is admin-only; bounce others to their quotes.
    if (getRole() !== 'admin') {
      router.replace('/quotes');
      return;
    }
    api<MarginRow[]>('/admin/margins')
      .then((data) => {
        setRows(data);
        setDraft(Object.fromEntries(data.map((r) => [r.key, r.value])));
      })
      .catch((e) => setError(e.message));
  }, [router]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const values: Record<string, number> = {};
      for (const [k, v] of Object.entries(draft)) values[k] = Number(v);
      const updated = await api<MarginRow[]>('/admin/margins', {
        method: 'PATCH',
        body: JSON.stringify({ values }),
      });
      setRows(updated);
      setDraft(Object.fromEntries(updated.map((r) => [r.key, r.value])));
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (error && !rows) return <div className="error">{error}</div>;
  if (!rows) return <div className="muted">Loading…</div>;

  const dirty = rows.some((r) => draft[r.key] !== r.value);

  return (
    <div>
      <div className="topbar">
        <h1>Margins &amp; markups</h1>
      </div>
      <p className="muted">
        Admin-only. These commercial multipliers drive every quote&apos;s pricing — each change is
        recorded in the admin audit log.
      </p>
      {error && <div className="error">{error}</div>}
      {saved && !dirty && <div className="muted" style={{ color: 'var(--ok, green)' }}>Saved.</div>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Setting</th>
              <th>Value</th>
              <th>Unit</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td>
                  {r.label}
                  <div className="muted" style={{ fontSize: 12 }}>{r.key}</div>
                </td>
                <td style={{ width: 160 }}>
                  <input
                    type="number"
                    step="any"
                    value={draft[r.key] ?? ''}
                    onChange={(e) => {
                      setSaved(false);
                      setDraft((d) => ({ ...d, [r.key]: e.target.value }));
                    }}
                  />
                </td>
                <td className="muted">{r.unit ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 16 }}>
        <button onClick={save} disabled={saving || !dirty}>
          {saving ? 'Saving…' : 'Save all'}
        </button>
      </div>
    </div>
  );
}
