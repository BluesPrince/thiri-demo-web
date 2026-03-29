/**
 * synth.js — Web Audio Synthesis Layer
 * ======================================
 * Manages oscillator-based harmony voice synthesis via Web Audio API.
 * Each harmony voice is an OscillatorNode with a GainNode envelope.
 *
 * Architecture:
 *   Mic (dry) ──────────────────────────────┐
 *                                           ├─→ masterGain → destination
 *   HarmonyVoice × N → harmonyBus ──────────┘
 *
 * The dry mic signal and harmony bus are kept separate to prevent
 * harmony audio from re-entering pitch detection (no feedback).
 *
 * Copyright 2026 Blues Prince Media. PATENT PENDING.
 */

import { midiToFreq } from './scales.js';

// ═══════════════════════════════════════════════════════════════════════════════
// HARMONY VOICE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A single harmony voice — owns an oscillator, gain envelope, and detune.
 */
export class HarmonyVoice {
  constructor(audioContext, destination, options = {}) {
    this.ctx = audioContext;
    this.targetMidi = -1;
    this.active = false;

    this.waveform = options.waveform ?? 'sine';
    this.detune = options.detune ?? 0;         // cents of detuning for thickness
    this.volume = options.volume ?? 0.7;
    this.attackTime = options.attackTime ?? 0.025;  // 25ms attack
    this.releaseTime = options.releaseTime ?? 0.06;  // 60ms release

    // Humanization parameters
    this.humanize = options.humanize ?? 0.0;  // 0–1: amount of humanization
    this._vibratoLFO = null;
    this._vibratoGain = null;

    // Gain envelope node
    this.gainNode = audioContext.createGain();
    this.gainNode.gain.setValueAtTime(0, audioContext.currentTime);
    this.gainNode.connect(destination);

    // Oscillator — created once and kept running for low-latency transitions
    this.oscillator = audioContext.createOscillator();
    this.oscillator.type = this.waveform;
    this.oscillator.frequency.setValueAtTime(440, audioContext.currentTime);
    this.oscillator.detune.setValueAtTime(this.detune, audioContext.currentTime);
    this.oscillator.connect(this.gainNode);
    this.oscillator.start();

    // Vibrato LFO → detune (humanization)
    this._vibratoLFO = audioContext.createOscillator();
    this._vibratoGain = audioContext.createGain();
    this._vibratoLFO.type = 'sine';
    // Randomize rate per voice (4.5–6.5 Hz) for natural variation
    this._vibratoLFO.frequency.setValueAtTime(
      4.5 + Math.random() * 2.0,
      audioContext.currentTime
    );
    this._vibratoGain.gain.setValueAtTime(0, audioContext.currentTime);
    this._vibratoLFO.connect(this._vibratoGain);
    this._vibratoGain.connect(this.oscillator.detune);
    this._vibratoLFO.start();
  }

  /**
   * Smoothly transition this voice to a new MIDI note.
   * Uses exponential frequency ramp for glide, gain envelope for click-free transitions.
   * With humanization: adds micro-pitch offset, timing jitter, and vibrato.
   */
  setNote(midiNote) {
    const now = this.ctx.currentTime;
    const freq = midiToFreq(midiNote);

    if (this.targetMidi === midiNote) return; // already there
    this.targetMidi = midiNote;

    // Humanization: micro-pitch offset (±8 cents scaled by humanize)
    const microPitch = this.humanize * (Math.random() * 16 - 8);
    this.oscillator.detune.cancelScheduledValues(now);
    this.oscillator.detune.setValueAtTime(this.detune + microPitch, now);

    // Humanization: vibrato depth (0–12 cents based on humanize)
    this._vibratoGain.gain.setValueAtTime(this.humanize * 12, now);

    // Humanization: micro-timing jitter (0–15ms delay on attack)
    const jitter = this.humanize * Math.random() * 0.015;

    // Frequency glide — smooth pitch transition
    this.oscillator.frequency.cancelScheduledValues(now);
    this.oscillator.frequency.setValueAtTime(
      this.oscillator.frequency.value,
      now
    );
    this.oscillator.frequency.exponentialRampToValueAtTime(
      Math.max(freq, 20), // never set to 0 — breaks exponential ramp
      now + 0.015 + jitter // 15ms glide + humanize jitter
    );

    // Gain envelope — only attack if not already active
    if (!this.active) {
      this.gainNode.gain.cancelScheduledValues(now);
      this.gainNode.gain.setValueAtTime(0, now + jitter);
      this.gainNode.gain.linearRampToValueAtTime(this.volume, now + jitter + this.attackTime);
      this.active = true;
    }
  }

  /**
   * Mute this voice with a release envelope.
   */
  mute() {
    if (!this.active) return;
    const now = this.ctx.currentTime;
    this.gainNode.gain.cancelScheduledValues(now);
    this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
    this.gainNode.gain.linearRampToValueAtTime(0, now + this.releaseTime);
    this.active = false;
    this.targetMidi = -1;
  }

  setWaveform(type) {
    this.waveform = type;
    this.oscillator.type = type;
  }

  setDetune(cents) {
    this.detune = cents;
    this.oscillator.detune.setValueAtTime(cents, this.ctx.currentTime);
  }

  setVolume(vol) {
    this.volume = vol;
    if (this.active) {
      this.gainNode.gain.setValueAtTime(vol, this.ctx.currentTime);
    }
  }

  setHumanize(amount) {
    this.humanize = Math.max(0, Math.min(1, amount));
    // Update vibrato depth immediately
    this._vibratoGain.gain.setValueAtTime(
      this.humanize * 12,
      this.ctx.currentTime
    );
  }

  destroy() {
    this.mute();
    setTimeout(() => {
      try {
        this._vibratoLFO.stop();
        this._vibratoLFO.disconnect();
        this._vibratoGain.disconnect();
        this.oscillator.stop();
        this.oscillator.disconnect();
        this.gainNode.disconnect();
      } catch (_) { /* already stopped */ }
    }, 200);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FORMANT VOICE — Vocal-tract modeled synthesis for THIRI.ai
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Vowel formant frequencies (Hz) and bandwidths.
 * Each vowel is defined by 4 formant resonances (F1–F4).
 * Source: Klatt (1980) formant synthesis model.
 */
const VOWEL_FORMANTS = {
  ah: { freqs: [800, 1150, 2800, 3500], bws: [80, 90, 120, 130], gains: [1.0, 0.5, 0.3, 0.2] },
  ee: { freqs: [270, 2300, 3000, 3300], bws: [60, 100, 120, 130], gains: [1.0, 0.4, 0.3, 0.2] },
  oh: { freqs: [450, 800, 2830, 3500],  bws: [70, 80, 100, 130],  gains: [1.0, 0.5, 0.35, 0.2] },
  oo: { freqs: [300, 870, 2250, 3500],  bws: [40, 90, 100, 130],  gains: [1.0, 0.4, 0.25, 0.15] },
};
const VOWEL_ORDER = ['ah', 'ee', 'oh', 'oo'];

/**
 * FormantVoice — Models the vocal tract with parallel bandpass filters.
 * Sounds like a choir voice instead of a raw oscillator.
 *
 * Signal chain:
 *   sawtooth OSC ──→ [F1 bandpass] → gain₁ ─┐
 *                 ──→ [F2 bandpass] → gain₂ ──┼→ sum → envelope → output
 *   noise (breath) → [F3 bandpass] → gain₃ ──┤
 *                 ──→ [F4 bandpass] → gain₄ ──┘
 *
 * VOWEL parameter (0–1): crossfades formant frequencies between shapes.
 * BREATH parameter (0–1): blends noise excitation for aspiration.
 *
 * Copyright 2026 Blues Prince Media. PATENT PENDING.
 */
export class FormantVoice {
  constructor(audioContext, destination, options = {}) {
    this.ctx = audioContext;
    this.targetMidi = -1;
    this.active = false;
    this.volume = options.volume ?? 0.7;
    this.attackTime = options.attackTime ?? 0.035;
    this.releaseTime = options.releaseTime ?? 0.08;
    this.humanize = options.humanize ?? 0.0;
    this.vowelPos = options.vowel ?? 0.0;   // 0=ah, 0.33=ee, 0.67=oh, 1.0=oo
    this.breathAmount = options.breath ?? 0.15;

    const now = audioContext.currentTime;

    // ── Output envelope ──
    this.gainNode = audioContext.createGain();
    this.gainNode.gain.setValueAtTime(0, now);
    this.gainNode.connect(destination);

    // ── Formant sum bus ──
    this.formantBus = audioContext.createGain();
    this.formantBus.gain.setValueAtTime(1.0, now);
    this.formantBus.connect(this.gainNode);

    // ── Source: sawtooth oscillator (rich harmonics for filter excitation) ──
    this.oscillator = audioContext.createOscillator();
    this.oscillator.type = 'sawtooth';
    this.oscillator.frequency.setValueAtTime(440, now);
    this.oscillator.start();

    // ── Breath noise source ──
    this._noiseNode = this._createNoiseSource(audioContext);
    this._noiseGain = audioContext.createGain();
    this._noiseGain.gain.setValueAtTime(this.breathAmount * 0.3, now);
    this._noiseNode.connect(this._noiseGain);

    // ── 4 Formant filters (parallel) ──
    this.formants = [];
    const initVowel = VOWEL_FORMANTS.ah;
    for (let i = 0; i < 4; i++) {
      const filter = audioContext.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(initVowel.freqs[i], now);
      filter.Q.setValueAtTime(initVowel.freqs[i] / initVowel.bws[i], now);

      const fGain = audioContext.createGain();
      fGain.gain.setValueAtTime(initVowel.gains[i], now);

      // Connect both sources through this formant
      this.oscillator.connect(filter);
      this._noiseGain.connect(filter);
      filter.connect(fGain);
      fGain.connect(this.formantBus);

      this.formants.push({ filter, gain: fGain });
    }

    // ── Vibrato LFO (humanization) ──
    this._vibratoLFO = audioContext.createOscillator();
    this._vibratoGain = audioContext.createGain();
    this._vibratoLFO.type = 'sine';
    this._vibratoLFO.frequency.setValueAtTime(4.5 + Math.random() * 2.0, now);
    this._vibratoGain.gain.setValueAtTime(0, now);
    this._vibratoLFO.connect(this._vibratoGain);
    this._vibratoGain.connect(this.oscillator.detune);
    this._vibratoLFO.start();

    // Apply initial vowel
    this._applyVowel(this.vowelPos);
  }

  /**
   * Create a white noise AudioBufferSourceNode (looping).
   */
  _createNoiseSource(ctx) {
    const bufferSize = ctx.sampleRate * 2;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.loop = true;
    node.start();
    return node;
  }

  /**
   * Interpolate formant frequencies based on vowel position (0–1).
   * 0 = "ah", 0.33 = "ee", 0.67 = "oh", 1.0 = "oo"
   */
  _applyVowel(pos) {
    const clamped = Math.max(0, Math.min(1, pos));
    const segCount = VOWEL_ORDER.length - 1;
    const rawIdx = clamped * segCount;
    const loIdx = Math.floor(rawIdx);
    const hiIdx = Math.min(loIdx + 1, segCount);
    const t = rawIdx - loIdx;

    const loVowel = VOWEL_FORMANTS[VOWEL_ORDER[loIdx]];
    const hiVowel = VOWEL_FORMANTS[VOWEL_ORDER[hiIdx]];
    const now = this.ctx.currentTime;

    for (let i = 0; i < 4; i++) {
      const freq = loVowel.freqs[i] + (hiVowel.freqs[i] - loVowel.freqs[i]) * t;
      const bw = loVowel.bws[i] + (hiVowel.bws[i] - loVowel.bws[i]) * t;
      const gain = loVowel.gains[i] + (hiVowel.gains[i] - loVowel.gains[i]) * t;

      this.formants[i].filter.frequency.setTargetAtTime(freq, now, 0.02);
      this.formants[i].filter.Q.setTargetAtTime(freq / bw, now, 0.02);
      this.formants[i].gain.gain.setTargetAtTime(gain, now, 0.02);
    }
  }

  setNote(midiNote) {
    const now = this.ctx.currentTime;
    const freq = midiToFreq(midiNote);

    if (this.targetMidi === midiNote) return;
    this.targetMidi = midiNote;

    // Humanization: micro-pitch offset
    const microPitch = this.humanize * (Math.random() * 16 - 8);
    this.oscillator.detune.cancelScheduledValues(now);
    this.oscillator.detune.setValueAtTime(microPitch, now);

    // Humanization: vibrato depth
    this._vibratoGain.gain.setValueAtTime(this.humanize * 12, now);

    // Humanization: timing jitter
    const jitter = this.humanize * Math.random() * 0.015;

    // Frequency glide
    this.oscillator.frequency.cancelScheduledValues(now);
    this.oscillator.frequency.setValueAtTime(this.oscillator.frequency.value, now);
    this.oscillator.frequency.exponentialRampToValueAtTime(
      Math.max(freq, 20), now + 0.015 + jitter
    );

    // Gain envelope
    if (!this.active) {
      this.gainNode.gain.cancelScheduledValues(now);
      this.gainNode.gain.setValueAtTime(0, now + jitter);
      this.gainNode.gain.linearRampToValueAtTime(this.volume, now + jitter + this.attackTime);
      this.active = true;
    }
  }

  mute() {
    if (!this.active) return;
    const now = this.ctx.currentTime;
    this.gainNode.gain.cancelScheduledValues(now);
    this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
    this.gainNode.gain.linearRampToValueAtTime(0, now + this.releaseTime);
    this.active = false;
    this.targetMidi = -1;
  }

  setVowel(pos) {
    this.vowelPos = pos;
    this._applyVowel(pos);
  }

  setBreath(amount) {
    this.breathAmount = Math.max(0, Math.min(1, amount));
    this._noiseGain.gain.setValueAtTime(this.breathAmount * 0.3, this.ctx.currentTime);
  }

  setVolume(vol) {
    this.volume = vol;
    if (this.active) {
      this.gainNode.gain.setValueAtTime(vol, this.ctx.currentTime);
    }
  }

  setHumanize(amount) {
    this.humanize = Math.max(0, Math.min(1, amount));
    this._vibratoGain.gain.setValueAtTime(this.humanize * 12, this.ctx.currentTime);
  }

  // Compatibility stubs for SynthEngine
  setWaveform() {} // formant voices don't use waveform selection
  setDetune(cents) {
    this.oscillator.detune.setValueAtTime(cents, this.ctx.currentTime);
  }

  destroy() {
    this.mute();
    setTimeout(() => {
      try {
        this._vibratoLFO.stop();
        this._vibratoLFO.disconnect();
        this._vibratoGain.disconnect();
        this._noiseNode.stop();
        this._noiseNode.disconnect();
        this._noiseGain.disconnect();
        this.oscillator.stop();
        this.oscillator.disconnect();
        this.formants.forEach(f => {
          f.filter.disconnect();
          f.gain.disconnect();
        });
        this.formantBus.disconnect();
        this.gainNode.disconnect();
      } catch (_) {}
    }, 200);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FM VOICE (BONUS: Synth Mode)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * FM synthesis voice — carrier modulated by a secondary oscillator.
 * Exposes modulation index and frequency ratio for timbre control.
 * Inspired by the "Synthesis Lab" preset in WoodShed's VibeKeys concept.
 */
export class FMHarmonyVoice extends HarmonyVoice {
  constructor(audioContext, destination, options = {}) {
    super(audioContext, destination, options);

    this.modRatio = options.modRatio ?? 1.0;     // Modulator frequency = carrier × ratio
    this.modIndex = options.modIndex ?? 3.0;     // Modulation index (depth)

    // Create modulator oscillator
    this.modulator = audioContext.createOscillator();
    this.modulatorGain = audioContext.createGain();

    this.modulator.type = 'sine';
    this.modulatorGain.gain.setValueAtTime(
      440 * this.modIndex,
      audioContext.currentTime
    );

    // FM routing: modulator → modulatorGain → carrier frequency param
    this.modulator.connect(this.modulatorGain);
    this.modulatorGain.connect(this.oscillator.frequency);
    this.modulator.start();
  }

  setNote(midiNote) {
    super.setNote(midiNote);
    const freq = midiToFreq(midiNote);
    // Update modulator frequency to track carrier × ratio
    const modFreq = freq * this.modRatio;
    this.modulator.frequency.setValueAtTime(
      Math.max(modFreq, 1),
      this.ctx.currentTime
    );
    // Update modulation depth
    this.modulatorGain.gain.setValueAtTime(
      freq * this.modIndex,
      this.ctx.currentTime
    );
  }

  setModRatio(ratio) {
    this.modRatio = ratio;
    const freq = midiToFreq(Math.max(this.targetMidi, 60));
    this.modulator.frequency.setValueAtTime(freq * ratio, this.ctx.currentTime);
  }

  setModIndex(index) {
    this.modIndex = index;
    const freq = midiToFreq(Math.max(this.targetMidi, 60));
    this.modulatorGain.gain.setValueAtTime(freq * index, this.ctx.currentTime);
  }

  destroy() {
    super.destroy();
    setTimeout(() => {
      try {
        this.modulator.stop();
        this.modulator.disconnect();
        this.modulatorGain.disconnect();
      } catch (_) { }
    }, 200);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SYNTH ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Manages N harmony voices, the mic passthrough, and the dry/wet mix.
 *
 * Audio routing:
 *
 *   micSource ─────→ dryGain ─────┐
 *                                 ├─→ masterGain → ctx.destination
 *   [N voices] → harmonyBus ──────┘
 *                   ↑
 *                wetGain
 *
 * The micSource connects to dryGain only — it does NOT connect to the
 * analyser that pitch detection uses. This prevents feedback.
 */
export class SynthEngine {
  constructor(audioContext, maxVoices = 5) {
    this.ctx = audioContext;
    this.maxVoices = maxVoices;
    this.voices = [];
    this.voiceType = 'formant';  // 'formant' | 'oscillator' | 'fm'

    // Build the signal graph
    this.masterGain = audioContext.createGain();
    this.masterGain.gain.setValueAtTime(0.85, audioContext.currentTime);
    this.masterGain.connect(audioContext.destination);

    // Harmony bus (all voice outputs sum here)
    this.harmonyBus = audioContext.createGain();
    this.harmonyBus.gain.setValueAtTime(1.0, audioContext.currentTime);

    // Separate wet gain for mix control
    this.wetGain = audioContext.createGain();
    this.wetGain.gain.setValueAtTime(0.8, audioContext.currentTime);
    this.harmonyBus.connect(this.wetGain);
    this.wetGain.connect(this.masterGain);

    // Dry gain for mic passthrough
    this.dryGain = audioContext.createGain();
    this.dryGain.gain.setValueAtTime(1.0, audioContext.currentTime);
    this.dryGain.connect(this.masterGain);

    // Mic source node (set after getUserMedia)
    this.micSource = null;

    // Initialize voices (formant by default — THIRI.ai vocal sound)
    this._buildVoices(maxVoices);
  }

  _buildVoices(count) {
    // Destroy existing voices
    this.voices.forEach(v => v.destroy());
    this.voices = [];

    for (let i = 0; i < count; i++) {
      let voice;
      if (this.voiceType === 'formant') {
        voice = new FormantVoice(this.ctx, this.harmonyBus, {
          volume: 0.6,
          vowel: 0.0,    // start with "ah" — open choir sound
          breath: 0.15,
        });
      } else if (this.voiceType === 'fm') {
        voice = new FMHarmonyVoice(this.ctx, this.harmonyBus, {
          waveform: 'sine',
          detune: (i % 2 === 0 ? 1 : -1) * i * 3,
          volume: 0.6,
        });
      } else {
        voice = new HarmonyVoice(this.ctx, this.harmonyBus, {
          waveform: 'sine',
          detune: (i % 2 === 0 ? 1 : -1) * i * 3,
          volume: 0.6,
        });
      }
      this.voices.push(voice);
    }
  }

  connectMic(micStream) {
    if (this.micSource) {
      this.micSource.disconnect();
    }
    this.micSource = this.ctx.createMediaStreamSource(micStream);
    this.micSource.connect(this.dryGain);
    return this.micSource;
  }

  update(midiNotes) {
    for (let i = 0; i < this.voices.length; i++) {
      if (i < midiNotes.length && midiNotes[i] > 0) {
        this.voices[i].setNote(midiNotes[i]);
      } else {
        this.voices[i].mute();
      }
    }
  }

  muteAll() {
    this.voices.forEach(v => v.mute());
  }

  setVoiceCount(count) {
    const n = Math.min(Math.max(count, 1), this.maxVoices);
    for (let i = n; i < this.voices.length; i++) {
      this.voices[i].mute();
    }
  }

  setWaveform(type) {
    this.voices.forEach(v => v.setWaveform(type));
  }

  setVoiceWaveform(voiceIndex, type) {
    if (this.voices[voiceIndex]) {
      this.voices[voiceIndex].setWaveform(type);
    }
  }

  setVoiceVolume(voiceIndex, vol) {
    if (this.voices[voiceIndex]) {
      this.voices[voiceIndex].setVolume(vol);
    }
  }

  setVoiceDetune(voiceIndex, cents) {
    if (this.voices[voiceIndex]) {
      this.voices[voiceIndex].setDetune(cents);
    }
  }

  setMasterVolume(vol) {
    this.masterGain.gain.setValueAtTime(
      Math.max(0, Math.min(1, vol)),
      this.ctx.currentTime
    );
  }

  setMix(mix) {
    const clipped = Math.max(0, Math.min(1, mix));
    const dryVol = Math.cos(clipped * Math.PI / 2);
    const wetVol = Math.sin(clipped * Math.PI / 2);
    this.dryGain.gain.setValueAtTime(dryVol, this.ctx.currentTime);
    this.wetGain.gain.setValueAtTime(wetVol, this.ctx.currentTime);
  }

  /** Set voice type: 'formant' (vocal), 'oscillator' (raw), 'fm' (synth) */
  setVoiceType(type) {
    this.voiceType = type;
    this._buildVoices(this.maxVoices);
  }

  /** Legacy FM mode toggle — maps to voiceType */
  setFMMode(enabled) {
    this.setVoiceType(enabled ? 'fm' : 'formant');
  }

  /** Set FM modulation ratio for all voices */
  setModRatio(ratio) {
    this.voices.forEach(v => {
      if (v instanceof FMHarmonyVoice) v.setModRatio(ratio);
    });
  }

  /** Set humanization amount for all voices (0–1) */
  setHumanize(amount) {
    this.voices.forEach(v => v.setHumanize(amount));
  }

  /** Set FM modulation index for all voices */
  setModIndex(index) {
    this.voices.forEach(v => {
      if (v instanceof FMHarmonyVoice) v.setModIndex(index);
    });
  }

  /** Set vowel position for all formant voices (0–1: ah→ee→oh→oo) */
  setVowel(pos) {
    this.voices.forEach(v => {
      if (v instanceof FormantVoice) v.setVowel(pos);
    });
  }

  /** Set breath amount for all formant voices (0–1) */
  setBreath(amount) {
    this.voices.forEach(v => {
      if (v instanceof FormantVoice) v.setBreath(amount);
    });
  }

  destroy() {
    this.voices.forEach(v => v.destroy());
    if (this.micSource) this.micSource.disconnect();
    this.harmonyBus.disconnect();
    this.wetGain.disconnect();
    this.dryGain.disconnect();
    this.masterGain.disconnect();
  }
}
