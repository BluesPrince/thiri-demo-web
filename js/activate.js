/**
 * activate.js — License activation page logic
 * Imports auth and API modules for server communication.
 */

import {
  signIn, signUp, signOut, isAuthenticated, getUser,
  onAuthStateChange,
} from './auth.js';
import {
  listLicenses, activateLicense, downloadLicenseFile,
} from './api.js';

const $ = id => document.getElementById(id);

let authIsSignUp = false;

// ── Auth Form ────────────────────────────────────────────────

function wireAuthForm() {
  const form = $('authForm');
  const toggleBtn = $('authToggleBtn');

  toggleBtn.addEventListener('click', () => {
    authIsSignUp = !authIsSignUp;
    $('authSubmit').textContent = authIsSignUp ? 'SIGN UP' : 'SIGN IN';
    $('authToggleText').textContent = authIsSignUp ? 'Have an account?' : 'No account?';
    toggleBtn.textContent = authIsSignUp ? 'Sign in' : 'Sign up';
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('authEmail').value.trim();
    const password = $('authPassword').value;
    const errorEl = $('authError');

    errorEl.classList.add('hidden');
    $('authSubmit').textContent = authIsSignUp ? 'SIGNING UP...' : 'SIGNING IN...';

    try {
      if (authIsSignUp) {
        await signUp(email, password);
      } else {
        await signIn(email, password);
      }
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    } finally {
      $('authSubmit').textContent = authIsSignUp ? 'SIGN UP' : 'SIGN IN';
    }
  });

  $('signOutBtn').addEventListener('click', () => signOut());
}

// ── License List ─────────────────────────────────────────────

async function loadLicenses() {
  const container = $('licensesList');
  container.innerHTML = '<p class="text-dim" style="font-size: 12px;">Loading licenses...</p>';

  try {
    const licenses = await listLicenses();
    if (!licenses.length) {
      container.innerHTML = `
        <p class="text-dim" style="font-size: 12px;">No licenses found.</p>
        <p style="color: var(--gold); margin-top: 12px; font-size: 13px;">
          <a href="https://thiri.ai" style="color: var(--gold);">Purchase THIRI Suite</a>
          to unlock the full plugin experience.
        </p>`;
      return;
    }

    container.innerHTML = licenses.map(lic => {
      const productName = lic.product.replace('thiri_', '').toUpperCase();
      const isActivated = !!lic.activated_at;
      const dateStr = isActivated
        ? new Date(lic.activated_at).toLocaleDateString()
        : new Date(lic.created_at).toLocaleDateString();
      return `
        <div class="license-card">
          <div class="license-card-header">
            <div>
              <strong class="license-product">THIRI ${productName}</strong>
              <div class="text-dim" style="font-size: 11px; margin-top: 4px;">
                ${isActivated ? 'Activated ' + dateStr : 'Purchased ' + dateStr + ' \u2014 not yet activated'}
              </div>
            </div>
            <button class="btn-sm btn-gold activate-btn" data-license-id="${lic.id}">
              ${isActivated ? 'RE-DOWNLOAD' : 'ACTIVATE'}
            </button>
          </div>
        </div>`;
    }).join('');

    container.querySelectorAll('.activate-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const origText = btn.textContent;
        btn.textContent = 'ACTIVATING...';
        btn.disabled = true;
        try {
          const result = await activateLicense(btn.dataset.licenseId);
          downloadLicenseFile(result.content, result.filename);
          showSuccess();
          await loadLicenses();
        } catch (err) {
          alert('Activation failed: ' + err.message);
        } finally {
          btn.textContent = origText;
          btn.disabled = false;
        }
      });
    });
  } catch (err) {
    container.innerHTML = `<p style="color: #e44; padding: 8px; font-size: 12px;">${err.message}</p>`;
  }
}

function showSuccess() {
  const toast = $('activateSuccess');
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 4000);
}

// ── Auth State ───────────────────────────────────────────────

function updateUI(session) {
  const signedIn = !!session?.access_token;
  $('signInSection').classList.toggle('hidden', signedIn);
  $('licensesSection').classList.toggle('hidden', !signedIn);
  $('instructionsSection').classList.toggle('hidden', !signedIn);

  if (signedIn) {
    $('userEmail').textContent = session.user?.email || '';
    loadLicenses();
  }
}

// ── Init ─────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  wireAuthForm();
  onAuthStateChange(updateUI);
});
