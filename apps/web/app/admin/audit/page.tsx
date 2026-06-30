'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface AuditRow {
  id: string;
  action: string;
  fieldName: string | null;
  oldValue: string | null;
  newValue: string | null;
  changedAt: string;
  user?: { name: string };
  quote?: { id: string; jobReference: string };
}

const ACTIONS = ['', 'create', 'update', 'delete', 'status_change'];
const ADMIN_ACTIONS = ['', 'create', 'update', 'delete', 'export'];

interface AdminAuditRow {
  id: string;
  tableName: string;
  recordId: string | null;
  action: string;
  changes: Record<string, unknown> | null;
  changedAt: string;
  user?: { name: string; email: string };
}

const describeChanges = (action: string, changes: Record<string, unknown> | null): string => {
  if (!changes) return '—';
  if (action === 'update') {
    return Object.entries(changes)
      .map(([f, c]) => {
        const v = c as { old?: unknown; new?: unknown };
        return `${f}: ${v.old ?? '∅'} → ${v.new ?? '∅'}`;
      })
      .join('; ');
  }
  if (action === 'export') return `${(changes as { rows?: number }).rows ?? '?'} rows`;
  return Object.keys(changes).length + ' field(s)';
};

export default function AuditPage() {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [action, setAction] = useState('');
  const [error, setError] = useState<string | null>(null);

  const [adminRows, setAdminRows] = useState<AdminAuditRow[] | null>(null);
  const [adminAction, setAdminAction] = useState('');

  const load = useCallback(() => {
    const q = action ? `?action=${action}` : '';
    api<AuditRow[]>(`/admin/audit${q}`)
      .then(setRows)
      .catch((e) => setError(e.message));
  }, [action]);

  const loadAdmin = useCallback(() => {
    const q = adminAction ? `?action=${adminAction}` : '';
    api<AdminAuditRow[]>(`/admin/admin-audit${q}`)
      .then(setAdminRows)
      .catch((e) => setError(e.message));
  }, [adminAction]);

  useEffect(load, [load]);
  useEffect(loadAdmin, [loadAdmin]);

  if (error) return <div className="error">{error}</div>;

  return (
    <div>
      <div className="topbar">
        <h1>Audit log</h1>
      </div>
      <p className="muted">Cross-quote activity (admin-only). Append-only; every quote mutation is recorded.</p>
      <div className="toolbar">
        <select value={action} onChange={(e) => setAction(e.target.value)} style={{ width: 200 }}>
          {ACTIONS.map((a) => (
            <option key={a} value={a}>
              {a || 'All actions'}
            </option>
          ))}
        </select>
        <div className="spacer" />
        <span className="muted">{rows?.length ?? 0} events</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Quote</th>
              <th>Action</th>
              <th>Field</th>
              <th>Change</th>
              <th>User</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((r) => (
              <tr key={r.id}>
                <td>{r.quote?.jobReference ?? '—'}</td>
                <td>
                  <span className="pill">{r.action}</span>
                </td>
                <td className="muted">{r.fieldName ?? '—'}</td>
                <td>
                  {r.fieldName ? (
                    <span>
                      <span className="muted">{r.oldValue ?? '∅'}</span> → <b>{r.newValue ?? '∅'}</b>
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="muted">{r.user?.name ?? 'system'}</td>
                <td className="muted">{new Date(r.changedAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="topbar" style={{ marginTop: 32 }}>
        <h1>Reference-data &amp; export audit</h1>
      </div>
      <p className="muted">
        Append-only record of catalog/settings changes and CSV exports (high-sensitivity admin
        surface). Includes the margins editor.
      </p>
      <div className="toolbar">
        <select value={adminAction} onChange={(e) => setAdminAction(e.target.value)} style={{ width: 200 }}>
          {ADMIN_ACTIONS.map((a) => (
            <option key={a} value={a}>
              {a || 'All actions'}
            </option>
          ))}
        </select>
        <div className="spacer" />
        <span className="muted">{adminRows?.length ?? 0} events</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Table</th>
              <th>Record</th>
              <th>Action</th>
              <th>Change</th>
              <th>User</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {adminRows?.map((r) => (
              <tr key={r.id}>
                <td>{r.tableName}</td>
                <td className="muted">{r.recordId ?? '—'}</td>
                <td>
                  <span className="pill">{r.action}</span>
                </td>
                <td className="muted">{describeChanges(r.action, r.changes)}</td>
                <td className="muted">{r.user?.name ?? 'system'}</td>
                <td className="muted">{new Date(r.changedAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
