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
import { VocoderVoice } from './vocoder-voice.js';

// ═══════════════════════════════════════════════════════════════════════════════
// ADSR DEFAULTS
// ═══════════════════════════════════════════════════════════════════════════════

const ADSR_DEFAULTS = {
  attack:  0.01,   // 10ms
  decay:   0.1,    // 100ms
  sustain: 0.8,    // 80% of peak
  release: 0.15,   // 150ms
};

// ═══════════════════════════════════════════════════════════════════════════════
// REVERB EFFECT — Algorithmic Schroeder reverb via feedback delay network
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Simple algorithmic reverb using Web Audio ConvolverNode with a generated IR.
 * Controls: size (0-1), damping (0-1), mix (0-1).
 */
export class ReverbEffect {
  constructor(audioContext) {
    this.ctx = audioContext;

    // Dry/wet routing
    this.input = audioContext.createGain();
    this.output = audioContext.createGain();
    this.dryGain = audioContext.createGain();
    this.wetGain = audioContext.createGain();

    this.convolver = audioContext.createConvolver();

    // Route: input → dry → output
    //        input → convolver → wet → output
    this.input.connect(this.dryGain);
    this.input.connect(this.convolver);
    this.convolver.connect(this.wetGain);
    this.dryGain.connect(this.output);
    this.wetGain.connect(this.output);

    // Defaults
    this._size = 0.6;
    this._damping = 0.5;
    this._mix = 0.2;

    this.dryGain.gain.setValueAtTime(1 - this._mix, audioContext.currentTime);
    this.wetGain.gain.setValueAtTime(this._mix, audioContext.currentTime);

    this._generateIR();
  }

  _generateIR() {
    const sr = this.ctx.sampleRate;
    const length = Math.floor(sr * (0.5 + this._size * 3.5)); // 0.5s to 4s
    const decay = 0.5 + this._size * 4.5;
    const damping = this._damping;

    const buffer = this.ctx.createBuffer(2, length, sr);
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        const t = i / sr;
        // Exponential decay with noise excitation
        let sample = (Math.random() * 2 - 1) * Math.exp(-t * (6 - decay));
        // Damping: reduce high frequencies over time (simple lowpass effect)
        if (i > 0) {
          sample = sample * (1 - damping * 0.7) + data[i - 1] * damping * 0.7;
        }
        data[i] = sample;
      }
    }
    this.convolver.buffer = buffer;
  }

  setSize(size) {
    this._size = Math.max(0, Math.min(1, size));
    this._generateIR();
  }

  setDamping(damping) {
    this._damping = Math.max(0, Math.min(1, damping));
    this._generateIR();
  }

  setMix(mix) {
    this._mix = Math.max(0, Math.min(1, mix));
    const now = this.ctx.currentTime;
    this.dryGain.gain.setValueAtTime(1 - this._mix, now);
    this.wetGain.gain.setValueAtTime(this._mix, now);
  }

  connect(destination) {
    this.output.connect(destination);
  }

  disconnect() {
    this.output.disconnect();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DELAY EFFECT — Tempo-sync'd feedback delay
// ═══════════════════════════════════════════════════════════════════════════════

const SYNC_MULTIPLIERS = {
  '1/4':     1.0,
  '1/8':     0.5,
  '1/8D':    0.75,
  '1/16':    0.25,
  'triplet': 1/3,
};

/**
 * Tempo-sync'd stereo feedback delay.
 * Controls: syncType, feedback (0-0.9), mix (0-1), bpm.
 */
export class DelayEffect {
  constructor(audioContext) {
    this.ctx = audioContext;

    this.input = audioContext.createGain();
    this.output = audioContext.createGain();
    this.dryGain = audioContext.createGain();
    this.wetGain = audioContext.createGain();

    this.delayNode = audioContext.createDelay(4.0); // max 4s
    this.feedbackGain = audioContext.createGain();
    // Damping filter on feedback path
    this.dampFilter = audioContext.createBiquadFilter();
    this.dampFilter.type = 'lowpass';
    this.dampFilter.frequency.setValueAtTime(4000, audioContext.currentTime);

    // Route: input → dry → output
    //        input → delay → wet → output
    //                delay → dampFilter → feedback → delay (loop)
    this.input.connect(this.dryGain);
    this.input.connect(this.delayNode);
    this.delayNode.connect(this.wetGain);
    this.delayNode.connect(this.dampFilter);
    this.dampFilter.connect(this.feedbackGain);
    this.feedbackGain.connect(this.delayNode);
    this.dryGain.connect(this.output);
    this.wetGain.connect(this.output);

    // Defaults
    this._bpm = 120;
    this._syncType = '1/4';
    this._feedback = 0.35;
    this._mix = 0.2;

    const now = audioContext.currentTime;
    this.feedbackGain.gain.setValueAtTime(this._feedback, now);
    this.dryGain.gain.setValueAtTime(1 - this._mix, now);
    this.wetGain.gain.setValueAtTime(this._mix, now);
    this._updateDelayTime();
  }

  _updateDelayTime() {
    const beatDuration = 60 / this._bpm;
    const multiplier = SYNC_MULTIPLIERS[this._syncType] ?? 0.5;
    const delayTime = Math.min(beatDuration * multiplier, 3.9);
    this.delayNode.delayTime.setValueAtTime(delayTime, this.ctx.currentTime);
  }

  setBPM(bpm) {
    this._bpm = Math.max(20, Math.min(300, bpm));
    this._updateDelayTime();
  }

  setSyncType(type) {
    if (SYNC_MULTIPLIERS[type] !== undefined) {
      this._syncType = type;
      this._updateDelayTime();
    }
  }

  setFeedback(fb) {
    this._feedback = Math.max(0, Math.min(0.9, fb));
    this.feedbackGain.gain.setValueAtTime(this._feedback, this.ctx.currentTime);
  }

  setMix(mix) {
    this._mix = Math.max(0, Math.min(1, mix));
    const now = this.ctx.currentTime;
    this.dryGain.gain.setValueAtTime(1 - this._mix, now);
    this.wetGain.gain.setValueAtTime(this._mix, now);
  }

  connect(destination) {
    this.output.connect(destination);
  }

  disconnect() {
    this.output.disconnect();
  }
}

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
    // ADSR envelope
    this.attackTime = options.attackTime ?? ADSR_DEFAULTS.attack;
    this.decayTime = options.decayTime ?? ADSR_DEFAULTS.decay;
    this.sustainLevel = options.sustainLevel ?? ADSR_DEFAULTS.sustain;
    this.releaseTime = options.releaseTime ?? ADSR_DEFAULTS.release;

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

    // ADSR gain envelope — only attack if not already active
    if (!this.active) {
      const peakGain = this.volume;
      const sustainGain = peakGain * this.sustainLevel;
      this.gainNode.gain.cancelScheduledValues(now);
      this.gainNode.gain.setValueAtTime(0, now + jitter);
      // Attack: ramp to peak
      this.gainNode.gain.linearRampToValueAtTime(peakGain, now + jitter + this.attackTime);
      // Decay: ramp to sustain level
      this.gainNode.gain.linearRampToValueAtTime(sustainGain, now + jitter + this.attackTime + this.decayTime);
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

  setADSR(attack, decay, sustain, release) {
    this.attackTime = attack;
    this.decayTime = decay;
    this.sustainLevel = sustain;
    this.releaseTime = release;
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
  eh: { freqs: [530, 1850, 2500, 3300], bws: [60, 100, 120, 130], gains: [1.0, 0.5, 0.35, 0.2] },
  ee: { freqs: [270, 2300, 3000, 3300], bws: [60, 100, 120, 130], gains: [1.0, 0.4, 0.3, 0.2] },
  oh: { freqs: [450, 800, 2830, 3500],  bws: [70, 80, 100, 130],  gains: [1.0, 0.5, 0.35, 0.2] },
  oo: { freqs: [300, 870, 2250, 3500],  bws: [40, 90, 100, 130],  gains: [1.0, 0.4, 0.25, 0.15] },
};
const VOWEL_ORDER = ['ah', 'eh', 'ee', 'oh', 'oo'];

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
    this.attackTime = options.attackTime ?? ADSR_DEFAULTS.attack;
    this.decayTime = options.decayTime ?? ADSR_DEFAULTS.decay;
    this.sustainLevel = options.sustainLevel ?? ADSR_DEFAULTS.sustain;
    this.releaseTime = options.releaseTime ?? ADSR_DEFAULTS.release;
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

    // ADSR gain envelope
    if (!this.active) {
      const peakGain = this.volume;
      const sustainGain = peakGain * this.sustainLevel;
      this.gainNode.gain.cancelScheduledValues(now);
      this.gainNode.gain.setValueAtTime(0, now + jitter);
      this.gainNode.gain.linearRampToValueAtTime(peakGain, now + jitter + this.attackTime);
      this.gainNode.gain.linearRampToValueAtTime(sustainGain, now + jitter + this.attackTime + this.decayTime);
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

  setADSR(attack, decay, sustain, release) {
    this.attackTime = attack;
    this.decayTime = decay;
    this.sustainLevel = sustain;
    this.releaseTime = release;
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
  /**
   * Register the pitch-shifter AudioWorklet. Must be called once before
   * creating a SynthEngine that uses VocoderVoice ('formant' mode).
   */
  static async registerWorklet(audioContext) {
    if (SynthEngine._workletRegistered) return;
    try {
      await audioContext.audioWorklet.addModule('../js/pitch-shifter-worklet.js');
      SynthEngine._workletRegistered = true;
      console.log('[THIRI] Pitch shifter worklet registered');
    } catch (err) {
      console.warn('[THIRI] AudioWorklet registration failed — falling back to synth voices:', err.message);
      SynthEngine._workletFailed = true;
    }
  }

  static _workletRegistered = false;
  static _workletFailed = false;

  constructor(audioContext, maxVoices = 5) {
    this.ctx = audioContext;
    this.maxVoices = maxVoices;
    this.voices = [];
    this.voiceType = 'formant';  // 'formant' | 'oscillator' | 'fm'

    // ADSR state — drives the master harmony envelope
    this._adsr = { ...ADSR_DEFAULTS };
    this._harmonyActive = false;

    // Hold state — overrides gate, keeps voices alive (sustain pedal / hold button)
    this._hold = false;

    // Build the signal graph
    this.masterGain = audioContext.createGain();
    this.masterGain.gain.setValueAtTime(0.85, audioContext.currentTime);
    this.masterGain.connect(audioContext.destination);

    // Effects chain: wetGain → reverb → delay → masterGain
    this.reverb = new ReverbEffect(audioContext);
    this.delay = new DelayEffect(audioContext);
    this.delay.connect(this.masterGain);
    this.reverb.connect(this.delay.input);

    // Harmony bus (all voice outputs sum here)
    this.harmonyBus = audioContext.createGain();
    this.harmonyBus.gain.setValueAtTime(1.0, audioContext.currentTime);

    // Master ADSR envelope on harmonyBus output
    // This shapes the overall harmony level (attack/release of the harmony blend)
    this.harmonyEnvelope = audioContext.createGain();
    this.harmonyEnvelope.gain.setValueAtTime(0, audioContext.currentTime);

    // Separate wet gain for mix control
    this.wetGain = audioContext.createGain();
    this.wetGain.gain.setValueAtTime(0.8, audioContext.currentTime);
    this.harmonyBus.connect(this.harmonyEnvelope);
    this.harmonyEnvelope.connect(this.wetGain);
    this.wetGain.connect(this.reverb.input); // → reverb → delay → master

    // Dry gain for mic passthrough
    this.dryGain = audioContext.createGain();
    this.dryGain.gain.setValueAtTime(1.0, audioContext.currentTime);
    this.dryGain.connect(this.masterGain);

    // ── Input conditioning (HPF + Gate) — matches VST's butterhp + noise gate ──
    // HPF kills room rumble before it reaches the pitch shifters
    this.inputHPF = audioContext.createBiquadFilter();
    this.inputHPF.type = 'highpass';
    this.inputHPF.frequency.setValueAtTime(80, audioContext.currentTime); // 80Hz default
    this.inputHPF.Q.setValueAtTime(0.707, audioContext.currentTime);     // Butterworth

    // Gate: driven by pitch detector — 0 when silence, 1 when singing
    this.inputGate = audioContext.createGain();
    this.inputGate.gain.setValueAtTime(0, audioContext.currentTime); // starts closed
    this._gateOpen = false;
    this._gateHysteresis = 0.6; // VST: closes at 60% of open threshold

    // Chain: micSource → inputHPF → inputGate → [vocoder voices]
    this.inputHPF.connect(this.inputGate);

    // Mic source node (set after getUserMedia)
    this.micSource = null;
    this._micStream = null;

    // Initialize voices (formant by default — THIRI.ai vocal sound)
    this._buildVoices(maxVoices);
  }

  _buildVoices(count) {
    // Destroy existing voices
    this.voices.forEach(v => v.destroy());
    this.voices = [];

    for (let i = 0; i < count; i++) {
      let voice;
      if (this.voiceType === 'formant' && SynthEngine._workletRegistered && !SynthEngine._workletFailed) {
        // VocoderVoice: pitch-shifted mic audio with formant preservation
        voice = new VocoderVoice(this.ctx, this.micSource, this.harmonyBus, {
          volume: 0.6,
          vowel: 0.0,
        });
      } else if (this.voiceType === 'formant') {
        // Fallback: synthetic formant voice (worklet not available)
        voice = new FormantVoice(this.ctx, this.harmonyBus, {
          volume: 0.6,
          vowel: 0.0,
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
    this._micStream = micStream;
    this.micSource = this.ctx.createMediaStreamSource(micStream);
    this.micSource.connect(this.dryGain);

    // Route mic through HPF + gate for vocoder voices
    // micSource → inputHPF → inputGate → [vocoder voices]
    this.micSource.connect(this.inputHPF);

    // Fan gated audio to all VocoderVoice instances
    this.voices.forEach(v => {
      if (v instanceof VocoderVoice) {
        v.connectMic(this.inputGate); // gated signal, not raw mic
      }
    });

    return this.micSource;
  }

  /**
   * Update harmony voices with new target notes.
   * @param {number[]} midiNotes - target harmony MIDI notes
   * @param {number} [detectedMidi] - the singer's detected MIDI note (for pitch ratio)
   */
  update(midiNotes, detectedMidi) {
    // harmonyEnvelope stays at 1.0 — individual voices handle their own gating.
    if (!this._harmonyActive) {
      this.harmonyEnvelope.gain.setValueAtTime(1.0, this.ctx.currentTime);
      this._harmonyActive = true;
    }

    // GUARD: If the input gate is closed AND hold is not active,
    // don't activate any voices. Gate is the single authority.
    if (!this._gateOpen && !this._hold) {
      this.voices.forEach(v => v.mute());
      return;
    }

    // Update individual voices
    for (let i = 0; i < this.voices.length; i++) {
      if (i < midiNotes.length && midiNotes[i] > 0) {
        if (this.voices[i] instanceof VocoderVoice) {
          this.voices[i].setNote(midiNotes[i], detectedMidi);
        } else {
          this.voices[i].setNote(midiNotes[i]);
        }
      } else {
        this.voices[i].mute();
      }
    }
  }

  muteAll() {
    this.voices.forEach(v => v.mute());
    // Don't touch harmonyEnvelope — voices handle their own release
  }

  setVoiceCount(count) {
    const n = Math.min(Math.max(count, 1), this.maxVoices);
    if (n < this.voices.length) {
      // Shrink: destroy extra voices
      for (let i = n; i < this.voices.length; i++) {
        this.voices[i].destroy();
      }
      this.voices.length = n;
    } else if (n > this.voices.length) {
      // Grow: rebuild all voices to the new count
      this._buildVoices(n);
      if (this.micSource) {
        this.voices.forEach(v => {
          if (v instanceof VocoderVoice) v.connectMic(this.inputGate);
        });
      }
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
    // Reconnect gated mic to new vocoder voices if available
    if (this.micSource) {
      this.voices.forEach(v => {
        if (v instanceof VocoderVoice) {
          v.connectMic(this.inputGate); // gated signal
        }
      });
    }
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

  /** Set vowel/formant position for all vocal voices (0–1: ah→eh→ee→oh→oo) */
  setVowel(pos) {
    this.voices.forEach(v => {
      if (v instanceof FormantVoice || v instanceof VocoderVoice) v.setVowel(pos);
    });
  }

  /** Set breath amount for all formant voices (0–1) */
  setBreath(amount) {
    this.voices.forEach(v => {
      if (v instanceof FormantVoice) v.setBreath(amount);
    });
  }

  // ── Input Conditioning ──

  /**
   * Open/close the input gate — SINGLE AUTHORITY for voice on/off.
   * In Vocal mode: harmonyEnvelope controls release tail length.
   * Hold mode overrides gate close — voices stay alive until hold is released.
   */
  setGateOpen(isOpen) {
    if (isOpen === this._gateOpen) return;
    this._gateOpen = isOpen;
    const now = this.ctx.currentTime;

    if (isOpen) {
      // Open gate: fast attack (4ms)
      this.inputGate.gain.cancelScheduledValues(now);
      this.inputGate.gain.setValueAtTime(this.inputGate.gain.value, now);
      this.inputGate.gain.linearRampToValueAtTime(1.0, now + 0.004);

      // Restore harmonyEnvelope to full (cancel any ongoing release)
      this.harmonyEnvelope.gain.cancelScheduledValues(now);
      this.harmonyEnvelope.gain.setValueAtTime(1.0, now);
      this._harmonyActive = true;
    } else {
      // HOLD override: if hold is active, keep everything alive
      if (this._hold) return;

      // Close input gate: fast (8ms)
      this.inputGate.gain.cancelScheduledValues(now);
      this.inputGate.gain.setValueAtTime(this.inputGate.gain.value, now);
      this.inputGate.gain.linearRampToValueAtTime(0.0, now + 0.008);

      // Vocal mode: use harmonyEnvelope for smooth release tail
      // The release time comes from the ADSR release knob
      if (this.voiceType === 'formant' && this._adsr.release > 0.02) {
        this.harmonyEnvelope.gain.cancelScheduledValues(now);
        this.harmonyEnvelope.gain.setValueAtTime(this.harmonyEnvelope.gain.value, now);
        this.harmonyEnvelope.gain.linearRampToValueAtTime(0, now + this._adsr.release);
        this._harmonyActive = false;
        // Don't mute individual voices — let the envelope handle the fade
      } else {
        // Synth/FM or very short release: hard mute
        this.voices.forEach(v => v.mute());
        this._harmonyActive = false;
      }
    }

    // Propagate gate state to worklets for noise learning + phase reset
    // (only if not held — hold keeps worklets in "open" mode)
    if (!this._hold) {
      this.voices.forEach(v => {
        if (v instanceof VocoderVoice && v.shifterNode) {
          const param = v.shifterNode.parameters.get('gateOpen');
          if (param) param.setValueAtTime(isOpen ? 1 : 0, now);
        }
      });
    }
  }

  /**
   * Set hold mode (sustain pedal). When active, voices stay alive
   * regardless of gate state — like freezing the last harmony.
   */
  setHold(active) {
    this._hold = active;
    if (!active && !this._gateOpen) {
      // Hold released while gate is closed — now execute the deferred close
      const now = this.ctx.currentTime;
      this.inputGate.gain.cancelScheduledValues(now);
      this.inputGate.gain.setValueAtTime(this.inputGate.gain.value, now);
      this.inputGate.gain.linearRampToValueAtTime(0.0, now + 0.008);

      if (this.voiceType === 'formant' && this._adsr.release > 0.02) {
        this.harmonyEnvelope.gain.cancelScheduledValues(now);
        this.harmonyEnvelope.gain.setValueAtTime(this.harmonyEnvelope.gain.value, now);
        this.harmonyEnvelope.gain.linearRampToValueAtTime(0, now + this._adsr.release);
      } else {
        this.voices.forEach(v => v.mute());
      }
      this._harmonyActive = false;

      // Tell worklets gate is closed
      this.voices.forEach(v => {
        if (v instanceof VocoderVoice && v.shifterNode) {
          const param = v.shifterNode.parameters.get('gateOpen');
          if (param) param.setValueAtTime(0, now);
        }
      });
    }
  }

  /** Set high-pass filter frequency (20-500Hz) */
  setHPF(freq) {
    this.inputHPF.frequency.setValueAtTime(
      Math.max(20, Math.min(500, freq)),
      this.ctx.currentTime
    );
  }

  // ── ADSR ──

  /** Set ADSR envelope for Synth/FM voices (VocoderVoice ignores — mic is the envelope) */
  setADSR(attack, decay, sustain, release) {
    this._adsr = { attack, decay, sustain, release };
    this.voices.forEach(v => {
      if (!(v instanceof VocoderVoice)) v.setADSR(attack, decay, sustain, release);
    });
  }

  setAttack(val) { this._adsr.attack = val; this.voices.forEach(v => { if (!(v instanceof VocoderVoice)) v.attackTime = val; }); }
  setDecay(val) { this._adsr.decay = val; this.voices.forEach(v => { if (!(v instanceof VocoderVoice)) v.decayTime = val; }); }
  setSustain(val) { this._adsr.sustain = val; this.voices.forEach(v => { if (!(v instanceof VocoderVoice)) v.sustainLevel = val; }); }
  setRelease(val) { this._adsr.release = val; this.voices.forEach(v => { if (!(v instanceof VocoderVoice)) v.releaseTime = val; }); }

  // ── Effects ──

  setReverbSize(val) { this.reverb.setSize(val); }
  setReverbDamping(val) { this.reverb.setDamping(val); }
  setReverbMix(val) { this.reverb.setMix(val); }

  setDelaySync(type) { this.delay.setSyncType(type); }
  setDelayFeedback(val) { this.delay.setFeedback(val); }
  setDelayMix(val) { this.delay.setMix(val); }
  setDelayBPM(bpm) { this.delay.setBPM(bpm); }

  destroy() {
    this.voices.forEach(v => v.destroy());
    if (this.micSource) this.micSource.disconnect();
    this.inputHPF.disconnect();
    this.inputGate.disconnect();
    this.harmonyBus.disconnect();
    this.harmonyEnvelope.disconnect();
    this.wetGain.disconnect();
    this.reverb.disconnect();
    this.delay.disconnect();
    this.dryGain.disconnect();
    this.masterGain.disconnect();
  }
}
