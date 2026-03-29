/**
 * api.js — THIRI API client
 *
 * Talks to the WoodShed Express server for patch CRUD, sessions, and harmony events.
 * All requests include the Supabase JWT for auth.
 */

import { getAccessToken, refreshSession, isAuthenticated } from './auth.js';

// ─── Config ─────────────────────────────────────────────────────────────────

// Local dev → woodshedai server; production → Railway URL
const API_BASE = window.location.hostname === 'localhost'
  ? 'http://localhost:3001'
  : 'https://woodshedai-production.up.railway.app';

// ─── Fetch wrapper ──────────────────────────────────────────────────────────

async function apiFetch(path, options = {}) {
  if (!isAuthenticated()) {
    throw new Error('Not authenticated');
  }

  let token = getAccessToken();

  const doFetch = async (accessToken) => {
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        ...options.headers,
      },
    });

    if (res.status === 401) {
      // Token might be expired — try refresh once
      const refreshed = await refreshSession();
      if (refreshed) {
        return fetch(`${API_BASE}${path}`, {
          ...options,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${refreshed.access_token}`,
            ...options.headers,
          },
        });
      }
      throw new Error('Session expired — please sign in again');
    }

    return res;
  };

  const res = await doFetch(token);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || `API error ${res.status}`);
  }

  return data;
}

// ─── Patches ────────────────────────────────────────────────────────────────

/** List all patches (own + public) */
export async function listPatches() {
  return apiFetch('/api/thiri/patches');
}

/** Get a single patch by ID (includes patch_json) */
export async function getPatch(id) {
  return apiFetch(`/api/thiri/patches/${id}`);
}

/** Create a new patch */
export async function createPatch({ name, description, patch_json, is_public }) {
  return apiFetch('/api/thiri/patches', {
    method: 'POST',
    body: JSON.stringify({ name, description, patch_json, is_public }),
  });
}

/** Update an existing patch */
export async function updatePatch(id, updates) {
  return apiFetch(`/api/thiri/patches/${id}`, {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
}

/** Delete a patch */
export async function deletePatch(id) {
  return apiFetch(`/api/thiri/patches/${id}`, {
    method: 'DELETE',
  });
}

// ─── Sessions ───────────────────────────────────────────────────────────────

/** Start a new session — returns { id, ... } */
export async function startSession({ patch_id, key, mode, num_voices, voicing }) {
  return apiFetch('/api/thiri/sessions', {
    method: 'POST',
    body: JSON.stringify({ patch_id, key, mode, num_voices, voicing }),
  });
}

/** End a session */
export async function endSession(id, duration_s) {
  return apiFetch(`/api/thiri/sessions/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ duration_s }),
  });
}

/** List recent sessions */
export async function listSessions(limit = 20) {
  return apiFetch(`/api/thiri/sessions?limit=${limit}`);
}

// ─── Harmony Events ─────────────────────────────────────────────────────────

/** Flush a batch of harmony events */
export async function flushEvents(session_id, events) {
  if (!events.length) return;
  return apiFetch('/api/thiri/events', {
    method: 'POST',
    body: JSON.stringify({ session_id, events }),
  });
}

// ─── Event Buffer ───────────────────────────────────────────────────────────
// Collects harmony events and flushes every N seconds

const EVENT_BUFFER = [];
const FLUSH_INTERVAL_MS = 5000; // flush every 5s
const MAX_BUFFER_SIZE = 200;

let _sessionId = null;
let _flushTimer = null;

/** Start buffering events for a session */
export function startEventBuffer(sessionId) {
  _sessionId = sessionId;
  EVENT_BUFFER.length = 0;
  _flushTimer = setInterval(flushBuffer, FLUSH_INTERVAL_MS);
}

/** Stop buffering and flush remaining events */
export async function stopEventBuffer() {
  if (_flushTimer) {
    clearInterval(_flushTimer);
    _flushTimer = null;
  }
  await flushBuffer();
  _sessionId = null;
}

/** Push a harmony event into the buffer */
export function pushEvent(lead_midi, suggested_midi, played_midi) {
  if (!_sessionId) return;

  EVENT_BUFFER.push({
    lead_midi,
    suggested_midi,
    played_midi: played_midi || suggested_midi,
    ts: new Date().toISOString(),
  });

  // Auto-flush if buffer is full
  if (EVENT_BUFFER.length >= MAX_BUFFER_SIZE) {
    flushBuffer();
  }
}

async function flushBuffer() {
  if (!_sessionId || !EVENT_BUFFER.length) return;
  if (!isAuthenticated()) return;

  const batch = EVENT_BUFFER.splice(0);
  try {
    await flushEvents(_sessionId, batch);
  } catch (err) {
    // Put events back on failure — they'll try again next flush
    EVENT_BUFFER.unshift(...batch);
    console.warn('[THIRI] Event flush failed:', err.message);
  }
}
