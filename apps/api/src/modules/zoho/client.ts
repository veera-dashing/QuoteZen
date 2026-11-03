import type { AppConfig } from '../../config.js';
import { AppError } from '../../errors.js';

/**
 * Minimal Zoho CRM API client (Phase 2, P1-19a). Self-client OAuth: a long-lived refresh token from
 * env is exchanged for 1-hour access tokens, cached in memory and refreshed a minute before expiry.
 * A 401 from the API forces one refresh + retry (token revoked or clock skew). Secrets are never
 * logged or echoed in errors.
 */
export interface ZohoSettings {
  accountsUrl: string;
  apiUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export const zohoSettings = (config: AppConfig): ZohoSettings => {
  const { ZOHO_ACCOUNTS_URL, ZOHO_API_URL, ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN } = config;
  if (!ZOHO_ACCOUNTS_URL || !ZOHO_API_URL || !ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET || !ZOHO_REFRESH_TOKEN) {
    throw new AppError('not_configured', 'Zoho is not configured (set the ZOHO_* variables in .env)');
  }
  return {
    accountsUrl: ZOHO_ACCOUNTS_URL.replace(/\/$/, ''),
    apiUrl: ZOHO_API_URL.replace(/\/$/, ''),
    clientId: ZOHO_CLIENT_ID,
    clientSecret: ZOHO_CLIENT_SECRET,
    refreshToken: ZOHO_REFRESH_TOKEN,
  };
};

const REFRESH_MARGIN_MS = 60_000;
let cached: { token: string; expiresAt: number } | null = null;

const refreshAccessToken = async (s: ZohoSettings): Promise<string> => {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: s.clientId,
    client_secret: s.clientSecret,
    refresh_token: s.refreshToken,
  });
  const res = await fetch(`${s.accountsUrl}/oauth/v2/token`, { method: 'POST', body });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !json.access_token) {
    // Zoho answers 200 with { error: 'invalid_code' } for a bad/revoked refresh token.
    throw new AppError('upstream_error', `Zoho token refresh failed: ${json.error ?? `HTTP ${res.status}`}`);
  }
  cached = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return json.access_token;
};

const accessToken = async (s: ZohoSettings, force = false): Promise<string> => {
  if (!force && cached && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) return cached.token;
  return refreshAccessToken(s);
};

/** Authenticated request against `${apiUrl}/crm/v8${path}`; retries once with a fresh token on 401. */
const zohoFetch = async (s: ZohoSettings, path: string): Promise<Response> => {
  const url = `${s.apiUrl}/crm/v8${path}`;
  const send = async (token: string) => fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
  let res = await send(await accessToken(s));
  if (res.status === 401) res = await send(await accessToken(s, true));
  return res;
};

const zohoJson = async <T>(s: ZohoSettings, path: string): Promise<T | null> => {
  const res = await zohoFetch(s, path);
  if (res.status === 204) return null; // Zoho's "no records"
  const json = (await res.json().catch(() => null)) as T | { code?: string; message?: string } | null;
  if (!res.ok) {
    const err = json as { code?: string; message?: string } | null;
    if (res.status === 404 || err?.code === 'INVALID_URL_PATTERN') throw new AppError('not_found', 'Zoho record not found');
    throw new AppError('upstream_error', `Zoho API error: ${err?.code ?? res.status} ${err?.message ?? ''}`.trim());
  }
  return json as T;
};

export interface ZohoDeal {
  id: string;
  Deal_Name: string;
  Stage: string | null;
  Account_Name: { id: string; name: string } | null;
  Contact_Name: { id: string; name: string } | null;
  Closing_Date: string | null;
  Description: string | null;
}

export interface ZohoAttachment {
  id: string;
  File_Name: string;
  Size: string;
}

const DEAL_FIELDS = 'Deal_Name,Stage,Account_Name,Contact_Name,Closing_Date,Description';

export const listDeals = async (s: ZohoSettings): Promise<ZohoDeal[]> =>
  (await zohoJson<{ data: ZohoDeal[] }>(s, `/Deals?fields=${DEAL_FIELDS}&per_page=50`))?.data ?? [];

/** Zoho search-criteria value escaping: `(`, `)` and `,` are syntax, so they are backslash-escaped. */
export const criteriaValue = (value: string): string => value.replace(/[(),\]/g, (c) => `\${c}`);

/** Deals currently in the given stage (first 200 — polling looks at a short, recent queue). */
export const listDealsInStage = async (
  s: ZohoSettings,
  stage: string,
): Promise<(ZohoDeal & { Modified_Time: string | null })[]> =>
  (
    await zohoJson<{ data: (ZohoDeal & { Modified_Time: string | null })[] }>(
      s,
      `/Deals/search?criteria=${encodeURIComponent(`(Stage:equals:${criteriaValue(stage)})`)}` +
        `&fields=${DEAL_FIELDS},Modified_Time&per_page=200`,
    )
  )?.data ?? [];

export const getDeal = async (s: ZohoSettings, dealId: string): Promise<ZohoDeal> => {
  const deal = (await zohoJson<{ data: ZohoDeal[] }>(s, `/Deals/${encodeURIComponent(dealId)}?fields=${DEAL_FIELDS}`))
    ?.data?.[0];
  if (!deal) throw new AppError('not_found', `Zoho deal ${dealId} not found`);
  return deal;
};

export const listDealAttachments = async (s: ZohoSettings, dealId: string): Promise<ZohoAttachment[]> =>
  (
    await zohoJson<{ data: ZohoAttachment[] }>(
      s,
      `/Deals/${encodeURIComponent(dealId)}/Attachments?fields=id,File_Name,Size`,
    )
  )?.data ?? [];

export const downloadDealAttachment = async (
  s: ZohoSettings,
  dealId: string,
  attachmentId: string,
): Promise<Buffer> => {
  const res = await zohoFetch(s, `/Deals/${encodeURIComponent(dealId)}/Attachments/${encodeURIComponent(attachmentId)}`);
  if (!res.ok) throw new AppError('upstream_error', `Zoho attachment download failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};
