'use client';

import { useState } from 'react';
import type { FieldDef, Row, TableDef } from '@/lib/types';
import SearchSelect from '@/components/SearchSelect';

interface Props {
  table: TableDef;
  initial: Row | null; // null = create
  onClose: () => void;
  onSave: (payload: Row) => Promise<void>;
}

const toInput = (field: FieldDef, value: unknown): string => {
  if (value === null || value === undefined) return '';
  return String(value);
};

export default function RecordForm({ table, initial, onClose, onSave }: Props) {
  const [values, setValues] = useState<Record<string, string | boolean>>(() => {
    const v: Record<string, string | boolean> = {};
    for (const f of table.fields) {
      const raw = initial?.[f.name];
      v[f.name] = f.type === 'boolean' ? Boolean(raw) : toInput(f, raw);
    }
    return v;
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (name: string, value: string | boolean) =>
    setValues((prev) => ({ ...prev, [name]: value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload: Row = {};
      for (const f of table.fields) {
        const v = values[f.name];
        if (f.type === 'boolean') {
          payload[f.name] = Boolean(v);
        } else if (v === '' || v === undefined) {
          if (!f.required) payload[f.name] = null;
        } else if (f.type === 'int' || f.type === 'decimal') {
          payload[f.name] = Number(v);
        } else {
          payload[f.name] = v;
        }
      }
      await onSave(payload);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="scrim" onClick={onClose}>
      <form className="drawer" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>
          {initial ? 'Edit' : 'New'} {table.label.replace(/s$/, '')}
        </h2>
        {table.fields.map((f) => (
          <div className="field" key={f.name}>
            <label>
              {f.label}
              {f.required ? ' *' : ''}
            </label>
            {f.type === 'boolean' ? (
              <input
                type="checkbox"
                checked={Boolean(values[f.name])}
                onChange={(e) => set(f.name, e.target.checked)}
                style={{ width: 'auto' }}
              />
            ) : f.type === 'enum' ? (
              <SearchSelect
                value={String(values[f.name] ?? '')}
                onChange={(v) => set(f.name, v)}
                allowEmpty={!f.required}
                options={(f.options ?? []).map((o) => ({ value: o, label: o }))}
              />
            ) : f.type === 'text' ? (
              <textarea
                rows={3}
                value={String(values[f.name] ?? '')}
                onChange={(e) => set(f.name, e.target.value)}
              />
            ) : (
              <input
                type={f.type === 'int' || f.type === 'decimal' ? 'number' : f.type === 'date' ? 'date' : 'text'}
                step={f.type === 'decimal' ? 'any' : undefined}
                value={String(values[f.name] ?? '')}
                onChange={(e) => set(f.name, e.target.value)}
              />
            )}
          </div>
        ))}
        {error && <div className="error">{error}</div>}
        <div className="form-actions">
          <button className="primary" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
