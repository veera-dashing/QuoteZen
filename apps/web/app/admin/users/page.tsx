'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

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

export default function UsersPage() {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [error, setError] = useState<string | null>(null);

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
    await api(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    load();
  };

  if (error) return <div className="error">{error}</div>;
  if (!users) return <div className="muted">Loading…</div>;

  return (
    <div>
      <div className="topbar">
        <h1>Users &amp; roles</h1>
      </div>
      <p className="muted">Admin-only. Roles enforce access server-side on every endpoint (default-deny).</p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Active</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td className="muted">{u.email}</td>
                <td>
                  <select
                    value={u.role.id}
                    onChange={(e) => update(u.id, { roleId: Number(e.target.value) })}
                    style={{ width: 160 }}
                  >
                    {roles.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={u.isActive}
                    onChange={(e) => update(u.id, { isActive: e.target.checked })}
                    style={{ width: 'auto' }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
