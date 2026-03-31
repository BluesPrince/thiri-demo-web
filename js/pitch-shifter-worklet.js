/**
 * pitch-shifter-worklet.js — Phase Vocoder Pitch Shifter
 * ========================================================
 * AudioWorkletProcessor matching THIRI VST's Csound pvscale implementation:
 *   pvsanal: FFT 1024, overlap 256, Hann window
 *   pvscale: kkeepform=1 (cepstral formant preservation)
 *   pvsynth: overlap-add resynthesis
 *
 * Parameters:
 *   pitchRatio (k-rate): Frequency multiplier. 1.0 = no shift.
 *
 * Copyright 2026 Blues Prince Media.
 */

// Match Csound VST: ifftsize=1024, ioverlap=256, iwintype=1 (Hann)
const FFT_SIZE = 1024;
const HOP_SIZE = 256;        // 4x overlap
const HALF_FFT = FFT_SIZE / 2 + 1;
const CEPSTRAL_COEFS = 80;  // kcoefs for formant envelope (matches Csound default)

class PitchShifterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: 'pitchRatio',
        defaultValue: 1.0,
        minValue: 0.25,
        maxValue: 4.0,
        automationRate: 'k-rate',
      },
      {
        name: 'gateOpen',
        defaultValue: 0,
        minValue: 0,
        maxValue: 1,
        automationRate: 'k-rate',
      },
    ];
  }

  constructor() {
    super();

    // Input ring buffer (double-length for easy extraction)
    this._inBuf = new Float32Array(FFT_SIZE * 2);
    this._inWritePos = 0;

    // Output ring buffer (overlap-add target)
    this._outBuf = new Float32Array(FFT_SIZE * 2);
    this._outReadPos = 0;

    // Analysis/synthesis buffers
    this._frame = new Float32Array(FFT_SIZE);

    // Phase tracking
    this._lastInputPhase = new Float32Array(HALF_FFT);
    this._phaseAccum = new Float32Array(HALF_FFT);

    // Hann window (precomputed)
    this._window = new Float32Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) {
      this._window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / FFT_SIZE));
    }

    // Expected phase advance per hop for each bin
    this._expPhaseAdv = new Float32Array(HALF_FFT);
    for (let k = 0; k < HALF_FFT; k++) {
      this._expPhaseAdv[k] = 2 * Math.PI * k * HOP_SIZE / FFT_SIZE;
    }

    // Sample counter for hop scheduling
    this._samplesUntilHop = HOP_SIZE;

    // FFT/IFFT work arrays
    this._fftReal = new Float32Array(FFT_SIZE);
    this._fftImag = new Float32Array(FFT_SIZE);
    this._shiftReal = new Float32Array(FFT_SIZE);
    this._shiftImag = new Float32Array(FFT_SIZE);

    // Magnitude arrays for formant preservation
    this._inputMag = new Float32Array(HALF_FFT);
    this._shiftMag = new Float32Array(HALF_FFT);

    // Cepstral work arrays
    this._cepReal = new Float32Array(FFT_SIZE);
    this._cepImag = new Float32Array(FFT_SIZE);

    // Pitch ratio smoothing (portamento ~120ms at 44.1kHz)
    this._smoothedRatio = 1.0;
    this._ratioSmooth = 0.993; // smoothing coefficient per sample

    // Noise floor learning (spectral subtraction)
    this._noiseFloor = new Float32Array(HALF_FFT);  // average noise magnitude per bin
    this._noiseFrameCount = 0;
    this._noiseOversubtract = 1.5; // subtract 150% of noise floor for safety

    // Gate state tracking (for phase reset on close)
    this._prevGateOpen = false;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!input || !output) return true;

    const targetRatio = parameters.pitchRatio[0];
    const gateOpen = parameters.gateOpen[0] > 0.5;
    const blockSize = input.length;

    // Detect gate close transition → reset phase accumulator + flush output
    if (this._prevGateOpen && !gateOpen) {
      this._phaseAccum.fill(0);
      this._outBuf.fill(0);
      this._lastInputPhase.fill(0);
    }
    this._prevGateOpen = gateOpen;

    for (let s = 0; s < blockSize; s++) {
      // Smooth pitch ratio (portamento, matches VST's portk)
      this._smoothedRatio += (targetRatio - this._smoothedRatio) * (1 - this._ratioSmooth);

      // Write input sample into ring buffer
      this._inBuf[this._inWritePos] = input[s];
      this._inBuf[this._inWritePos + FFT_SIZE] = input[s];
      this._inWritePos = (this._inWritePos + 1) % FFT_SIZE;

      // Read output sample from ring buffer
      output[s] = this._outBuf[this._outReadPos];
      this._outBuf[this._outReadPos] = 0;
      this._outReadPos = (this._outReadPos + 1) % (FFT_SIZE * 2);

      this._samplesUntilHop--;
      if (this._samplesUntilHop <= 0) {
        this._samplesUntilHop = HOP_SIZE;
        this._processFrame(this._smoothedRatio, gateOpen);
      }
    }

    return true;
  }

  _processFrame(pitchRatio, gateOpen) {
    // Extract frame from ring buffer
    const start = (this._inWritePos - FFT_SIZE + FFT_SIZE * 2) % FFT_SIZE;
    for (let i = 0; i < FFT_SIZE; i++) {
      this._frame[i] = this._inBuf[start + i];
    }

    // Apply analysis window (Hann)
    for (let i = 0; i < FFT_SIZE; i++) {
      this._fftReal[i] = this._frame[i] * this._window[i];
      this._fftImag[i] = 0;
    }

    // FFT
    this._fft(this._fftReal, this._fftImag, FFT_SIZE);

    // Extract input magnitudes
    for (let k = 0; k < HALF_FFT; k++) {
      this._inputMag[k] = Math.sqrt(
        this._fftReal[k] * this._fftReal[k] +
        this._fftImag[k] * this._fftImag[k]
      );
    }

    // ── Noise floor learning + spectral subtraction ──
    if (!gateOpen) {
      // Gate closed (silence): learn the room's noise floor
      this._noiseFrameCount++;
      const alpha = 1 / this._noiseFrameCount;
      for (let k = 0; k < HALF_FFT; k++) {
        // Running average of noise magnitude per bin
        this._noiseFloor[k] += (this._inputMag[k] - this._noiseFloor[k]) * alpha;
      }
      // Don't process further — output silence
      return;
    }

    // Gate open (singing): subtract noise floor from magnitudes
    if (this._noiseFrameCount > 0) {
      for (let k = 0; k < HALF_FFT; k++) {
        const clean = this._inputMag[k] - this._noiseFloor[k] * this._noiseOversubtract;
        if (clean <= 0) {
          // Below noise floor — zero this bin entirely
          this._inputMag[k] = 0;
          this._fftReal[k] = 0;
          this._fftImag[k] = 0;
        } else {
          // Scale the complex FFT values to match the cleaned magnitude
          const scale = clean / this._inputMag[k];
          this._inputMag[k] = clean;
          this._fftReal[k] *= scale;
          this._fftImag[k] *= scale;
        }
      }
    }

    // ── Compute spectral envelope via cepstral method (kkeepform=1) ──
    const inputEnvelope = this._computeSpectralEnvelope(this._inputMag);

    // ── Phase vocoder bin shifting ──
    this._shiftReal.fill(0);
    this._shiftImag.fill(0);
    this._shiftMag.fill(0);

    for (let k = 0; k < HALF_FFT; k++) {
      const mag = this._inputMag[k];
      const phase = Math.atan2(this._fftImag[k], this._fftReal[k]);

      // Phase difference from last frame
      let phaseDiff = phase - this._lastInputPhase[k];
      this._lastInputPhase[k] = phase;

      // Remove expected phase advance, wrap to [-pi, pi]
      phaseDiff -= this._expPhaseAdv[k];
      phaseDiff -= 2 * Math.PI * Math.round(phaseDiff / (2 * Math.PI));

      // True frequency (in radians per hop)
      const trueFreq = this._expPhaseAdv[k] + phaseDiff;

      // Target bin after shifting
      const targetBin = k * pitchRatio;
      const targetBinInt = Math.round(targetBin);

      if (targetBinInt >= 0 && targetBinInt < HALF_FFT) {
        // Accumulate phase at the shifted rate
        this._phaseAccum[targetBinInt] += trueFreq * pitchRatio;

        // Accumulate magnitude (handle multiple bins mapping to same target)
        this._shiftMag[targetBinInt] += mag;

        const outPhase = this._phaseAccum[targetBinInt];
        this._shiftReal[targetBinInt] += mag * Math.cos(outPhase);
        this._shiftImag[targetBinInt] += mag * Math.sin(outPhase);
      }
    }

    // ── Formant preservation: restore original spectral envelope ──
    // Compute the shifted signal's envelope
    const shiftedEnvelope = this._computeSpectralEnvelope(this._shiftMag);

    for (let k = 0; k < HALF_FFT; k++) {
      if (shiftedEnvelope[k] > 1e-10) {
        // Scale: remove shifted envelope, apply original envelope
        // This keeps "ah" sounding like "ah" regardless of pitch shift
        const correction = inputEnvelope[k] / shiftedEnvelope[k];
        // Gentle correction — don't let it amplify noise too much
        const clampedCorrection = Math.min(correction, 4.0);
        this._shiftReal[k] *= clampedCorrection;
        this._shiftImag[k] *= clampedCorrection;
      }
    }

    // Mirror for negative frequencies
    for (let k = 1; k < HALF_FFT - 1; k++) {
      this._shiftReal[FFT_SIZE - k] = this._shiftReal[k];
      this._shiftImag[FFT_SIZE - k] = -this._shiftImag[k];
    }

    // IFFT
    this._ifft(this._shiftReal, this._shiftImag, FFT_SIZE);

    // Apply synthesis window and overlap-add into output buffer
    const outStart = this._outReadPos;
    for (let i = 0; i < FFT_SIZE; i++) {
      const idx = (outStart + i) % (FFT_SIZE * 2);
      this._outBuf[idx] += this._shiftReal[i] * this._window[i] * (2 / 3);
    }
  }

  /**
   * Compute spectral envelope via cepstral liftering.
   * Matches Csound's kkeepform=1 approach:
   *   1. Log magnitude spectrum
   *   2. IFFT → cepstrum
   *   3. Lifter: zero out high quefrency components
   *   4. FFT → smooth spectral envelope
   */
  _computeSpectralEnvelope(magnitudes) {
    const envelope = new Float32Array(HALF_FFT);

    // Log magnitude spectrum
    for (let k = 0; k < HALF_FFT; k++) {
      this._cepReal[k] = Math.log(Math.max(magnitudes[k], 1e-10));
      this._cepImag[k] = 0;
    }
    // Mirror for full spectrum
    for (let k = HALF_FFT; k < FFT_SIZE; k++) {
      this._cepReal[k] = this._cepReal[FFT_SIZE - k] || 0;
      this._cepImag[k] = 0;
    }

    // IFFT → cepstrum
    this._ifft(this._cepReal, this._cepImag, FFT_SIZE);

    // Lifter: keep only first CEPSTRAL_COEFS quefrency components
    // This gives a smooth spectral envelope (formant shape)
    for (let i = CEPSTRAL_COEFS; i < FFT_SIZE - CEPSTRAL_COEFS; i++) {
      this._cepReal[i] = 0;
      this._cepImag[i] = 0;
    }

    // FFT → smooth log envelope
    this._fft(this._cepReal, this._cepImag, FFT_SIZE);

    // Exp to get back to linear magnitude
    for (let k = 0; k < HALF_FFT; k++) {
      envelope[k] = Math.exp(this._cepReal[k]);
    }

    return envelope;
  }

  // ── Radix-2 Cooley-Tukey FFT ──────────────────────────────────────

  _fft(real, imag, n) {
    // Bit-reversal permutation
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) {
        j ^= bit;
      }
      j ^= bit;
      if (i < j) {
        [real[i], real[j]] = [real[j], real[i]];
        [imag[i], imag[j]] = [imag[j], imag[i]];
      }
    }

    // Butterfly stages
    for (let len = 2; len <= n; len <<= 1) {
      const halfLen = len >> 1;
      const angle = -2 * Math.PI / len;
      const wReal = Math.cos(angle);
      const wImag = Math.sin(angle);

      for (let i = 0; i < n; i += len) {
        let curReal = 1, curImag = 0;
        for (let j = 0; j < halfLen; j++) {
          const uR = real[i + j];
          const uI = imag[i + j];
          const vR = real[i + j + halfLen] * curReal - imag[i + j + halfLen] * curImag;
          const vI = real[i + j + halfLen] * curImag + imag[i + j + halfLen] * curReal;

          real[i + j] = uR + vR;
          imag[i + j] = uI + vI;
          real[i + j + halfLen] = uR - vR;
          imag[i + j + halfLen] = uI - vI;

          const tmpR = curReal * wReal - curImag * wImag;
          curImag = curReal * wImag + curImag * wReal;
          curReal = tmpR;
        }
      }
    }
  }

  _ifft(real, imag, n) {
    for (let i = 0; i < n; i++) imag[i] = -imag[i];
    this._fft(real, imag, n);
    for (let i = 0; i < n; i++) {
      real[i] /= n;
      imag[i] = -imag[i] / n;
    }
  }
}

registerProcessor('pitch-shifter-processor', PitchShifterProcessor);
