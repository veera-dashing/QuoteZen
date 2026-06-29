'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import type { ListResponse, Row, TableDef } from '@/lib/types';
import RecordForm from '@/components/RecordForm';

const PAGE = 50;

const formatCell = (value: unknown): { text: string; numeric: boolean } => {
  if (value === null || value === undefined) return { text: '—', numeric: false };
  if (typeof value === 'boolean') return { text: value ? '✓' : '✗', numeric: false };
  if (typeof value === 'number') return { text: String(value), numeric: true };
  const s = String(value);
  // Decimal/BigInt come back as numeric strings.
  if (/^-?\d+(\.\d+)?$/.test(s)) return { text: s, numeric: true };
  return { text: s.length > 80 ? `${s.slice(0, 80)}…` : s, numeric: false };
};

export default function ResourcePage() {
  const params = useParams<{ resource: string }>();
  const resource = params.resource;

  const [table, setTable] = useState<TableDef | null>(null);
  const [data, setData] = useState<ListResponse | null>(null);
  const [q, setQ] = useState('');
  const [skip, setSkip] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ row: Row | null } | null>(null);

  // Load table definition from the registry.
  useEffect(() => {
    api<{ tables: TableDef[] }>('/admin/_meta')
      .then((r) => setTable(r.tables.find((t) => t.resource === resource) ?? null))
      .catch((e) => setError(e.message));
    setQ('');
    setSkip(0);
  }, [resource]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ take: String(PAGE), skip: String(skip) });
      if (q) query.set('q', q);
      setData(await api<ListResponse>(`/admin/${resource}?${query.toString()}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Load failed');
    } finally {
      setLoading(false);
    }
  }, [resource, q, skip]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (payload: Row) => {
    if (editing?.row) {
      await api(`/admin/${resource}/${editing.row.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
    } else {
      await api(`/admin/${resource}`, { method: 'POST', body: JSON.stringify(payload) });
    }
    await load();
  };

  const remove = async (row: Row) => {
    if (!window.confirm('Delete this record?')) return;
    await api(`/admin/${resource}/${row.id}`, { method: 'DELETE' });
    await load();
  };

  if (!table) return <div className="center">{error ?? 'Loading…'}</div>;

  const cols = table.listFields;
  const total = data?.total ?? 0;

  return (
    <div>
      <div className="topbar">
        <h1>{table.label}</h1>
        <button className="primary" onClick={() => setEditing({ row: null })} disabled={table.readonly}>
          + New
        </button>
      </div>

      <div className="toolbar">
        <input
          placeholder={`Search ${table.label.toLowerCase()}…`}
          value={q}
          onChange={(e) => {
            setSkip(0);
            setQ(e.target.value);
          }}
        />
        <div className="spacer" />
        <span className="muted">{total} records</span>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c}>{table.fields.find((f) => f.name === c)?.label ?? c}</th>
              ))}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={cols.length + 1} className="muted">
                  Loading…
                </td>
              </tr>
            )}
            {!loading && data?.rows.length === 0 && (
              <tr>
                <td colSpan={cols.length + 1} className="muted">
                  No records.
                </td>
              </tr>
            )}
            {!loading &&
              data?.rows.map((row) => (
                <tr key={String(row.id)}>
                  {cols.map((c) => {
                    const cell = formatCell(row[c]);
                    return (
                      <td key={c} className={cell.numeric ? 'cell-num' : ''}>
                        {cell.text}
                      </td>
                    );
                  })}
                  <td className="actions">
                    <button className="ghost" onClick={() => setEditing({ row })}>
                      Edit
                    </button>
                    <button className="danger" onClick={() => remove(row)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <div className="pager">
        <button disabled={skip === 0} onClick={() => setSkip(Math.max(0, skip - PAGE))}>
          ← Prev
        </button>
        <span>
          {total === 0 ? 0 : skip + 1}–{Math.min(skip + PAGE, total)} of {total}
        </span>
        <button disabled={skip + PAGE >= total} onClick={() => setSkip(skip + PAGE)}>
          Next →
        </button>
      </div>

      {editing && (
        <RecordForm table={table} initial={editing.row} onClose={() => setEditing(null)} onSave={save} />
      )}
    </div>
  );
}
