/**
 * main.js — App Initialization & UI Wiring
 * ==========================================
 * Connects all Evocal modules together:
 *   Mic → AudioContext → PitchDetector → HarmonyEngine → SynthEngine → Speakers
 *
 * Audio routing (feedback-free):
 *   micStream → micSource → [analyserNode for pitch] (no audio output from analyser)
 *                         → [dryGain in SynthEngine] → masterGain → speakers
 *
 * Copyright 2026 Blues Prince Media. PATENT PENDING.
 */

import { PitchDetector } from './pitch.js';
import { getHarmonyNotes, smoothVoiceTransition, getLeadContext, validateVoicing, checkParallelMotion } from './harmony.js';
import { initNotation, updateNotation, clearNotation } from './notation.js';
import { SynthEngine } from './synth.js';
// SynthEngine.registerWorklet() is called in start() before creating the engine
import {
  NOTE_NAMES,
  MODE_DISPLAY_NAMES,
} from './scales.js';
import {
  signIn, signUp, signOut, isAuthenticated, getUser,
  onAuthStateChange,
} from './auth.js';
import {
  startSession, endSession, pushEvent, startEventBuffer, stopEventBuffer,
  listLicenses, activateLicense, downloadLicenseFile,
} from './api.js';
import { initPatchEditor, openPatchEditor } from './patches.js';
import { initChartUI } from './chart-ui.js';
import { chordToScale } from './chord.js';
import { MIDIController } from './midi.js';
import { Arpeggiator } from './arp.js';
import { buildChordGrid, getRomanNumeral, getDominantLabel, getApproachLabel } from './chord-pads.js';

// ═══════════════════════════════════════════════════════════════════════════════
// APP STATE
// ═══════════════════════════════════════════════════════════════════════════════

const state = {
  running: false,
  audioCtx: null,
  synth: null,
  detector: null,
  currentPitch: null,
  prevHarmonyNotes: [],

  // User controls
  key: 'C',
  mode: 'major',
  numVoices: 2,
  voicingType: 'close',
  direction: 'above',
  mix: 0.6,
  masterVol: 0.8,
  fmMode: false,
  synthEnabled: true,

  humanize: 0.35,
  voiceType: 'formant',  // 'formant' | 'oscillator' | 'fm'
  vowel: 0.0,            // formant vowel position (0–1)
  breath: 0.15,          // formant breath amount (0–1)

  // Chord pads
  chordGrid: null,       // buildChordGrid() result
  ttActive: false,       // tritone sub toggle
  domActive: false,      // dominant toggle
  activePadId: null,     // 'row-col' string of active pad

  // MIDI
  midi: null,

  // Arpeggiator
  arp: null,
  arpMode: 'off',

  // Effects
  reverbSize: 0.6,
  reverbDamping: 0.5,
  reverbMix: 0.2,
  delaySyncType: '1/8',
  delayFeedback: 0.35,
  delayMix: 0.2,

  // ADSR
  adsrAttack: 0.01,
  adsrDecay: 0.1,
  adsrSustain: 0.8,
  adsrRelease: 0.15,

  // Pitch detection sensitivity
  gateThreshold: 0.01,
  minConfidence: 0.80,
  smoothingFactor: 0.70,

  // Jazz voicing options
  dropType: 'drop2',            // 'close' | 'drop2' | 'drop3' | 'drop24'
  fifthVoiceMode: 'double8vb',  // 'double8vb' | 'tension9' | 'tension11' | 'tension13'
  tritoneSub: false,            // tritone substitution toggle

  // Chart-driven harmony
  chartSections: null,
  chartQueue: null,
  chartActive: false,       // when true, chord chart overrides key/mode
  currentChord: null,       // current chord from chart (for display)

  // Session tracking
  sessionId: null,
  sessionStart: null,
};

// ═══════════════════════════════════════════════════════════════════════════════
// DOM ELEMENTS
// ═══════════════════════════════════════════════════════════════════════════════

const $ = id => document.getElementById(id);

const ui = {
  startBtn:       $('startBtn'),
  noteDisplay:    $('noteDisplay'),
  freqDisplay:    $('freqDisplay'),
  centsDisplay:   $('centsDisplay'),
  pitchMeter:     $('pitchMeter'),
  levelMeter:     $('levelMeter'),
  levelCanvas:    $('levelCanvas'),
  keySelect:      $('keySelect'),
  modeSelect:     $('modeSelect'),
  voicesGroup:    $('voicesGroup'),
  voicingGroup:   $('voicingGroup'),
  directionGroup: $('directionGroup'),
  mixSlider:      $('mixSlider'),
  masterSlider:   $('masterSlider'),
  voiceCards:     $('voiceCards'),
  fmToggle:       $('fmToggle'),
  statusBar:      $('statusBar'),
};

// ═══════════════════════════════════════════════════════════════════════════════
// POPULATE SELECTORS
// ═══════════════════════════════════════════════════════════════════════════════

function populateSelectors() {
  // Key selector
  NOTE_NAMES.forEach(note => {
    const opt = document.createElement('option');
    opt.value = note;
    opt.textContent = note;
    ui.keySelect.appendChild(opt);
  });

  // Mode selector — all WoodShed modes
  Object.entries(MODE_DISPLAY_NAMES).forEach(([key, label]) => {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = label;
    ui.modeSelect.appendChild(opt);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// START / STOP
// ═══════════════════════════════════════════════════════════════════════════════

async function start() {
  try {
    setStatus('Requesting mic permission…');

    // Create AudioContext
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: 'interactive',
      sampleRate: 44100,
    });

    // Get mic stream
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        latency: 0,
      },
    });

    // Build the analyser node for pitch detection (no audio output)
    const analyser = state.audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0;

    // Mic routing:
    //   micSource → analyser → [float data only, not connected to speakers]
    //   micSource → synth.dryGain → masterGain → speakers
    const micSource = state.audioCtx.createMediaStreamSource(stream);
    micSource.connect(analyser); // pitch detection only — NOT connected to output

    // Register pitch-shifter AudioWorklet for vocoder voices
    await SynthEngine.registerWorklet(state.audioCtx);

    // Init synth engine (formant/vocoder voice by default — THIRI.ai vocal sound)
    state.synth = new SynthEngine(state.audioCtx, 4);
    state.synth.connectMic(stream);
    state.synth.setMasterVolume(state.masterVol);
    state.synth.setMix(state.mix);
    state.synth.setHumanize(state.humanize);
    state.synth.setVoiceType(state.voiceType);
    state.synth.setVowel(state.vowel);
    state.synth.setBreath(state.breath);

    // Apply effects settings
    state.synth.setReverbSize(state.reverbSize);
    state.synth.setReverbDamping(state.reverbDamping);
    state.synth.setReverbMix(state.reverbMix);
    state.synth.setDelaySync(state.delaySyncType);
    state.synth.setDelayFeedback(state.delayFeedback);
    state.synth.setDelayMix(state.delayMix);
    state.synth.setDelayBPM(parseInt($('chartTempo')?.value) || 120);

    // Apply ADSR
    state.synth.setADSR(state.adsrAttack, state.adsrDecay, state.adsrSustain, state.adsrRelease);

    // Init arpeggiator
    state.arp = new Arpeggiator();
    state.arp.setBPM(parseInt($('chartTempo')?.value) || 120);
    state.arp.setMode(state.arpMode);
    state.arp.onNote((notes) => {
      if (state.synth && state.synthEnabled) {
        state.synth.update(notes, state.currentPitch?.midi ?? 60);
      }
    });

    // Init pitch detector (uses current sensitivity state)
    state.detector = new PitchDetector(analyser, state.audioCtx.sampleRate, {
      threshold: 0.15,
      minConfidence: state.minConfidence,
      rmsThreshold: state.gateThreshold,
      smoothingFactor: state.smoothingFactor,
    });

    state.detector.start(onPitchDetected);
    state.running = true;
    state.sessionStart = Date.now();

    // Start a server session if authenticated
    if (isAuthenticated()) {
      try {
        const session = await startSession({
          key: state.key,
          mode: state.mode,
          num_voices: state.numVoices,
          voicing: state.voicingType,
        });
        state.sessionId = session.id;
        startEventBuffer(session.id);
      } catch (err) {
        console.warn('[THIRI] Session logging unavailable:', err.message);
      }
    }

    ui.startBtn.textContent = 'STOP';
    ui.startBtn.classList.add('active');
    setStatus('Listening — sing into the mic');
    drawLevelLoop();

  } catch (err) {
    console.error('Start failed:', err);
    setStatus(`Error: ${err.message}`);
  }
}

async function stop() {
  // End server session if active
  if (state.sessionId && isAuthenticated()) {
    const durationS = Math.round((Date.now() - state.sessionStart) / 1000);
    try {
      await stopEventBuffer();
      await endSession(state.sessionId, durationS);
    } catch (err) {
      console.warn('[THIRI] Session end failed:', err.message);
    }
    state.sessionId = null;
    state.sessionStart = null;
  }

  if (state.arp) {
    state.arp.destroy();
    state.arp = null;
  }
  if (state.detector) {
    state.detector.stop();
    state.detector = null;
  }
  if (state.synth) {
    state.synth.muteAll();
    state.synth.destroy();
    state.synth = null;
  }
  if (state.audioCtx) {
    state.audioCtx.close();
    state.audioCtx = null;
  }

  state.running = false;
  state.currentPitch = null;
  state.prevHarmonyNotes = [];

  ui.startBtn.textContent = 'START';
  ui.startBtn.classList.remove('active');
  ui.noteDisplay.textContent = '–';
  ui.freqDisplay.textContent = '– Hz';
  ui.noteDisplay.classList.remove('detected');
  setStatus('Ready');
  resetVoiceCards();
}

// ═══════════════════════════════════════════════════════════════════════════════
// PITCH → HARMONY LOOP
// ═══════════════════════════════════════════════════════════════════════════════

function onPitchDetected(pitchInfo) {
  state.currentPitch = pitchInfo;

  if (!pitchInfo) {
    // Silence — close input gate, mute voices
    if (state.synth) {
      state.synth.setGateOpen(false);
      state.synth.muteAll();
    }
    ui.noteDisplay.textContent = '–';
    ui.noteDisplay.classList.remove('detected');
    ui.freqDisplay.textContent = '– Hz';
    ui.centsDisplay.textContent = '';
    resetVoiceCards();
    clearNotation();
    return;
  }

  // Valid pitch detected — open input gate
  if (state.synth) state.synth.setGateOpen(true);

  // Update pitch display
  ui.noteDisplay.textContent = pitchInfo.noteName + pitchInfo.octave;
  ui.noteDisplay.classList.add('detected');
  ui.freqDisplay.textContent = pitchInfo.frequency.toFixed(1) + ' Hz';
  const centsLabel = pitchInfo.centsOff > 0
    ? `+${pitchInfo.centsOff}¢`
    : `${pitchInfo.centsOff}¢`;
  ui.centsDisplay.textContent = centsLabel;

  // Pitch accuracy meter: cents deviation drives the fill bar left/width
  const cents = Math.max(-50, Math.min(50, pitchInfo.centsOff ?? 0));
  const absW = Math.abs(cents); // 0–50 → percentage of half-bar
  if (cents >= 0) {
    ui.pitchMeter.style.left = '50%';
    ui.pitchMeter.style.width = `${absW}%`;
  } else {
    ui.pitchMeter.style.left = `${50 - absW}%`;
    ui.pitchMeter.style.width = `${absW}%`;
  }

  // Determine key/mode — chart overrides manual selection when active
  let harmonyKey = state.key;
  let harmonyMode = state.mode;

  if (state.chartActive && state.currentChord) {
    const scale = chordToScale(state.currentChord);
    if (scale) {
      harmonyKey = scale.key;
      harmonyMode = scale.mode;
    }
  }

  // Update diagnostic display
  updateDiagnostics(pitchInfo, harmonyKey, harmonyMode);

  // Build options for jazz voicing modes
  const harmonyOptions = {
    parallelStep: 2,
    prevVoices: state.prevHarmonyNotes,
    prevTargets: state.prevHarmonyNotes,
    dropType: state.dropType || 'drop2',
    fifthVoiceMode: state.fifthVoiceMode || 'double8vb',
  };

  // Pass chord context when chart is driving harmony
  if (state.chartActive && state.currentChord) {
    harmonyOptions.chordRoot = state.currentChord.root;
    harmonyOptions.chordQuality = state.currentChord.quality || 'maj';
  }

  // Auto-select jazz voicing mode based on voice count when using jazz mode
  let voicingType = state.voicingType;
  if (voicingType === 'jazz') {
    // Auto-dispatch based on numVoices
    if (state.numVoices <= 1) voicingType = 'close'; // 1 voice = no jazz voicing needed
    else if (state.numVoices === 2) voicingType = 'jazz2';
    else if (state.numVoices === 3) voicingType = 'jazz3';
    else if (state.numVoices === 4) voicingType = 'jazz4';
    else voicingType = 'jazz5';
  }

  // Compute harmony notes
  const harmonyNotes = getHarmonyNotes(
    pitchInfo.midi,
    harmonyKey,
    harmonyMode,
    voicingType,
    state.numVoices,
    state.direction,
    harmonyOptions,
  );

  // Smooth voice leading across frames
  const smoothed = smoothVoiceTransition(harmonyNotes, state.prevHarmonyNotes);

  // Validate voicing — jazz rule enforcement (avoid notes, minor 9ths, spacing)
  let validated = smoothed;
  let violations = [];
  const chordRoot = state.currentChord?.root || harmonyKey;
  const chordQuality = state.currentChord?.quality || 'maj';
  const result = validateVoicing(smoothed, chordRoot, chordQuality, harmonyMode);
  validated = result.voices;
  violations = result.violations;

  // Check parallel motion between frames
  const parallelViolations = checkParallelMotion(state.prevHarmonyNotes, validated);
  violations = violations.concat(parallelViolations);

  state.prevHarmonyNotes = validated;

  // Send to synth (or arpeggiator if active)
  if (state.synth && state.synthEnabled) {
    if (state.arp && state.arpMode !== 'off') {
      state.arp.setNotes(validated);
    } else {
      state.synth.update(validated, pitchInfo.midi);
    }
  } else if (state.synth && !state.synthEnabled) {
    state.synth.muteAll();
  }

  // Log harmony event (buffered, not per-frame — pushEvent handles throttling)
  if (state.sessionId) {
    pushEvent(pitchInfo.midi, validated, validated);
  }

  // Update voice cards
  updateVoiceCards(validated);

  // Update notation display
  const chordLabel = state.currentChord?.symbol || `${harmonyKey} ${harmonyMode}`;
  updateNotation(pitchInfo.midi, validated, chordLabel, voicingType, violations);

  // Update notation header
  const notationChord = $('notationChord');
  if (notationChord) notationChord.textContent = chordLabel;
  const notationVoicing = $('notationVoicing');
  if (notationVoicing) notationVoicing.textContent = voicingType + (violations.length ? ` (${violations.length} fix)` : '');
}

// ═══════════════════════════════════════════════════════════════════════════════
// VOICE CARDS UI
// ═══════════════════════════════════════════════════════════════════════════════

function buildVoiceCards() {
  ui.voiceCards.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    const card = document.createElement('div');
    card.className = 'voice-card';
    card.id = `voiceCard${i}`;
    card.innerHTML = `
      <div class="voice-header">
        <div class="voice-indicator" id="voiceIndicator${i}"></div>
        <span class="voice-label">Voice ${i + 1}</span>
        <span class="voice-note" id="voiceNote${i}">–</span>
      </div>
      <div class="voice-controls">
        <div class="control-row">
          <label>Wave</label>
          <select class="voice-wave" data-voice="${i}" id="voiceWave${i}">
            <option value="sine">Sine</option>
            <option value="triangle">Triangle</option>
            <option value="sawtooth">Sawtooth</option>
            <option value="square">Square</option>
          </select>
        </div>
        <div class="control-row">
          <label>Detune</label>
          <input type="range" class="voice-detune" data-voice="${i}"
            min="-30" max="30" value="0" step="1" id="voiceDetune${i}">
          <span class="detune-val" id="voiceDetuneVal${i}">0¢</span>
        </div>
        <div class="control-row">
          <label>Vol</label>
          <input type="range" class="voice-vol" data-voice="${i}"
            min="0" max="100" value="70" step="1" id="voiceVol${i}">
        </div>
      </div>
    `;
    ui.voiceCards.appendChild(card);
  }

  // Wire voice card controls
  document.querySelectorAll('.voice-wave').forEach(sel => {
    sel.addEventListener('change', e => {
      const idx = parseInt(e.target.dataset.voice);
      if (state.synth) state.synth.setVoiceWaveform(idx, e.target.value);
    });
  });

  document.querySelectorAll('.voice-detune').forEach(input => {
    input.addEventListener('input', e => {
      const idx = parseInt(e.target.dataset.voice);
      const val = parseInt(e.target.value);
      $(`voiceDetuneVal${idx}`).textContent = (val >= 0 ? '+' : '') + val + '¢';
      if (state.synth) state.synth.setVoiceDetune(idx, val);
    });
  });

  document.querySelectorAll('.voice-vol').forEach(input => {
    input.addEventListener('input', e => {
      const idx = parseInt(e.target.dataset.voice);
      if (state.synth) state.synth.setVoiceVolume(idx, parseInt(e.target.value) / 100);
    });
  });
}

function updateVoiceCards(harmonyNotes) {
  for (let i = 0; i < 4; i++) {
    const noteEl = $(`voiceNote${i}`);
    const indicatorEl = $(`voiceIndicator${i}`);
    const card = $(`voiceCard${i}`);

    if (noteEl === null) continue;

    if (i < harmonyNotes.length && i < state.numVoices) {
      const midi = harmonyNotes[i];
      const noteIdx = ((midi % 12) + 12) % 12;
      const octave = Math.floor(midi / 12) - 1;
      noteEl.textContent = NOTE_NAMES[noteIdx] + octave;
      indicatorEl.classList.add('active');
      card.classList.add('active');
    } else {
      noteEl.textContent = '–';
      indicatorEl.classList.remove('active');
      card.classList.remove('active');
    }
  }
}

function resetVoiceCards() {
  for (let i = 0; i < 4; i++) {
    const noteEl = $(`voiceNote${i}`);
    if (noteEl) noteEl.textContent = '–';
    $(`voiceIndicator${i}`)?.classList.remove('active');
    $(`voiceCard${i}`)?.classList.remove('active');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LEVEL METER (Canvas)
// ═══════════════════════════════════════════════════════════════════════════════

function drawLevelLoop() {
  if (!state.running) return;

  const canvas = ui.levelCanvas;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;

  ctx.clearRect(0, 0, W, H);

  const pitch = state.currentPitch;
  const rms = pitch?.rms ?? 0;
  const level = Math.min(1, rms * 10); // scale up for display

  // Background track
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.fillRect(0, 0, W, H);

  // Level bar
  const barW = level * W;
  const gradient = ctx.createLinearGradient(0, 0, W, 0);
  gradient.addColorStop(0, '#d4a017');
  gradient.addColorStop(0.7, '#f5c542');
  gradient.addColorStop(1, '#ff6b35');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 2, barW, H - 4);

  requestAnimationFrame(drawLevelLoop);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONTROL WIRING
// ═══════════════════════════════════════════════════════════════════════════════

function wireControls() {
  // Start/Stop
  ui.startBtn.addEventListener('click', () => {
    if (state.running) stop(); else start();
  });

  // Key
  ui.keySelect.addEventListener('change', e => {
    state.key = e.target.value;
    state.prevHarmonyNotes = [];
    // Pads rebuild is handled by initChordPads listener
  });

  // Mode
  ui.modeSelect.addEventListener('change', e => {
    state.mode = e.target.value;
    state.prevHarmonyNotes = [];
    // Update pad key display
    const keyDisplay = $('padsKeyDisplay');
    if (keyDisplay) keyDisplay.textContent = `${state.key} ${state.mode}`;
  });

  // Voice count buttons
  ui.voicesGroup.querySelectorAll('[data-voices]').forEach(btn => {
    btn.addEventListener('click', e => {
      state.numVoices = parseInt(e.currentTarget.dataset.voices);
      ui.voicesGroup.querySelectorAll('[data-voices]').forEach(b => b.classList.remove('active'));
      e.currentTarget.classList.add('active');
      if (state.synth) state.synth.setVoiceCount(state.numVoices);
    });
  });

  // Voicing type buttons
  ui.voicingGroup.querySelectorAll('[data-voicing]').forEach(btn => {
    btn.addEventListener('click', e => {
      state.voicingType = e.currentTarget.dataset.voicing;
      ui.voicingGroup.querySelectorAll('[data-voicing]').forEach(b => b.classList.remove('active'));
      e.currentTarget.classList.add('active');
      state.prevHarmonyNotes = [];
    });
  });

  // Direction buttons
  ui.directionGroup.querySelectorAll('[data-direction]').forEach(btn => {
    btn.addEventListener('click', e => {
      state.direction = e.currentTarget.dataset.direction;
      ui.directionGroup.querySelectorAll('[data-direction]').forEach(b => b.classList.remove('active'));
      e.currentTarget.classList.add('active');
      state.prevHarmonyNotes = [];
    });
  });

  // Drop voicing type buttons
  const dropGroup = $('dropGroup');
  if (dropGroup) {
    dropGroup.querySelectorAll('[data-drop]').forEach(btn => {
      btn.addEventListener('click', e => {
        state.dropType = e.currentTarget.dataset.drop;
        dropGroup.querySelectorAll('[data-drop]').forEach(b => b.classList.remove('active'));
        e.currentTarget.classList.add('active');
        state.prevHarmonyNotes = [];
      });
    });
  }

  // 5th voice mode buttons
  const fifthGroup = $('fifthVoiceGroup');
  if (fifthGroup) {
    fifthGroup.querySelectorAll('[data-fifth]').forEach(btn => {
      btn.addEventListener('click', e => {
        state.fifthVoiceMode = e.currentTarget.dataset.fifth;
        fifthGroup.querySelectorAll('[data-fifth]').forEach(b => b.classList.remove('active'));
        e.currentTarget.classList.add('active');
      });
    });
  }

  // Tritone substitution toggle
  const tritoneToggle = $('tritoneToggle');
  if (tritoneToggle) {
    tritoneToggle.addEventListener('change', e => {
      state.tritoneSub = e.target.checked;
    });
  }

  // Mix slider
  ui.mixSlider.addEventListener('input', e => {
    state.mix = parseInt(e.target.value) / 100;
    if (state.synth) state.synth.setMix(state.mix);
    $('mixVal').textContent = `${e.target.value}%`;
  });

  // Master volume
  ui.masterSlider.addEventListener('input', e => {
    state.masterVol = parseInt(e.target.value) / 100;
    if (state.synth) state.synth.setMasterVolume(state.masterVol);
    $('masterVal').textContent = `${e.target.value}%`;
  });

  // FM Mode toggle
  if (ui.fmToggle) {
    ui.fmToggle.addEventListener('change', e => {
      state.fmMode = e.target.checked;
      if (state.synth) state.synth.setFMMode(state.fmMode);
    });
  }

  // Synth (harmony) enable toggle
  const synthToggle = $('synthToggle');
  if (synthToggle) {
    synthToggle.addEventListener('change', e => {
      state.synthEnabled = e.target.checked;
      if (!state.synthEnabled && state.synth) state.synth.muteAll();
    });
  }

  // Humanize slider
  const humanizeSlider = $('humanizeSlider');
  if (humanizeSlider) {
    humanizeSlider.addEventListener('input', e => {
      state.humanize = parseInt(e.target.value) / 100;
      $('humanizeVal').textContent = state.humanize.toFixed(2);
      if (state.synth) state.synth.setHumanize(state.humanize);
    });
  }

  // Chart-active toggle
  const chartActiveToggle = $('chartActiveToggle');
  if (chartActiveToggle) {
    chartActiveToggle.addEventListener('change', e => {
      state.chartActive = e.target.checked;
      if (!state.chartActive) {
        state.currentChord = null;
      }
    });
  }

  // HPF (high-pass filter for rumble)
  const hpfSlider = $('hpfSlider');
  if (hpfSlider) {
    hpfSlider.addEventListener('input', e => {
      const freq = parseInt(e.target.value);
      $('hpfVal').textContent = `${freq} Hz`;
      if (state.synth) state.synth.setHPF(freq);
    });
  }

  // Sensitivity: noise gate
  const gateSlider = $('gateSlider');
  if (gateSlider) {
    gateSlider.addEventListener('input', e => {
      state.gateThreshold = parseInt(e.target.value) / 1000;
      $('gateVal').textContent = state.gateThreshold.toFixed(3);
      if (state.detector) state.detector._rmsThreshold = state.gateThreshold;
    });
  }

  // Sensitivity: confidence
  const confidenceSlider = $('confidenceSlider');
  if (confidenceSlider) {
    confidenceSlider.addEventListener('input', e => {
      state.minConfidence = parseInt(e.target.value) / 100;
      $('confidenceVal').textContent = state.minConfidence.toFixed(2);
      if (state.detector) state.detector.minConfidence = state.minConfidence;
    });
  }

  // Sensitivity: smoothing
  const smoothingSlider = $('smoothingSlider');
  if (smoothingSlider) {
    smoothingSlider.addEventListener('input', e => {
      state.smoothingFactor = parseInt(e.target.value) / 100;
      $('smoothingVal').textContent = state.smoothingFactor.toFixed(2);
      if (state.detector) state.detector.smoothingFactor = state.smoothingFactor;
    });
  }

  // ── Voice Type switcher ──
  const voiceTypeGroup = $('voiceTypeGroup');
  if (voiceTypeGroup) {
    voiceTypeGroup.querySelectorAll('[data-voice-type]').forEach(btn => {
      btn.addEventListener('click', e => {
        state.voiceType = e.currentTarget.dataset.voiceType;
        voiceTypeGroup.querySelectorAll('[data-voice-type]').forEach(b => b.classList.remove('active'));
        e.currentTarget.classList.add('active');
        if (state.synth) state.synth.setVoiceType(state.voiceType);

        // Show/hide mode-specific controls
        const isVocal = state.voiceType === 'formant';
        // Vowel/formant slider: visible for Vocal mode (drives formant filters)
        if ($('vowelRow')) $('vowelRow').style.display = isVocal ? '' : 'none';
        // Breath slider: only for Vocal mode (no breath on Synth or FM)
        if ($('breathRow')) $('breathRow').style.display = isVocal ? '' : 'none';
        // ADSR controls: relevant for Synth/FM (Vocal mode uses mic as envelope)
        const adsrSection = document.querySelector('.effect-block:nth-child(3)');
        // In Vocal mode: dim Attack/Decay/Sustain (mic is the envelope),
        // but Release stays active (controls harmony tail length)
        if ($('adsrAttack')) $('adsrAttack').parentElement.style.opacity = isVocal ? '0.35' : '1.0';
        if ($('adsrDecay')) $('adsrDecay').parentElement.style.opacity = isVocal ? '0.35' : '1.0';
        if ($('adsrSustain')) $('adsrSustain').parentElement.style.opacity = isVocal ? '0.35' : '1.0';
        // Release always visible — controls vocal release tail OR synth release
        if ($('adsrRelease')) $('adsrRelease').parentElement.style.opacity = '1.0';
      });
    });
  }

  // ── Vowel slider (formant voices) ──
  const vowelSlider = $('vowelSlider');
  if (vowelSlider) {
    vowelSlider.addEventListener('input', e => {
      state.vowel = parseInt(e.target.value) / 100;
      const vowelNames = ['ah', 'eh', 'ee', 'oh', 'oo'];
      const idx = Math.min(4, Math.floor(state.vowel * 4.99));
      $('vowelVal').textContent = vowelNames[idx];
      if (state.synth) state.synth.setVowel(state.vowel);
    });
  }

  // ── Breath slider (formant voices) ──
  const breathSlider = $('breathSlider');
  if (breathSlider) {
    breathSlider.addEventListener('input', e => {
      state.breath = parseInt(e.target.value) / 100;
      $('breathVal').textContent = `${e.target.value}%`;
      if (state.synth) state.synth.setBreath(state.breath);
    });
  }

  // ── Hold Button (sustain pedal) ──
  const holdBtn = $('holdBtn');
  if (holdBtn) {
    // Toggle on click
    holdBtn.addEventListener('click', () => {
      const isActive = holdBtn.classList.toggle('active');
      if (state.synth) state.synth.setHold(isActive);
    });
    // Also support momentary press (mousedown/mouseup)
    holdBtn.addEventListener('mousedown', (e) => {
      if (e.shiftKey) {
        // Shift+click = momentary hold
        holdBtn.classList.add('active');
        if (state.synth) state.synth.setHold(true);
      }
    });
    holdBtn.addEventListener('mouseup', (e) => {
      if (e.shiftKey) {
        holdBtn.classList.remove('active');
        if (state.synth) state.synth.setHold(false);
      }
    });
  }

  // ── Effects: Reverb ──
  const reverbSize = $('reverbSize');
  if (reverbSize) {
    reverbSize.addEventListener('input', e => {
      state.reverbSize = parseInt(e.target.value) / 100;
      $('reverbSizeVal').textContent = state.reverbSize.toFixed(2);
      if (state.synth) state.synth.setReverbSize(state.reverbSize);
    });
  }
  const reverbDamping = $('reverbDamping');
  if (reverbDamping) {
    reverbDamping.addEventListener('input', e => {
      state.reverbDamping = parseInt(e.target.value) / 100;
      $('reverbDampingVal').textContent = state.reverbDamping.toFixed(2);
      if (state.synth) state.synth.setReverbDamping(state.reverbDamping);
    });
  }
  const reverbMix = $('reverbMix');
  if (reverbMix) {
    reverbMix.addEventListener('input', e => {
      state.reverbMix = parseInt(e.target.value) / 100;
      $('reverbMixVal').textContent = state.reverbMix.toFixed(2);
      if (state.synth) state.synth.setReverbMix(state.reverbMix);
    });
  }

  // ── Effects: Delay ──
  const delaySync = $('delaySync');
  if (delaySync) {
    delaySync.addEventListener('change', e => {
      state.delaySyncType = e.target.value;
      if (state.synth) state.synth.setDelaySync(state.delaySyncType);
    });
  }
  const delayFeedback = $('delayFeedback');
  if (delayFeedback) {
    delayFeedback.addEventListener('input', e => {
      state.delayFeedback = parseInt(e.target.value) / 100;
      $('delayFeedbackVal').textContent = state.delayFeedback.toFixed(2);
      if (state.synth) state.synth.setDelayFeedback(state.delayFeedback);
    });
  }
  const delayMix = $('delayMix');
  if (delayMix) {
    delayMix.addEventListener('input', e => {
      state.delayMix = parseInt(e.target.value) / 100;
      $('delayMixVal').textContent = state.delayMix.toFixed(2);
      if (state.synth) state.synth.setDelayMix(state.delayMix);
    });
  }

  // ── ADSR Envelope ──
  const adsrAttack = $('adsrAttack');
  if (adsrAttack) {
    adsrAttack.addEventListener('input', e => {
      state.adsrAttack = parseInt(e.target.value) / 1000;
      $('adsrAttackVal').textContent = `${e.target.value}ms`;
      if (state.synth) state.synth.setAttack(state.adsrAttack);
    });
  }
  const adsrDecay = $('adsrDecay');
  if (adsrDecay) {
    adsrDecay.addEventListener('input', e => {
      state.adsrDecay = parseInt(e.target.value) / 1000;
      $('adsrDecayVal').textContent = `${e.target.value}ms`;
      if (state.synth) state.synth.setDecay(state.adsrDecay);
    });
  }
  const adsrSustain = $('adsrSustain');
  if (adsrSustain) {
    adsrSustain.addEventListener('input', e => {
      state.adsrSustain = parseInt(e.target.value) / 100;
      $('adsrSustainVal').textContent = state.adsrSustain.toFixed(2);
      if (state.synth) state.synth.setSustain(state.adsrSustain);
    });
  }
  const adsrRelease = $('adsrRelease');
  if (adsrRelease) {
    adsrRelease.addEventListener('input', e => {
      state.adsrRelease = parseInt(e.target.value) / 1000;
      $('adsrReleaseVal').textContent = `${e.target.value}ms`;
      if (state.synth) state.synth.setRelease(state.adsrRelease);
    });
  }

  // ── Arpeggiator ──
  const arpMode = $('arpMode');
  if (arpMode) {
    arpMode.addEventListener('change', e => {
      state.arpMode = e.target.value;
      if (state.arp) state.arp.setMode(state.arpMode);
      // When turning arp off, let the normal harmony loop take over
      if (state.arpMode === 'off' && state.synth) {
        state.synth.muteAll();
      }
    });
  }
}

function setStatus(msg) {
  if (ui.statusBar) ui.statusBar.textContent = msg;
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH UI
// ═══════════════════════════════════════════════════════════════════════════════

let authIsSignUp = false;

function wireAuthUI() {
  const authBtn = $('authBtn');
  const authModal = $('authModal');
  const authForm = $('authForm');
  const authToggleBtn = $('authToggleBtn');
  const authModalClose = $('authModalClose');
  const patchesBtn = $('patchesBtn');

  // Open auth modal (or sign out if already signed in)
  authBtn.addEventListener('click', () => {
    if (isAuthenticated()) {
      signOut();
    } else {
      authIsSignUp = false;
      updateAuthModalMode();
      authModal.classList.remove('hidden');
    }
  });

  // Close modal
  authModalClose.addEventListener('click', () => authModal.classList.add('hidden'));
  authModal.addEventListener('click', e => {
    if (e.target === authModal) authModal.classList.add('hidden');
  });

  // Toggle sign-in / sign-up
  authToggleBtn.addEventListener('click', () => {
    authIsSignUp = !authIsSignUp;
    updateAuthModalMode();
  });

  // Submit auth form
  authForm.addEventListener('submit', async e => {
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
      authModal.classList.add('hidden');
      authForm.reset();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    } finally {
      $('authSubmit').textContent = authIsSignUp ? 'SIGN UP' : 'SIGN IN';
    }
  });

  // Patches button
  patchesBtn.addEventListener('click', () => openPatchEditor());

  // License button + modal
  const licensesBtn = $('licensesBtn');
  const licenseModal = $('licenseModal');
  licensesBtn.addEventListener('click', openLicenseModal);
  $('licenseModalClose').addEventListener('click', () => licenseModal.classList.add('hidden'));

  // React to auth state changes
  onAuthStateChange(session => {
    const user = session?.user;
    if (user) {
      authBtn.textContent = 'SIGN OUT';
      authBtn.classList.add('signed-in');
      // Show patches/sessions/license buttons
      patchesBtn.style.visibility = 'visible';
      $('sessionsBtn').style.visibility = 'visible';
      licensesBtn.style.visibility = 'visible';
    } else {
      authBtn.textContent = 'SIGN IN';
      authBtn.classList.remove('signed-in');
      patchesBtn.style.visibility = 'hidden';
      $('sessionsBtn').style.visibility = 'hidden';
      licensesBtn.style.visibility = 'hidden';
    }
  });
}

async function openLicenseModal() {
  const modal = $('licenseModal');
  const content = $('licenseContent');
  modal.classList.remove('hidden');
  content.innerHTML = '<p class="text-dim">Loading...</p>';

  try {
    const licenses = await listLicenses();
    if (!licenses.length) {
      content.innerHTML = `
        <p class="text-dim">No licenses found.</p>
        <p style="color: var(--gold); margin-top: 12px; font-size: 13px;">
          Purchase THIRI Suite to unlock the full plugin experience.
        </p>
      `;
      return;
    }

    content.innerHTML = licenses.map(lic => {
      const productName = lic.product.replace('thiri_', '').toUpperCase();
      const isActivated = !!lic.activated_at;
      const dateStr = isActivated
        ? new Date(lic.activated_at).toLocaleDateString()
        : new Date(lic.created_at).toLocaleDateString();
      return `
        <div style="padding: 14px; margin-bottom: 10px; background: rgba(255,255,255,0.03); border-radius: 8px; border: 1px solid rgba(255,255,255,0.08);">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div>
              <strong style="color: #d4af37; font-size: 14px;">THIRI ${productName}</strong>
              <div style="color: #888; font-size: 11px; margin-top: 4px;">
                ${isActivated ? 'Activated ' + dateStr : 'Purchased ' + dateStr + ' \u2014 not yet activated'}
              </div>
            </div>
            <button class="btn-sm" onclick="window._activateLicense('${lic.id}')"
              style="background: rgba(212,175,55,0.15); color: #d4af37; border: 1px solid rgba(212,175,55,0.3); cursor: pointer;">
              ${isActivated ? 'RE-DOWNLOAD' : 'ACTIVATE'}
            </button>
          </div>
          <div style="color: #666; font-size: 10px; margin-top: 10px;">
            Save <code style="color: #999;">license.key</code> to: <code style="color: #999;">~/Documents/THIRI/license.key</code>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    content.innerHTML = `<p style="color: #e44; padding: 8px;">${err.message}</p>`;
  }
}

// Global handler for license activation button clicks
window._activateLicense = async (licenseId) => {
  try {
    const result = await activateLicense(licenseId);
    downloadLicenseFile(result.content, result.filename);
  } catch (err) {
    alert('Activation failed: ' + err.message);
  }
};

function updateAuthModalMode() {
  $('authModalTitle').textContent = authIsSignUp ? 'SIGN UP' : 'SIGN IN';
  $('authSubmit').textContent = authIsSignUp ? 'SIGN UP' : 'SIGN IN';
  $('authToggleText').textContent = authIsSignUp ? 'Have an account?' : 'No account?';
  $('authToggleBtn').textContent = authIsSignUp ? 'Sign in' : 'Sign up';
}

// ═══════════════════════════════════════════════════════════════════════════════
// DIAGNOSTICS OVERLAY
// ═══════════════════════════════════════════════════════════════════════════════

function updateDiagnostics(pitchInfo, harmonyKey, harmonyMode) {
  const diagEl = $('diagnostics');
  if (!diagEl) return;

  const confidence = pitchInfo.confidence?.toFixed(2) ?? '–';
  const rms = pitchInfo.rms?.toFixed(4) ?? '–';
  const drift = pitchInfo.driftCents?.toFixed(1) ?? '0';
  const chordLabel = state.currentChord?.symbol ?? '–';
  const gateStatus = (pitchInfo.rms ?? 0) < state.gateThreshold ? 'GATED' : 'OPEN';

  diagEl.innerHTML =
    `<span class="diag-item">CONF <b>${confidence}</b></span>` +
    `<span class="diag-item">RMS <b>${rms}</b></span>` +
    `<span class="diag-item">GATE <b class="${gateStatus === 'GATED' ? 'diag-warn' : ''}">${gateStatus}</b></span>` +
    `<span class="diag-item">DRIFT <b>${drift}¢</b></span>` +
    `<span class="diag-sep">|</span>` +
    `<span class="diag-item">KEY <b>${harmonyKey} ${harmonyMode}</b></span>` +
    `<span class="diag-item">CHORD <b>${chordLabel}</b></span>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  populateSelectors();
  buildVoiceCards();
  wireControls();
  wireAuthUI();
  initPatchEditor();
  initChartUI((sections, navigation, queue) => {
    state.chartSections = sections;
    state.chartQueue = queue;
    if (state.chartActive && sections.length > 0) {
      const firstBar = sections[0]?.bars?.[0];
      if (firstBar?.chords?.length > 0) {
        state.currentChord = firstBar.chords[0];
      }
    }
  });

  // BPM sync: chart tempo → drum engine + delay + arpeggiator
  const chartTempo = $('chartTempo');
  if (chartTempo) {
    chartTempo.addEventListener('input', e => {
      const bpm = parseInt(e.target.value);
      $('chartTempoVal').textContent = bpm;
      if (state.synth) state.synth.setDelayBPM(bpm);
      if (state.arp) state.arp.setBPM(bpm);
    });
  }

  // ── Notation Display ──
  const notationEl = $('notationDisplay');
  if (notationEl) initNotation(notationEl);

  // ── Chord Pads ──
  initChordPads();

  // Init MIDI controller
  initMIDI();

  setStatus('Ready — click Start to begin');
});

// ═══════════════════════════════════════════════════════════════════════════════
// MIDI INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

async function initMIDI() {
  state.midi = new MIDIController();
  const available = await state.midi.init();

  if (!available) {
    console.log('[THIRI] No MIDI support — keyboard/mouse only');
    return;
  }

  const devices = state.midi.getDevices();
  console.log(`[THIRI] MIDI ready — ${devices.length} device(s):`, devices.map(d => d.name));

  // Register parameter handlers (normalized 0–1 input)
  state.midi.registerParam('vowel', (n) => {
    state.vowel = n;
    if ($('vowelSlider')) $('vowelSlider').value = Math.round(n * 100);
    const vowelNames = ['ah', 'ee', 'oh', 'oo'];
    const idx = Math.min(3, Math.floor(n * 3.99));
    if ($('vowelVal')) $('vowelVal').textContent = vowelNames[idx];
    if (state.synth) state.synth.setVowel(n);
  });

  state.midi.registerParam('breath', (n) => {
    state.breath = n;
    if ($('breathSlider')) $('breathSlider').value = Math.round(n * 100);
    if ($('breathVal')) $('breathVal').textContent = `${Math.round(n * 100)}%`;
    if (state.synth) state.synth.setBreath(n);
  });

  state.midi.registerParam('master', (n) => {
    state.masterVol = n;
    if ($('masterSlider')) $('masterSlider').value = Math.round(n * 100);
    if ($('masterVal')) $('masterVal').textContent = `${Math.round(n * 100)}%`;
    if (state.synth) state.synth.setMasterVolume(n);
  });

  state.midi.registerParam('mix', (n) => {
    state.mix = n;
    if ($('mixSlider')) $('mixSlider').value = Math.round(n * 100);
    if ($('mixVal')) $('mixVal').textContent = `${Math.round(n * 100)}%`;
    if (state.synth) state.synth.setMix(n);
  });

  state.midi.registerParam('humanize', (n) => {
    state.humanize = n;
    if ($('humanizeSlider')) $('humanizeSlider').value = Math.round(n * 100);
    if ($('humanizeVal')) $('humanizeVal').textContent = n.toFixed(2);
    if (state.synth) state.synth.setHumanize(n);
  });

  state.midi.registerParam('gate', (n) => {
    state.gateThreshold = n * 0.05;
    if ($('gateSlider')) $('gateSlider').value = Math.round(n * 50);
    if ($('gateVal')) $('gateVal').textContent = state.gateThreshold.toFixed(3);
    if (state.detector) state.detector._rmsThreshold = state.gateThreshold;
  });

  state.midi.registerParam('confidence', (n) => {
    state.minConfidence = 0.5 + n * 0.45;
    if ($('confidenceSlider')) $('confidenceSlider').value = Math.round(state.minConfidence * 100);
    if ($('confidenceVal')) $('confidenceVal').textContent = state.minConfidence.toFixed(2);
    if (state.detector) state.detector.minConfidence = state.minConfidence;
  });

  state.midi.registerParam('smoothing', (n) => {
    state.smoothingFactor = n * 0.9;
    if ($('smoothingSlider')) $('smoothingSlider').value = Math.round(state.smoothingFactor * 100);
    if ($('smoothingVal')) $('smoothingVal').textContent = state.smoothingFactor.toFixed(2);
    if (state.detector) state.detector.smoothingFactor = state.smoothingFactor;
  });

  // MIDI CC 64 — Sustain pedal → Hold
  state.midi.registerParam('hold', (n) => {
    const isHeld = n > 0.5;
    if (state.synth) state.synth.setHold(isHeld);
    const holdBtn = $('holdBtn');
    if (holdBtn) holdBtn.classList.toggle('active', isHeld);
  });

  // MIDI note input — could drive manual harmony in future
  state.midi.onNoteOn = (note, velocity, channel) => {
    console.log(`[MIDI] Note ON: ${note} vel:${velocity} ch:${channel}`);
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHORD PADS
// ═══════════════════════════════════════════════════════════════════════════════

function initChordPads() {
  // Build initial grid from current key
  rebuildChordPads();

  // Rebuild when key changes
  ui.keySelect.addEventListener('change', () => {
    rebuildChordPads();
  });

  // Tritone sub toggle
  const ttToggle = $('ttToggle');
  if (ttToggle) {
    ttToggle.addEventListener('click', () => {
      state.ttActive = !state.ttActive;
      ttToggle.classList.toggle('active', state.ttActive);
      renderPadRow(2);
      // Update active chord if it was in row 2
      if (state.activePadId?.startsWith('2-')) {
        const col = parseInt(state.activePadId.split('-')[1]);
        const chords = state.ttActive ? state.chordGrid.tritones : state.chordGrid.dominants;
        if (chords[col]) {
          state.currentChord = chords[col];
          state.chartActive = true;
        }
      }
    });
  }

  // Dominant toggle
  const domToggle = $('domToggle');
  if (domToggle) {
    domToggle.addEventListener('click', () => {
      state.domActive = !state.domActive;
      domToggle.classList.toggle('active', state.domActive);
      renderPadRow(3);
      // Update active chord if it was in row 3
      if (state.activePadId?.startsWith('3-')) {
        const col = parseInt(state.activePadId.split('-')[1]);
        const chords = state.domActive ? state.chordGrid.approachesDom : state.chordGrid.approaches;
        if (chords[col]) {
          state.currentChord = chords[col];
          state.chartActive = true;
        }
      }
    });
  }
}

function rebuildChordPads() {
  state.chordGrid = buildChordGrid(state.key);
  if (!state.chordGrid) return;

  // Update key display
  const keyDisplay = $('padsKeyDisplay');
  if (keyDisplay) keyDisplay.textContent = `${state.key} ${state.mode}`;

  // Clear active pad
  state.activePadId = null;
  state.currentChord = null;
  state.chartActive = false;

  // Render all 3 rows
  renderPadRow(1);
  renderPadRow(2);
  renderPadRow(3);
}

function renderPadRow(rowNum) {
  const rowEl = $(`padRow${rowNum}`);
  if (!rowEl || !state.chordGrid) return;

  let chords, labelFn;
  if (rowNum === 1) {
    chords = state.chordGrid.diatonic;
    labelFn = (i) => getRomanNumeral(i);
  } else if (rowNum === 2) {
    chords = state.ttActive ? state.chordGrid.tritones : state.chordGrid.dominants;
    labelFn = (i) => state.ttActive ? 'TT/' + getRomanNumeral(i) : getDominantLabel(i);
  } else {
    chords = state.domActive ? state.chordGrid.approachesDom : state.chordGrid.approaches;
    labelFn = (i) => state.domActive ? 'dom/' + getRomanNumeral(i) : getApproachLabel(i);
  }

  rowEl.innerHTML = '';
  chords.forEach((chord, col) => {
    const pad = document.createElement('button');
    pad.className = 'chord-pad';
    const padId = `${rowNum}-${col}`;
    pad.dataset.padId = padId;

    if (state.activePadId === padId) pad.classList.add('active');

    pad.innerHTML = `
      <span class="pad-symbol">${chord.symbol}</span>
      <span class="pad-label">${labelFn(col)}</span>
    `;

    pad.addEventListener('click', () => {
      // Deactivate previous
      document.querySelectorAll('.chord-pad.active').forEach(p => p.classList.remove('active'));

      // Activate this pad
      pad.classList.add('active');
      state.activePadId = padId;
      state.currentChord = chord;
      state.chartActive = true;

      // Reset voice leading for clean transition
      state.prevHarmonyNotes = [];
    });

    rowEl.appendChild(pad);
  });
}
