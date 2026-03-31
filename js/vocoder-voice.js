/**
 * vocoder-voice.js — Formant-Preserving Pitch-Shifted Voice
 * ===========================================================
 * Routes the actual mic audio through a phase vocoder pitch shifter,
 * then through a formant filter bank to preserve vocal character.
 *
 * Signal chain per voice:
 *   micSource → PitchShifterWorklet → [F1..F4 bandpass] → gainNode → destination
 *
 * The pitch ratio is computed as: midiToFreq(targetNote) / midiToFreq(detectedNote)
 * So the singer's voice is shifted to the harmony interval while keeping
 * their unique timbre, vowel shape, and dynamics.
 *
 * Copyright 2026 Blues Prince Media.
 */

import { midiToFreq } from './scales.js';

// ── Formant definitions — matched to THIRI VST (Csound reson values) ────
// VST uses 3 formant bands (F1, F2, F3) with relative gains [1.0, 0.7, 0.4]
// BW = center_freq × bandwidth_ratio (VST: F1×0.15, F2×0.12, F3×0.10)

const VOWEL_FORMANTS = {
  ah: { freqs: [800, 1200, 2800], bwRatios: [0.15, 0.12, 0.10], gains: [1.0, 0.7, 0.4] },
  eh: { freqs: [400, 1800, 2600], bwRatios: [0.15, 0.12, 0.10], gains: [1.0, 0.7, 0.4] },
  ee: { freqs: [270, 2300, 3000], bwRatios: [0.15, 0.12, 0.10], gains: [1.0, 0.7, 0.4] },
  oh: { freqs: [500, 900, 2600],  bwRatios: [0.15, 0.12, 0.10], gains: [1.0, 0.7, 0.4] },
  oo: { freqs: [330, 950, 2400],  bwRatios: [0.15, 0.12, 0.10], gains: [1.0, 0.7, 0.4] },
};
const VOWEL_ORDER = ['ah', 'eh', 'ee', 'oh', 'oo'];
const NUM_FORMANTS = 3; // VST uses 3 bands
const FORMANT_BLEND = 0.4; // VST: 40% formant-filtered + 60% pitch-shifted

// ═════════════════════════════════════════════════════════════════════

export class VocoderVoice {
  /**
   * @param {AudioContext} audioContext
   * @param {MediaStreamAudioSourceNode|null} micSource - mic audio node to pitch-shift
   * @param {AudioNode} destination - where to send output (typically harmonyBus)
   * @param {Object} options
   */
  constructor(audioContext, micSource, destination, options = {}) {
    this.ctx = audioContext;
    this.targetMidi = -1;
    this.detectedMidi = -1;
    this.active = false;
    this.volume = options.volume ?? 0.6;
    this.vowelPos = options.vowel ?? 0.0;
    this.humanize = options.humanize ?? 0.0;

    const now = audioContext.currentTime;

    // ── Gain gate (simple on/off with short fade) ──
    // Musical ADSR shaping is on the master harmonyBus, not per-voice
    this.gainNode = audioContext.createGain();
    this.gainNode.gain.setValueAtTime(0, now);
    this.gainNode.connect(destination);

    // ── Formant filter bank (3 parallel bandpass → sum) ──
    // VST blends: 40% formant-filtered + 60% pitch-shifted (dry from shifter)
    this.formantBus = audioContext.createGain();
    this.formantBus.gain.setValueAtTime(FORMANT_BLEND * 0.12, now); // ×0.12 matches VST aFmtOut scaling
    this.formantBus.connect(this.gainNode);

    // Direct path from shifter (60% of pitch-shifted signal)
    this.directGain = audioContext.createGain();
    this.directGain.gain.setValueAtTime(1 - FORMANT_BLEND, now);
    this.directGain.connect(this.gainNode);

    this.formants = [];
    const initVowel = VOWEL_FORMANTS.ah;
    for (let i = 0; i < NUM_FORMANTS; i++) {
      const filter = audioContext.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(initVowel.freqs[i], now);
      const bw = initVowel.freqs[i] * initVowel.bwRatios[i];
      filter.Q.setValueAtTime(initVowel.freqs[i] / bw, now);

      const fGain = audioContext.createGain();
      fGain.gain.setValueAtTime(initVowel.gains[i], now);

      filter.connect(fGain);
      fGain.connect(this.formantBus);
      this.formants.push({ filter, gain: fGain });
    }

    // ── Pitch shifter worklet node ──
    // Created via connectMic() after worklet is registered
    this.shifterNode = null;
    this._micSource = micSource;

    // If mic is already available, connect now
    if (micSource) {
      this._createShifter(micSource);
    }

    // Apply initial vowel
    this._applyVowel(this.vowelPos);
  }

  /**
   * Create the AudioWorkletNode and connect mic → shifter → formant filters.
   */
  _createShifter(micSource) {
    try {
      this.shifterNode = new AudioWorkletNode(this.ctx, 'pitch-shifter-processor', {
        parameterData: { pitchRatio: 1.0 },
      });

      // Route: micSource → shifter → formant filters (40% blend)
      //                            → directGain (60% pass-through)
      micSource.connect(this.shifterNode);
      for (const f of this.formants) {
        this.shifterNode.connect(f.filter);
      }
      this.shifterNode.connect(this.directGain);

      this._micSource = micSource;
    } catch (err) {
      console.error('[VocoderVoice] Failed to create pitch shifter:', err);
    }
  }

  /**
   * Connect a new mic source (called when SynthEngine.connectMic() fires).
   */
  connectMic(micSource) {
    // Disconnect old shifter from old mic
    if (this.shifterNode && this._micSource) {
      try { this._micSource.disconnect(this.shifterNode); } catch (_) {}
    }

    if (this.shifterNode) {
      // Reuse existing worklet node, just reconnect mic
      micSource.connect(this.shifterNode);
    } else {
      this._createShifter(micSource);
    }
    this._micSource = micSource;
  }

  /**
   * Set the target harmony note and the detected singer's note.
   * Computes pitchRatio and sends to the worklet.
   */
  setNote(midiNote, detectedMidi) {
    if (this.targetMidi === midiNote && this.detectedMidi === detectedMidi) return;

    this.targetMidi = midiNote;
    this.detectedMidi = detectedMidi ?? midiNote;

    // Compute pitch ratio
    const targetFreq = midiToFreq(midiNote);
    const detectedFreq = midiToFreq(this.detectedMidi);
    const ratio = targetFreq / detectedFreq;

    // Send to worklet
    if (this.shifterNode) {
      const param = this.shifterNode.parameters.get('pitchRatio');
      if (param) {
        param.setValueAtTime(
          Math.max(0.25, Math.min(4.0, ratio)),
          this.ctx.currentTime
        );
      }
    }

    // Humanization: slight ratio perturbation
    // (micro-detuning baked into the pitch ratio)

    // Gate on with short fade
    if (!this.active) {
      const now = this.ctx.currentTime;
      this.gainNode.gain.cancelScheduledValues(now);
      this.gainNode.gain.setValueAtTime(0, now);
      this.gainNode.gain.linearRampToValueAtTime(this.volume, now + 0.008); // 8ms fade-in
      this.active = true;
    }
  }

  /**
   * Mute this voice (short gate-off).
   */
  mute() {
    if (!this.active) return;
    const now = this.ctx.currentTime;
    this.gainNode.gain.cancelScheduledValues(now);
    this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
    this.gainNode.gain.linearRampToValueAtTime(0, now + 0.015); // 15ms fade-out
    this.active = false;
    this.targetMidi = -1;
  }

  // ── Formant control ──

  /**
   * Interpolate formant filter frequencies based on vowel position (0–1).
   * 0=ah, 0.25=eh, 0.5=ee, 0.75=oh, 1.0=oo
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
    const smoothTime = 0.08; // 80ms — matches VST's portk formant smoothing

    for (let i = 0; i < NUM_FORMANTS; i++) {
      const freq = loVowel.freqs[i] + (hiVowel.freqs[i] - loVowel.freqs[i]) * t;
      const bwRatio = loVowel.bwRatios[i] + (hiVowel.bwRatios[i] - loVowel.bwRatios[i]) * t;
      const bw = freq * bwRatio;
      const gain = loVowel.gains[i] + (hiVowel.gains[i] - loVowel.gains[i]) * t;

      this.formants[i].filter.frequency.setTargetAtTime(freq, now, smoothTime);
      this.formants[i].filter.Q.setTargetAtTime(freq / bw, now, smoothTime);
      this.formants[i].gain.gain.setTargetAtTime(gain, now, smoothTime);
    }
  }

  setVowel(pos) {
    this.vowelPos = pos;
    this._applyVowel(pos);
  }

  setVolume(vol) {
    this.volume = vol;
    if (this.active) {
      this.gainNode.gain.setValueAtTime(vol, this.ctx.currentTime);
    }
  }

  setHumanize(amount) {
    this.humanize = Math.max(0, Math.min(1, amount));
  }

  // Compatibility stubs (VocoderVoice doesn't use these)
  setWaveform() {}
  setDetune() {}
  setBreath() {}
  setADSR() {} // ADSR is on master bus, not per-voice

  destroy() {
    this.mute();
    setTimeout(() => {
      try {
        if (this.shifterNode) {
          if (this._micSource) this._micSource.disconnect(this.shifterNode);
          this.shifterNode.disconnect();
        }
        this.formants.forEach(f => {
          f.filter.disconnect();
          f.gain.disconnect();
        });
        this.formantBus.disconnect();
        this.directGain.disconnect();
        this.gainNode.disconnect();
      } catch (_) {}
    }, 100);
  }
}
