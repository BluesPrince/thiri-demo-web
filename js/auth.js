/**
 * auth.js — Supabase Auth client for THIRI
 *
 * Lightweight auth wrapper using Supabase REST API directly (no SDK import).
 * Stores session in localStorage. Emits state changes via callbacks.
 */

// ─── Config ─────────────────────────────────────────────────────────────────
// BluesPrinceAPI Supabase instance
const SUPABASE_URL = 'https://idisyegwaghwtvdzqdmu.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlkaXN5ZWd3YWdod3R2ZHpxZG11Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ2MzU4NTUsImV4cCI6MjA5MDIxMTg1NX0.WhEKxEUga_Pt9R0m8T0JHfvbtUqhA0qaMCiNfBlHAO8'; // Get from: Supabase Dashboard → BluesPrinceAPI → Settings → API → anon public

const STORAGE_KEY = 'thiri_session';

// ─── State ──────────────────────────────────────────────────────────────────

let _session = null;  // { access_token, refresh_token, user }
let _listeners = [];

// ─── Helpers ────────────────────────────────────────────────────────────────

async function supabaseAuth(endpoint, body) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error_description || data.msg || data.error || 'Auth request failed');
  }
  return data;
}

function persistSession(session) {
  _session = session;
  if (session) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      user: session.user,
      expires_at: session.expires_at,
    }));
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
  _listeners.forEach(fn => fn(_session));
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** Sign up with email + password */
export async function signUp(email, password) {
  const data = await supabaseAuth('signup', { email, password });
  // Supabase may return a session immediately or require email confirmation
  if (data.access_token) {
    persistSession(data);
  }
  return data;
}

/** Sign in with email + password */
export async function signIn(email, password) {
  const data = await supabaseAuth('token?grant_type=password', { email, password });
  persistSession(data);
  return data;
}

/** Sign out — clears local session */
export async function signOut() {
  if (_session?.access_token) {
    try {
      await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${_session.access_token}`,
          'apikey': SUPABASE_ANON_KEY,
        },
      });
    } catch { /* ignore — we clear locally anyway */ }
  }
  persistSession(null);
}

/** Get current session (or null) */
export function getSession() {
  return _session;
}

/** Get current access token (for API calls) */
export function getAccessToken() {
  return _session?.access_token || null;
}

/** Get current user (or null) */
export function getUser() {
  return _session?.user || null;
}

/** Is user logged in? */
export function isAuthenticated() {
  return !!_session?.access_token;
}

/** Register a listener for auth state changes. Returns unsubscribe fn. */
export function onAuthStateChange(callback) {
  _listeners.push(callback);
  // Fire immediately with current state
  callback(_session);
  return () => {
    _listeners = _listeners.filter(fn => fn !== callback);
  };
}

/** Refresh the access token using the refresh token */
export async function refreshSession() {
  if (!_session?.refresh_token) return null;

  try {
    const data = await supabaseAuth('token?grant_type=refresh_token', {
      refresh_token: _session.refresh_token,
    });
    persistSession(data);
    return data;
  } catch {
    // Refresh failed — session expired
    persistSession(null);
    return null;
  }
}

// ─── Init: restore session from localStorage ────────────────────────────────

function restoreSession() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return;

    const session = JSON.parse(stored);
    if (!session.access_token) return;

    // Check if token is expired (with 60s buffer)
    if (session.expires_at) {
      const expiresAt = session.expires_at * 1000; // to ms
      if (Date.now() > expiresAt - 60000) {
        // Token expired or about to expire — try refresh
        _session = session; // set temporarily for refreshSession()
        refreshSession();
        return;
      }
    }

    _session = session;
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
}

restoreSession();
