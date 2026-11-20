'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import SearchSelect from '@/components/SearchSelect';

interface Role {
  id: string;
  name: string;
}
interface UserRow {
  id: string;
  email: string;
  name: string;
  isActive: boolean;
  role: { id: string; name: string };
}

/** Must match the API's MIN_PASSWORD_LENGTH (apps/api/src/modules/admin/users.ts). */
const MIN_PASSWORD_LENGTH = 8;

export default function UsersPage() {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // `null` = closed; `{ user: null }` = add; `{ user }` = edit.
  const [editing, setEditing] = useState<{ user: UserRow | null } | null>(null);

  const load = () => {
    Promise.all([api<UserRow[]>('/admin/users'), api<Role[]>('/admin/roles')])
      .then(([u, r]) => {
        setUsers(u);
        setRoles(r);
      })
      .catch((e) => setError(e.message));
  };

  useEffect(load, []);

  const update = async (id: string, body: Record<string, unknown>) => {
    setNotice(null);
    try {
      await api(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Update failed');
    }
    load();
  };

  if (error) return <div className="error">{error}</div>;
  if (!users) return <div className="muted">Loading…</div>;

  return (
    <div>
      <div className="topbar">
        <h1>Users &amp; roles</h1>
        <button className="primary" onClick={() => setEditing({ user: null })}>
          + Add user
        </button>
      </div>
      <p className="muted">Admin-only. Roles enforce access server-side on every endpoint (default-deny).</p>
      {notice && <div className="error">{notice}</div>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Active</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td className="muted">{u.email}</td>
                <td style={{ minWidth: 160 }}>
                  <SearchSelect
                    value={u.role.id}
                    onChange={(v) => update(u.id, { roleId: Number(v) })}
                    options={roles.map((r) => ({ value: r.id, label: r.name }))}
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={u.isActive}
                    onChange={(e) => update(u.id, { isActive: e.target.checked })}
                    style={{ width: 'auto' }}
                  />
                </td>
                <td className="actions">
                  <button className="ghost" onClick={() => setEditing({ user: u })}>
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <UserForm
          user={editing.user}
          roles={roles}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setNotice(null);
            load();
          }}
        />
      )}
    </div>
  );
}

/** Add / edit drawer. On edit the password is optional — fill it only to reset it. */
function UserForm({
  user,
  roles,
  onClose,
  onSaved,
}: {
  user: UserRow | null;
  roles: Role[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = user !== null;
  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [roleId, setRoleId] = useState(user?.role.id ?? roles.find((r) => r.name === 'sales')?.id ?? '');
  const [isActive, setIsActive] = useState(user?.isActive ?? true);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim() || !email.trim() || !roleId) return setError('Name, email and role are required');
    if (!isEdit || password) {
      if (password.length < MIN_PASSWORD_LENGTH)
        return setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      if (password !== confirm) return setError('Passwords do not match');
    }

    const body: Record<string, unknown> = { name: name.trim(), email: email.trim(), roleId: Number(roleId), isActive };
    if (password) body.password = password;

    setBusy(true);
    try {
      await api(isEdit ? `/admin/users/${user.id}` : '/admin/users', {
        method: isEdit ? 'PATCH' : 'POST',
        body: JSON.stringify(body),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="scrim" onClick={onClose}>
      <form className="drawer" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>{isEdit ? 'Edit user' : 'Add user'}</h2>
        <div className="field">
          <label>Name *</label>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
        <div className="field">
          <label>Email *</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
        </div>
        <div className="field">
          <label>Role *</label>
          <SearchSelect
            value={roleId}
            onChange={setRoleId}
            options={roles.map((r) => ({ value: r.id, label: r.name }))}
          />
        </div>
        <div className="field">
          <label>
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              style={{ width: 'auto', marginRight: 6 }}
            />
            Active (can sign in)
          </label>
        </div>
        <div className="field">
          <label>{isEdit ? 'New password (leave blank to keep the current one)' : 'Password *'}</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
          />
        </div>
        {(!isEdit || password) && (
          <div className="field">
            <label>Confirm password *</label>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </div>
        )}
        {error && <div className="error">{error}</div>}
        <div className="form-actions">
          <button className="primary" type="submit" disabled={busy}>
            {busy ? 'Saving…' : isEdit ? 'Save' : 'Add user'}
          </button>
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
