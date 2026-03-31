/**
 * arp.js — Arpeggiator Engine for THIRI.ai
 * ==========================================
 * Cycles through harmony notes in a tempo-sync'd pattern.
 *
 * Modes:
 *   - sync:  Quantized to beat subdivisions (1/8 notes)
 *   - beat:  One note per beat (quarter notes)
 *   - rt:    Real-time retrigger (fast 1/16 notes)
 *
 * Copyright 2026 Blues Prince Media.
 */

export class Arpeggiator {
  constructor() {
    this._mode = 'off';    // 'off' | 'sync' | 'beat' | 'rt'
    this._bpm = 120;
    this._notes = [];       // current harmony notes to arpeggiate
    this._stepIndex = 0;
    this._timer = null;
    this._onNote = null;    // callback: (midiNote) => void
  }

  /**
   * Set the arp mode and start/stop accordingly.
   * @param {'off'|'sync'|'beat'|'rt'} mode
   */
  setMode(mode) {
    this._mode = mode;
    if (mode === 'off') {
      this.stop();
    } else {
      this._restart();
    }
  }

  getMode() {
    return this._mode;
  }

  setBPM(bpm) {
    this._bpm = Math.max(20, Math.min(300, bpm));
    if (this._mode !== 'off' && this._timer) {
      this._restart();
    }
  }

  /**
   * Update the note pool the arpeggiator cycles through.
   */
  setNotes(notes) {
    this._notes = notes.filter(n => n > 0);
  }

  /**
   * Register a callback fired on each arp step.
   * Callback receives an array with a single MIDI note.
   */
  onNote(callback) {
    this._onNote = callback;
  }

  _getIntervalMs() {
    const beatMs = (60 / this._bpm) * 1000;
    switch (this._mode) {
      case 'beat': return beatMs;           // quarter notes
      case 'sync': return beatMs / 2;       // eighth notes
      case 'rt':   return beatMs / 4;       // sixteenth notes
      default:     return beatMs;
    }
  }

  _restart() {
    this.stop();
    if (this._mode === 'off') return;
    this._stepIndex = 0;
    const interval = this._getIntervalMs();
    this._timer = setInterval(() => this._step(), interval);
  }

  _step() {
    if (!this._notes.length || !this._onNote) return;
    this._stepIndex = this._stepIndex % this._notes.length;
    const note = this._notes[this._stepIndex];
    this._onNote([note]);
    this._stepIndex++;
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  destroy() {
    this.stop();
    this._onNote = null;
  }
}
