'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import SearchSelect from '@/components/SearchSelect';

interface ClientOpt { id: string; name?: string }

interface Field<T> {
  value: T;
  source: 'client' | 'global';
  overridesGlobal: boolean;
}

interface EffectiveRules {
  clientId: string;
  client: string;
  margin: Field<number> & { floor: number; belowFloor: boolean; effective: number };
  preferredProductFamily: Field<string | null>;
  preferredPitchMm: Field<number | null>;
  excludedComponents: string[];
}

function SourceBadge({ field }: { field: Field<unknown> }) {
  return field.overridesGlobal ? (
    <span className="pill" style={{ background: 'var(--accent, #6d5dfc)', color: '#fff' }}>
      client override
    </span>
  ) : (
    <span className="pill muted">global default</span>
  );
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export default function RulesPage() {
  const [clients, setClients] = useState<ClientOpt[]>([]);
  const [clientId, setClientId] = useState('');
  const [rules, setRules] = useState<EffectiveRules | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ rows: ClientOpt[] }>('/admin/clients?take=300')
      .then((r) => setClients(r.rows))
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!clientId) {
      setRules(null);
      return;
    }
    setBusy(true);
    setError(null);
    api<EffectiveRules>(`/rules/client/${clientId}/effective`)
      .then(setRules)
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }, [clientId]);

  return (
    <div>
      <div className="topbar">
        <h1>Effective rules</h1>
      </div>
      <p className="muted">
        How global defaults merge with a client&apos;s overrides. The margin floor is a guardrail — a
        below-floor client margin is clamped up to the floor, never below it.
      </p>

      <div className="card" style={{ maxWidth: 420 }}>
        <label>Client</label>
        <SearchSelect
          value={clientId}
          onChange={setClientId}
          allowEmpty
          placeholder="Select a client…"
          options={clients.map((c) => ({ value: c.id, label: c.name ?? '' }))}
        />
      </div>

      {error && <div className="error">{error}</div>}
      {busy && <div className="muted">Resolving…</div>}

      {rules && !busy && (
        <>
          <div className="card">
            <h3 style={{ marginTop: 0 }}>{rules.client} — resolved values</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Rule</th>
                    <th>Effective value</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Margin</td>
                    <td>
                      {pct(rules.margin.effective)}
                      {rules.margin.belowFloor && (
                        <span className="muted" style={{ marginLeft: 8 }}>
                          (client {pct(rules.margin.value)} clamped to floor {pct(rules.margin.floor)})
                        </span>
                      )}
                    </td>
                    <td><SourceBadge field={rules.margin} /></td>
                  </tr>
                  <tr>
                    <td>Margin floor (guardrail)</td>
                    <td>{pct(rules.margin.floor)}</td>
                    <td><span className="pill muted">global default</span></td>
                  </tr>
                  <tr>
                    <td>Preferred product family</td>
                    <td>{rules.preferredProductFamily.value ?? <span className="muted">— none —</span>}</td>
                    <td><SourceBadge field={rules.preferredProductFamily} /></td>
                  </tr>
                  <tr>
                    <td>Preferred pitch (mm)</td>
                    <td>{rules.preferredPitchMm.value ?? <span className="muted">— none —</span>}</td>
                    <td><SourceBadge field={rules.preferredPitchMm} /></td>
                  </tr>
                  <tr>
                    <td>Excluded components</td>
                    <td>
                      {rules.excludedComponents.length > 0
                        ? rules.excludedComponents.map((c) => (
                            <span key={c} className="pill" style={{ marginRight: 6 }}>{c}</span>
                          ))
                        : <span className="muted">— none —</span>}
                    </td>
                    <td>
                      {rules.excludedComponents.length > 0
                        ? <span className="pill" style={{ background: 'var(--accent, #6d5dfc)', color: '#fff' }}>client override</span>
                        : <span className="pill muted">global default</span>}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
