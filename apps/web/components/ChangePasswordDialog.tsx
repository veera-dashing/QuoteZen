'use client';

import { useState } from 'react';
import { api, getUser } from '@/lib/api';

/** Must match the API's MIN_PASSWORD_LENGTH (apps/api/src/modules/admin/users.ts). */
const MIN_PASSWORD_LENGTH = 8;

/**
 * "Change password" button + side drawer for the signed-in user. Available to every role from the
 * header (quotes) and sidebar (admin). The user re-enters their current password to set a new one.
 */
export default function ChangePasswordButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="ghost" type="button" onClick={() => setOpen(true)}>
        Change password
      </button>
      {open && <ChangePasswordDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!current) return setError('Enter your current password');
    if (next.length < MIN_PASSWORD_LENGTH)
      return setError(`New password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    if (next !== confirm) return setError('New passwords do not match');
    if (next === current) return setError('New password must be different from the current one');

    setBusy(true);
    try {
      await api('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change password');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="scrim" onClick={onClose}>
      <form className="drawer" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Change password</h2>
        <p className="muted">{getUser()?.email}</p>
        {done ? (
          <>
            <p>Your password has been changed. Use the new password next time you sign in.</p>
            <div className="form-actions">
              <button className="primary" type="button" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <label>Current password</label>
              <input
                type="password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                autoComplete="current-password"
                autoFocus
              />
            </div>
            <div className="field">
              <label>New password</label>
              <input
                type="password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                autoComplete="new-password"
                placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
              />
            </div>
            <div className="field">
              <label>Confirm new password</label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            {error && <div className="error">{error}</div>}
            <div className="form-actions">
              <button className="primary" type="submit" disabled={busy}>
                {busy ? 'Saving…' : 'Change password'}
              </button>
              <button type="button" className="ghost" onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
