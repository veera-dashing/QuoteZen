'use client';

/** Minimal typed API client. Token lives in localStorage; 401s bounce to /login. */
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const TOKEN_KEY = 'quotezen_token';
const USER_KEY = 'quotezen_user';

export type Role = 'admin' | 'sales' | 'viewer';
export interface SessionUser {
  id: string;
  email: string;
  role: Role;
}

export const getToken = (): string | null =>
  typeof window === 'undefined' ? null : window.localStorage.getItem(TOKEN_KEY);

export const setToken = (token: string): void => window.localStorage.setItem(TOKEN_KEY, token);
export const clearToken = (): void => {
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(USER_KEY);
};

export const getUser = (): SessionUser | null => {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(USER_KEY);
  if (raw) {
    try {
      return JSON.parse(raw) as SessionUser;
    } catch {
      /* fall through to token decode */
    }
  }
  // Fall back to decoding the JWT payload (resilient across reloads / older sessions).
  const token = getToken();
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split('.')[1] ?? '')) as SessionUser;
    return payload.role ? payload : null;
  } catch {
    return null;
  }
};

export const getRole = (): Role | null => getUser()?.role ?? null;

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      // Only declare a JSON body when one is actually sent (avoids empty-body 400s on POSTs).
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });

  if (res.status === 401 && typeof window !== 'undefined') {
    clearToken();
    if (!window.location.pathname.startsWith('/login')) window.location.href = '/login';
    throw new ApiError(401, 'unauthorized', 'Session expired');
  }

  if (res.status === 204) return undefined as T;

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = body?.error ?? {};
    throw new ApiError(res.status, err.code ?? 'error', err.message ?? 'Request failed', err.details);
  }
  return body as T;
}

/**
 * Upload a single file via multipart/form-data to an authenticated endpoint (P1-19e).
 * The browser sets the multipart Content-Type (with boundary) automatically — do NOT set it here.
 */
export async function uploadFile<T = unknown>(path: string, file: File): Promise<T> {
  const token = getToken();
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  if (res.status === 401 && typeof window !== 'undefined') {
    clearToken();
    if (!window.location.pathname.startsWith('/login')) window.location.href = '/login';
    throw new ApiError(401, 'unauthorized', 'Session expired');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = body?.error ?? {};
    throw new ApiError(res.status, err.code ?? 'error', err.message ?? 'Upload failed', err.details);
  }
  return body as T;
}

/** Fetch an authenticated binary endpoint and trigger a browser download. */
export const downloadFile = async (path: string, filename: string): Promise<void> => {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new ApiError(res.status, 'error', 'Download failed');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

export const login = async (email: string, password: string): Promise<void> => {
  const res = await api<{ token: string; user: SessionUser }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  setToken(res.token);
  if (res.user) window.localStorage.setItem(USER_KEY, JSON.stringify(res.user));
};
