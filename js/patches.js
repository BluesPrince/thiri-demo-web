/**
 * patches.js — Patch Editor UI logic
 *
 * Manages the patch editor modal: CRUD operations, form ↔ JSON binding,
 * and loading patches into the live synth.
 */

import { listPatches, getPatch, createPatch, updatePatch, deletePatch } from './api.js';
import { isAuthenticated } from './auth.js';

// ─── State ──────────────────────────────────────────────────────────────────

let patches = [];
let activePatchId = null;
let onPatchLoad = null; // callback when user loads a patch into live synth

// ─── Default Patch ──────────────────────────────────────────────────────────

const DEFAULT_PATCH = {
  oscillator: { waveform: 'sine', detune: 0, voices: 1 },
  envelope: { attack: 0.1, decay: 0.2, sustain: 0.8, release: 0.4 },
  filter: { type: 'lowpass', cutoff: 2000, resonance: 0.5, envAmount: 0.3 },
  lfo: { waveform: 'sine', rate: 0.5, depth: 0.1, target: 'pitch' },
  effects: [
    { type: 'reverb', mix: 0.3, size: 0.6 },
    { type: 'delay', mix: 0.2, time: 0.25, feedback: 0.4 },
  ],
};

// ─── DOM refs ───────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

// ─── Public API ─────────────────────────────────────────────────────────────

/** Initialize patch editor — call once on DOMContentLoaded */
export function initPatchEditor(loadCallback) {
  onPatchLoad = loadCallback;
  wireEditorControls();
}

/** Open the patch modal and refresh list */
export async function openPatchEditor() {
  $('patchModal').classList.remove('hidden');
  await refreshPatchList();
}

/** Close the patch modal */
export function closePatchEditor() {
  $('patchModal').classList.add('hidden');
}

// ─── List & Select ──────────────────────────────────────────────────────────

async function refreshPatchList() {
  if (!isAuthenticated()) return;

  try {
    patches = await listPatches();
  } catch (err) {
    console.warn('[THIRI] Failed to load patches:', err.message);
    patches = [];
  }

  renderPatchList();
}

function renderPatchList() {
  const list = $('patchList');
  list.innerHTML = '';

  if (patches.length === 0) {
    list.innerHTML = '<div class="text-dim" style="padding:8px;font-size:10px">No patches yet</div>';
    return;
  }

  patches.forEach(p => {
    const item = document.createElement('div');
    item.className = 'patch-list-item' + (p.id === activePatchId ? ' active' : '');
    item.textContent = p.name;
    item.dataset.id = p.id;
    item.addEventListener('click', () => selectPatch(p.id));
    list.appendChild(item);
  });
}

async function selectPatch(id) {
  activePatchId = id;

  // Highlight in list
  document.querySelectorAll('.patch-list-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === id);
  });

  try {
    const patch = await getPatch(id);
    populateForm(patch);
  } catch (err) {
    console.warn('[THIRI] Failed to load patch:', err.message);
  }
}

// ─── Form ↔ JSON ────────────────────────────────────────────────────────────

function populateForm(patch) {
  $('patchName').value = patch.name || '';
  $('patchDesc').value = patch.description || '';
  $('patchPublic').checked = patch.is_public || false;

  const pj = patch.patch_json || DEFAULT_PATCH;

  // Oscillator
  $('patchWaveform').value = pj.oscillator?.waveform || 'sine';
  $('patchDetune').value = pj.oscillator?.detune || 0;
  $('patchUnison').value = pj.oscillator?.voices || 1;

  // Envelope (convert seconds → milliseconds for sliders)
  $('patchAttack').value = (pj.envelope?.attack || 0.1) * 1000;
  $('patchDecay').value = (pj.envelope?.decay || 0.2) * 1000;
  $('patchSustain').value = (pj.envelope?.sustain || 0.8) * 100;
  $('patchRelease').value = (pj.envelope?.release || 0.4) * 1000;

  // Filter
  $('patchFilterType').value = pj.filter?.type || 'lowpass';
  $('patchCutoff').value = pj.filter?.cutoff || 2000;
  $('patchResonance').value = (pj.filter?.resonance || 0.5) * 100;
  $('patchFilterEnv').value = (pj.filter?.envAmount || 0.3) * 100;

  // LFO
  $('patchLfoWave').value = pj.lfo?.waveform || 'sine';
  $('patchLfoRate').value = (pj.lfo?.rate || 0.5) * 100;
  $('patchLfoDepth').value = (pj.lfo?.depth || 0.1) * 100;
  $('patchLfoTarget').value = pj.lfo?.target || 'pitch';

  // Effects
  const reverb = pj.effects?.find(e => e.type === 'reverb') || {};
  const delay = pj.effects?.find(e => e.type === 'delay') || {};
  $('patchReverbMix').value = (reverb.mix || 0.3) * 100;
  $('patchReverbSize').value = (reverb.size || 0.6) * 100;
  $('patchDelayMix').value = (delay.mix || 0.2) * 100;
  $('patchDelayTime').value = (delay.time || 0.25) * 1000;
  $('patchDelayFb').value = (delay.feedback || 0.4) * 100;
}

function readFormToJSON() {
  return {
    oscillator: {
      waveform: $('patchWaveform').value,
      detune: parseInt($('patchDetune').value),
      voices: parseInt($('patchUnison').value),
    },
    envelope: {
      attack: parseInt($('patchAttack').value) / 1000,
      decay: parseInt($('patchDecay').value) / 1000,
      sustain: parseInt($('patchSustain').value) / 100,
      release: parseInt($('patchRelease').value) / 1000,
    },
    filter: {
      type: $('patchFilterType').value,
      cutoff: parseInt($('patchCutoff').value),
      resonance: parseInt($('patchResonance').value) / 100,
      envAmount: parseInt($('patchFilterEnv').value) / 100,
    },
    lfo: {
      waveform: $('patchLfoWave').value,
      rate: parseInt($('patchLfoRate').value) / 100,
      depth: parseInt($('patchLfoDepth').value) / 100,
      target: $('patchLfoTarget').value,
    },
    effects: [
      {
        type: 'reverb',
        mix: parseInt($('patchReverbMix').value) / 100,
        size: parseInt($('patchReverbSize').value) / 100,
      },
      {
        type: 'delay',
        mix: parseInt($('patchDelayMix').value) / 100,
        time: parseInt($('patchDelayTime').value) / 1000,
        feedback: parseInt($('patchDelayFb').value) / 100,
      },
    ],
  };
}

function resetForm() {
  activePatchId = null;
  $('patchName').value = '';
  $('patchDesc').value = '';
  $('patchPublic').checked = false;
  populateForm({ patch_json: DEFAULT_PATCH });

  document.querySelectorAll('.patch-list-item').forEach(el => el.classList.remove('active'));
}

// ─── CRUD Handlers ──────────────────────────────────────────────────────────

async function handleSave() {
  const name = $('patchName').value.trim();
  if (!name) {
    $('patchName').focus();
    return;
  }

  const payload = {
    name,
    description: $('patchDesc').value.trim() || null,
    patch_json: readFormToJSON(),
    is_public: $('patchPublic').checked,
  };

  try {
    if (activePatchId) {
      await updatePatch(activePatchId, payload);
    } else {
      const created = await createPatch(payload);
      activePatchId = created.id;
    }
    await refreshPatchList();
  } catch (err) {
    console.error('[THIRI] Save failed:', err.message);
  }
}

async function handleDelete() {
  if (!activePatchId) return;
  if (!confirm('Delete this patch?')) return;

  try {
    await deletePatch(activePatchId);
    resetForm();
    await refreshPatchList();
  } catch (err) {
    console.error('[THIRI] Delete failed:', err.message);
  }
}

// ─── Wire Controls ──────────────────────────────────────────────────────────

function wireEditorControls() {
  $('patchModalClose').addEventListener('click', closePatchEditor);
  $('newPatchBtn').addEventListener('click', resetForm);
  $('patchSaveBtn').addEventListener('click', handleSave);
  $('patchDeleteBtn').addEventListener('click', handleDelete);

  // Close on overlay click
  $('patchModal').addEventListener('click', e => {
    if (e.target === $('patchModal')) closePatchEditor();
  });
}
