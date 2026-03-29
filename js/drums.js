/**
 * drums.js — Synthesized Drum Loop Engine for THIRI.ai
 * =====================================================
 * Four Ableton-style loop slots with beat-quantized switching.
 * Each slot contains a step-sequenced drum pattern using
 * synthesized percussion (no audio file dependencies).
 *
 * Architecture:
 *   StepScheduler (tempo) → triggers hits at beat boundaries
 *   4 slots, each with a pattern definition
 *   Click active slot → stop. Click new slot → crossfade at next beat.
 *
 * Percussion synthesis:
 *   Kick:  sine burst 150→50 Hz, fast decay
 *   Snare: noise burst + sine 200 Hz, bandpass filtered
 *   HiHat: noise burst, highpass 7kHz, very short decay
 *   Rim:   sine ping 800 Hz, ultrashort
 *
 * Copyright 2026 Blues Prince Media. PATENT PENDING.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// PERCUSSION SYNTHESIZER
// ═══════════════════════════════════════════════════════════════════════════════

function playKick(ctx, dest, time, velocity = 1.0) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(150, time);
  osc.frequency.exponentialRampToValueAtTime(50, time + 0.07);
  gain.gain.setValueAtTime(0.8 * velocity, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.3);
  osc.connect(gain);
  gain.connect(dest);
  osc.start(time);
  osc.stop(time + 0.35);
}

function playSnare(ctx, dest, time, velocity = 1.0) {
  // Noise component
  const bufSize = ctx.sampleRate * 0.15;
  const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource();
  noise.buffer = buf;
  const nFilter = ctx.createBiquadFilter();
  nFilter.type = 'bandpass';
  nFilter.frequency.value = 3000;
  nFilter.Q.value = 1.2;
  const nGain = ctx.createGain();
  nGain.gain.setValueAtTime(0.5 * velocity, time);
  nGain.gain.exponentialRampToValueAtTime(0.001, time + 0.12);
  noise.connect(nFilter);
  nFilter.connect(nGain);
  nGain.connect(dest);
  noise.start(time);

  // Body component
  const osc = ctx.createOscillator();
  const oGain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(200, time);
  osc.frequency.exponentialRampToValueAtTime(120, time + 0.04);
  oGain.gain.setValueAtTime(0.5 * velocity, time);
  oGain.gain.exponentialRampToValueAtTime(0.001, time + 0.08);
  osc.connect(oGain);
  oGain.connect(dest);
  osc.start(time);
  osc.stop(time + 0.15);
}

function playHiHat(ctx, dest, time, velocity = 0.5, open = false) {
  const bufSize = ctx.sampleRate * (open ? 0.2 : 0.05);
  const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource();
  noise.buffer = buf;
  const filter = ctx.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = 7000;
  const gain = ctx.createGain();
  const decay = open ? 0.18 : 0.04;
  gain.gain.setValueAtTime(0.3 * velocity, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + decay);
  noise.connect(filter);
  filter.connect(gain);
  gain.connect(dest);
  noise.start(time);
}

function playRim(ctx, dest, time, velocity = 0.6) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(800, time);
  gain.gain.setValueAtTime(0.35 * velocity, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.03);
  osc.connect(gain);
  gain.connect(dest);
  osc.start(time);
  osc.stop(time + 0.05);
}

// ═══════════════════════════════════════════════════════════════════════════════
// DRUM PATTERNS (16-step, 16th notes)
// ═══════════════════════════════════════════════════════════════════════════════
// Each step: { k: kick, s: snare, h: hat, r: rim, oh: open hat }
// Value = velocity (0 = rest, 0.1–1.0 = velocity)

const DRUM_PATTERNS = {
  straight: {
    name: 'Straight',
    steps: [
      { k: 1.0, h: 0.5 },  // 1
      { h: 0.3 },            // e
      { h: 0.5 },            // &
      { h: 0.3 },            // a
      { s: 1.0, h: 0.5 },   // 2
      { h: 0.3 },
      { h: 0.5 },
      { h: 0.3 },
      { k: 1.0, h: 0.5 },   // 3
      { h: 0.3 },
      { h: 0.5 },
      { k: 0.6, h: 0.3 },   // ghost kick
      { s: 1.0, h: 0.5 },   // 4
      { h: 0.3 },
      { h: 0.5 },
      { h: 0.4 },
    ],
  },

  swing: {
    name: 'Swing',
    steps: [
      { k: 1.0, r: 0.4 },   // 1
      {},
      { h: 0.3 },            // swung &
      {},
      { h: 0.5 },            // 2
      {},
      { s: 0.4, h: 0.3 },   // ghost snare
      {},
      { k: 0.7, h: 0.5 },   // 3
      {},
      { h: 0.3 },
      {},
      { s: 1.0, h: 0.5 },   // 4
      {},
      { h: 0.3 },
      { k: 0.5 },            // pickup
    ],
  },

  latin: {
    name: 'Latin',
    steps: [
      { k: 1.0, r: 0.6 },   // 1 (clave hit 1)
      { h: 0.3 },
      { h: 0.4 },
      { r: 0.5 },            // clave hit 2
      { h: 0.4 },
      { h: 0.3 },
      { k: 0.7, r: 0.6 },   // clave hit 3
      { h: 0.3 },
      { h: 0.4 },
      { h: 0.3 },
      { r: 0.5 },            // clave hit 4
      { h: 0.3 },
      { k: 0.8, h: 0.4 },
      { r: 0.5 },            // clave hit 5
      { h: 0.3 },
      { h: 0.4 },
    ],
  },

  ballad: {
    name: 'Ballad',
    steps: [
      { k: 0.8, h: 0.2 },   // 1 (soft brush)
      {},
      { h: 0.15 },
      {},
      { h: 0.3 },            // 2
      {},
      { s: 0.3 },            // soft snare
      {},
      { k: 0.5, h: 0.2 },   // 3
      {},
      { h: 0.15 },
      {},
      { h: 0.3 },            // 4
      {},
      { s: 0.25 },           // ghost
      { h: 0.15 },
    ],
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// DRUM LOOP ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

export class DrumLoopEngine {
  constructor(audioContext) {
    this.ctx = audioContext;
    this.bpm = 120;
    this.playing = false;
    this.activeSlot = -1;
    this._schedulerTimer = null;
    this._nextStepTime = 0;
    this._currentStep = 0;
    this._lookahead = 0.05;   // schedule 50ms ahead
    this._scheduleInterval = 25; // check every 25ms
    this.volume = 0.7;

    // Output bus
    this.outputGain = audioContext.createGain();
    this.outputGain.gain.setValueAtTime(this.volume, audioContext.currentTime);

    // Slot definitions (keys into DRUM_PATTERNS)
    this.slots = ['straight', 'swing', 'latin', 'ballad'];

    // Callbacks
    this.onStepChange = null;  // (step, slotIndex) => void
  }

  /** Connect output to a destination node */
  connect(destination) {
    this.outputGain.connect(destination);
  }

  /** Disconnect output */
  disconnect() {
    this.outputGain.disconnect();
  }

  /** Get the step duration in seconds for current BPM */
  _stepDuration() {
    // 16 steps per bar = 4 beats, each step = 1/4 beat
    return (60 / this.bpm) / 4;
  }

  /** Trigger a slot. If already playing, switch at beat boundary. */
  trigger(slotIndex) {
    if (slotIndex < 0 || slotIndex >= this.slots.length) return;

    // If this slot is already active, stop
    if (this.activeSlot === slotIndex && this.playing) {
      this.stop();
      return;
    }

    this.activeSlot = slotIndex;

    if (!this.playing) {
      this._startPlayback();
    }
    // If already playing, the scheduler will pick up the new slot automatically
  }

  _startPlayback() {
    this.playing = true;
    this._currentStep = 0;
    this._nextStepTime = this.ctx.currentTime + 0.01; // small offset

    this._schedulerTimer = setInterval(() => {
      this._schedule();
    }, this._scheduleInterval);
  }

  _schedule() {
    while (this._nextStepTime < this.ctx.currentTime + this._lookahead) {
      this._playStep(this._nextStepTime);
      this._nextStepTime += this._stepDuration();
      this._currentStep = (this._currentStep + 1) % 16;
    }
  }

  _playStep(time) {
    if (this.activeSlot < 0) return;
    const patternKey = this.slots[this.activeSlot];
    const pattern = DRUM_PATTERNS[patternKey];
    if (!pattern) return;

    const step = pattern.steps[this._currentStep];
    if (!step) return;

    if (step.k)  playKick(this.ctx, this.outputGain, time, step.k);
    if (step.s)  playSnare(this.ctx, this.outputGain, time, step.s);
    if (step.h)  playHiHat(this.ctx, this.outputGain, time, step.h, false);
    if (step.oh) playHiHat(this.ctx, this.outputGain, time, step.oh, true);
    if (step.r)  playRim(this.ctx, this.outputGain, time, step.r);

    // Callback for UI highlighting
    if (this.onStepChange) {
      this.onStepChange(this._currentStep, this.activeSlot);
    }
  }

  stop() {
    this.playing = false;
    this.activeSlot = -1;
    if (this._schedulerTimer) {
      clearInterval(this._schedulerTimer);
      this._schedulerTimer = null;
    }
    if (this.onStepChange) {
      this.onStepChange(-1, -1);
    }
  }

  setBPM(bpm) {
    this.bpm = Math.max(40, Math.min(300, bpm));
  }

  setVolume(vol) {
    this.volume = Math.max(0, Math.min(1, vol));
    this.outputGain.gain.setValueAtTime(this.volume, this.ctx.currentTime);
  }

  /** Get pattern info for all slots (for UI rendering) */
  getSlotInfo() {
    return this.slots.map((key, i) => ({
      index: i,
      key,
      name: DRUM_PATTERNS[key]?.name || key,
      active: i === this.activeSlot && this.playing,
    }));
  }

  destroy() {
    this.stop();
    this.outputGain.disconnect();
  }
}
