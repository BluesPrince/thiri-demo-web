/**
 * pitch.js — Real-Time Pitch Detection
 * ======================================
 * YIN autocorrelation algorithm for monophonic pitch detection.
 * Operates on Web Audio API AnalyserNode float time-domain data.
 *
 * Returns: { frequency, midi, noteName, octave, centsOff, confidence }
 *
 * Copyright 2026 Blues Prince Media. PATENT PENDING.
 */

import { freqToMidi, midiToNoteName, midiToOctave, NOTE_NAMES } from './scales.js';

// ═══════════════════════════════════════════════════════════════════════════════
// YIN PITCH DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * YIN algorithm for fundamental frequency detection.
 * Reference: De Cheveigné & Kawahara (2002)
 *
 * @param {Float32Array} buffer - Time-domain audio samples
 * @param {number} sampleRate - Audio sample rate (e.g., 44100)
 * @param {number} threshold - Confidence threshold (0.0–1.0, lower = stricter). Default 0.15
 * @returns {{ frequency: number, confidence: number }} or null if no pitch detected
 */
export function detectPitchYIN(buffer, sampleRate, threshold = 0.15) {
  const halfLen = Math.floor(buffer.length / 2);
  const yinBuffer = new Float32Array(halfLen);

  // Step 1: Difference function
  for (let tau = 0; tau < halfLen; tau++) {
    let sum = 0;
    for (let i = 0; i < halfLen; i++) {
      const delta = buffer[i] - buffer[i + tau];
      sum += delta * delta;
    }
    yinBuffer[tau] = sum;
  }

  // Step 2: Cumulative mean normalized difference function (CMND)
  yinBuffer[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau < halfLen; tau++) {
    runningSum += yinBuffer[tau];
    yinBuffer[tau] = yinBuffer[tau] * tau / runningSum;
  }

  // Step 3: Absolute threshold
  // Find the first tau where CMND drops below threshold
  let tauEstimate = -1;
  for (let tau = 2; tau < halfLen; tau++) {
    if (yinBuffer[tau] < threshold) {
      // Find the local minimum after this point
      while (tau + 1 < halfLen && yinBuffer[tau + 1] < yinBuffer[tau]) {
        tau++;
      }
      tauEstimate = tau;
      break;
    }
  }

  // No pitch found
  if (tauEstimate === -1) {
    return null;
  }

  // Step 4: Parabolic interpolation for sub-sample accuracy
  const t = tauEstimate;
  let betterTau;
  if (t > 0 && t < halfLen - 1) {
    const s0 = yinBuffer[t - 1];
    const s1 = yinBuffer[t];
    const s2 = yinBuffer[t + 1];
    const adjustment = (s2 - s0) / (2 * (2 * s1 - s0 - s2));
    betterTau = t + adjustment;
  } else {
    betterTau = t;
  }

  const confidence = 1 - yinBuffer[t]; // Invert so higher = better
  const frequency = sampleRate / betterTau;

  // Sanity check: reject frequencies outside human vocal range (50Hz–2000Hz)
  if (frequency < 50 || frequency > 2000) {
    return null;
  }

  return { frequency, confidence };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PITCH INFO BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build a full pitch info object from a detected frequency.
 *
 * @param {number} frequency - Detected frequency in Hz
 * @returns {{ frequency, midi, midiExact, noteName, octave, centsOff }}
 */
export function buildPitchInfo(frequency) {
  const midiExact = freqToMidi(frequency);
  const midi = Math.round(midiExact);
  const centsOff = Math.round((midiExact - midi) * 100);
  const noteIndex = ((midi % 12) + 12) % 12;
  const noteName = NOTE_NAMES[noteIndex];
  const octave = midiToOctave(midi);

  return {
    frequency: Math.round(frequency * 10) / 10,
    midi,
    midiExact,
    noteName,
    octave,
    centsOff,  // negative = flat, positive = sharp
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PITCH DETECTOR CLASS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Manages continuous pitch detection from an AnalyserNode.
 *
 * Usage:
 *   const detector = new PitchDetector(analyserNode, audioContext.sampleRate);
 *   detector.start((pitchInfo) => { console.log(pitchInfo); });
 *   detector.stop();
 */
export class PitchDetector {
  constructor(analyserNode, sampleRate, options = {}) {
    this.analyser = analyserNode;
    this.sampleRate = sampleRate;
    this.threshold = options.threshold ?? 0.15;
    this.smoothingFactor = options.smoothingFactor ?? 0.7;
    this.minConfidence = options.minConfidence ?? 0.8;

    // Allocate the time-domain buffer once
    this.buffer = new Float32Array(analyserNode.fftSize);

    this._running = false;
    this._rafId = null;
    this._callback = null;
    this._lastPitch = null;
    this._smoothedFreq = 0;

    // Pitch drift preservation: separate center pitch from vibrato/expression
    this._centerFreq = 0;       // slowly-tracking "intended" pitch
    this._rawFreq = 0;          // fast-tracking actual pitch (includes vibrato)
    this._centerSmoothing = 0.92; // very slow tracking for center pitch
    this._driftCents = 0;       // vibrato/expression offset from center

    // Noise gate: track RMS to reject silence
    this._rmsThreshold = options.rmsThreshold ?? 0.01;
  }

  /**
   * Start continuous pitch detection.
   * @param {Function} callback - Called with pitchInfo on each detection, or null if no pitch
   */
  start(callback) {
    this._callback = callback;
    this._running = true;
    this._loop();
  }

  stop() {
    this._running = false;
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  _loop() {
    if (!this._running) return;

    this.analyser.getFloatTimeDomainData(this.buffer);

    // Noise gate: compute RMS
    let sumSq = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      sumSq += this.buffer[i] * this.buffer[i];
    }
    const rms = Math.sqrt(sumSq / this.buffer.length);

    if (rms < this._rmsThreshold) {
      // Silence — no pitch
      this._lastPitch = null;
      this._smoothedFreq = 0;
      if (this._callback) this._callback(null);
    } else {
      const result = detectPitchYIN(this.buffer, this.sampleRate, this.threshold);

      if (result && result.confidence >= this.minConfidence) {
        // Smooth the frequency to reduce jitter
        if (this._smoothedFreq > 0) {
          this._smoothedFreq =
            this._smoothedFreq * this.smoothingFactor +
            result.frequency * (1 - this.smoothingFactor);
        } else {
          this._smoothedFreq = result.frequency;
        }

        // Track center pitch separately (very slow) to preserve vibrato/drift
        this._rawFreq = result.frequency;
        if (this._centerFreq > 0) {
          this._centerFreq =
            this._centerFreq * this._centerSmoothing +
            result.frequency * (1 - this._centerSmoothing);
        } else {
          this._centerFreq = result.frequency;
        }
        // Drift = how far the raw pitch is from the slowly-tracked center (in cents)
        this._driftCents = 1200 * Math.log2(this._rawFreq / this._centerFreq);

        const pitchInfo = buildPitchInfo(this._smoothedFreq);
        pitchInfo.confidence = result.confidence;
        pitchInfo.rms = rms;
        pitchInfo.driftCents = this._driftCents;   // vibrato/expression offset
        pitchInfo.centerFreq = this._centerFreq;   // "intended" pitch center
        this._lastPitch = pitchInfo;
        if (this._callback) this._callback(pitchInfo);
      } else {
        // Low confidence — hold previous or report null
        if (this._callback) this._callback(this._lastPitch);
      }
    }

    this._rafId = requestAnimationFrame(() => this._loop());
  }

  /** Get the most recent pitch info */
  get currentPitch() {
    return this._lastPitch;
  }
}
