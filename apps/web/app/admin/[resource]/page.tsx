'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, ApiError, downloadFile, getRole, uploadFile } from '@/lib/api';
import type { ListResponse, Row, TableDef } from '@/lib/types';
import RecordForm from '@/components/RecordForm';

const PAGE = 50;

interface RowError {
  row: number;
  messages: string[];
}
interface ImportReport {
  total: number;
  valid: number;
  invalid: number;
  willCreate: number;
  willUpdate: number;
  errors: RowError[];
}

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

  // Bulk import/export (admin only).
  const isAdmin = getRole() === 'admin';
  const fileRef = useRef<HTMLInputElement>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);

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

  // Reset the import panel whenever the table changes.
  useEffect(() => {
    setImportFile(null);
    setReport(null);
    setImportMsg(null);
    if (fileRef.current) fileRef.current.value = '';
  }, [resource]);

  const exportCsv = async () => {
    setImportMsg(null);
    try {
      await downloadFile(`/admin/${resource}/export`, `${resource}.csv`);
    } catch (e) {
      setImportMsg(e instanceof Error ? e.message : 'Export failed');
    }
  };

  const runPreview = async (file: File) => {
    setImportBusy(true);
    setImportMsg(null);
    setReport(null);
    try {
      setReport(await uploadFile<ImportReport>(`/admin/${resource}/import/preview`, file));
    } catch (e) {
      setImportMsg(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      setImportBusy(false);
    }
  };

  const onPickFile = (file: File | null) => {
    setImportFile(file);
    setImportMsg(null);
    setReport(null);
    if (file) void runPreview(file);
  };

  const confirmImport = async () => {
    if (!importFile) return;
    setImportBusy(true);
    setImportMsg(null);
    try {
      const res = await uploadFile<{ created: number; updated: number }>(`/admin/${resource}/import`, importFile);
      setImportMsg(`Imported: ${res.created} created, ${res.updated} updated.`);
      setImportFile(null);
      setReport(null);
      if (fileRef.current) fileRef.current.value = '';
      await load();
    } catch (e) {
      // A 422 carries the full validation report in `details`; a 409 is a duplicate-key rollback.
      if (e instanceof ApiError && e.details && typeof e.details === 'object') {
        setReport(e.details as ImportReport);
      }
      setImportMsg(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setImportBusy(false);
    }
  };

  if (!table) return <div className="center">{error ?? 'Loading…'}</div>;

  const cols = table.listFields;
  const total = data?.total ?? 0;

  return (
    <div>
      <div className="topbar">
        <h1>{table.label}</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {isAdmin && (
            <button className="ghost" onClick={exportCsv}>
              Export CSV
            </button>
          )}
          {isAdmin && !table.readonly && (
            <button className="ghost" onClick={() => fileRef.current?.click()} disabled={importBusy}>
              Import CSV
            </button>
          )}
          <button className="primary" onClick={() => setEditing({ row: null })} disabled={table.readonly}>
            + New
          </button>
        </div>
      </div>

      {isAdmin && !table.readonly && (
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          style={{ display: 'none' }}
          onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
        />
      )}

      {isAdmin && (importMsg || report) && (
        <div className="import-panel" style={{ border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: 12, margin: '12px 0' }}>
          {importFile && (
            <div className="muted" style={{ marginBottom: 6 }}>
              File: {importFile.name}
            </div>
          )}
          {report && (
            <>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 8 }}>
                <span>Total: <b>{report.total}</b></span>
                <span>Valid: <b>{report.valid}</b></span>
                <span style={{ color: report.invalid ? 'crimson' : undefined }}>Invalid: <b>{report.invalid}</b></span>
                <span>Will create: <b>{report.willCreate}</b></span>
                <span>Will update: <b>{report.willUpdate}</b></span>
              </div>
              {report.errors.length > 0 && (
                <div className="table-wrap" style={{ maxHeight: 220, overflow: 'auto', marginBottom: 8 }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Row</th>
                        <th>Errors</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.errors.map((er) => (
                        <tr key={er.row}>
                          <td className="cell-num">{er.row}</td>
                          <td>{er.messages.join('; ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  className="primary"
                  disabled={importBusy || report.invalid > 0 || !importFile || report.total === 0}
                  onClick={confirmImport}
                >
                  {importBusy ? 'Importing…' : 'Confirm import'}
                </button>
                <button
                  className="ghost"
                  disabled={importBusy}
                  onClick={() => {
                    setImportFile(null);
                    setReport(null);
                    setImportMsg(null);
                    if (fileRef.current) fileRef.current.value = '';
                  }}
                >
                  Cancel
                </button>
                {report.invalid > 0 && <span className="muted">Fix the errors and re-select the file.</span>}
              </div>
            </>
          )}
          {importMsg && (
            <div className={importMsg.startsWith('Imported') ? 'muted' : 'error'} style={{ marginTop: 8 }}>
              {importMsg}
            </div>
          )}
        </div>
      )}

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
