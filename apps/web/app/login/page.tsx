'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, login } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('admin@quotezen.local');
  const [password, setPassword] = useState('demo');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const doLogin = async (em: string, pw: string) => {
    setBusy(true);
    setError(null);
    try {
      await login(em, pw);
      router.replace('/admin');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void doLogin(email, password);
  };

  // Demo accounts (seeded, password "demo") — one click to sign in during dev/testing.
  const QUICK = [
    { role: 'Admin', email: 'admin@quotezen.local' },
    { role: 'Sales', email: 'sales@quotezen.local' },
    { role: 'Viewer', email: 'viewer@quotezen.local' },
  ];

  return (
    <div className="login">
      <form className="login-card" onSubmit={onSubmit}>
        <h1>QuoteZen</h1>
        <p>Sign in</p>

        <label>Quick login (demo)</label>
        <div className="row-actions" style={{ marginBottom: 16 }}>
          {QUICK.map((q) => (
            <button
              key={q.email}
              type="button"
              onClick={() => {
                setEmail(q.email);
                setPassword('demo');
                void doLogin(q.email, 'demo');
              }}
              disabled={busy}
            >
              {q.role}
            </button>
          ))}
        </div>

        <div className="field">
          <label>Email</label>
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="username" />
        </div>
        <div className="field">
          <label>Password</label>
          <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="current-password" />
        </div>
        {error && <div className="error">{error}</div>}
        <div className="field">
          <button className="primary" type="submit" disabled={busy} style={{ width: '100%' }}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
        <div className="hint">Demo accounts — password “demo”. Admin = full, Sales = write (own quotes), Viewer = read-only.</div>
      </form>
    </div>
  );
}
