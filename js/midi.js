/**
 * midi.js — Web MIDI Controller for THIRI.ai
 * =============================================
 * Maps MIDI CC messages to all THIRI parameters.
 * Handles MIDI note input for manual harmony control.
 * Uses the Web MIDI API (navigator.requestMIDIAccess).
 *
 * Default CC Map (learn-mode overridable):
 *   CC1  (Mod Wheel)  → Vowel
 *   CC2  (Breath)     → Breath
 *   CC7  (Volume)     → Master Volume
 *   CC11 (Expression) → Mix (dry/wet)
 *   CC74 (Cutoff)     → Humanize
 *   CC71 (Resonance)  → Gate
 *   CC73 (Attack)     → Confidence
 *   CC72 (Release)    → Smoothing
 *   CC16             → Drum Volume
 *   CC20–23          → Drum Slot 1–4 (toggle)
 *
 * Copyright 2026 Blues Prince Media. PATENT PENDING.
 */

export class MIDIController {
  constructor() {
    this.access = null;
    this.inputs = [];
    this.activeInput = null;
    this.learning = false;
    this._learnTarget = null;
    this._learnCallback = null;

    // Callbacks — set these from main.js
    this.onNoteOn = null;     // (note, velocity, channel) => void
    this.onNoteOff = null;    // (note, channel) => void
    this.onCC = null;         // (cc, value, channel) => void
    this.onDeviceChange = null; // (devices[]) => void

    // Default CC → parameter mapping
    this.ccMap = {
      1:  'vowel',        // Mod Wheel
      2:  'breath',       // Breath Controller
      7:  'master',       // Channel Volume
      11: 'mix',          // Expression
      74: 'humanize',     // Cutoff (commonly mapped)
      71: 'gate',         // Resonance
      73: 'confidence',   // Attack
      72: 'smoothing',    // Release
      16: 'drumVolume',   // General Purpose 1
      20: 'drumSlot0',    // General Purpose 5
      21: 'drumSlot1',
      22: 'drumSlot2',
      23: 'drumSlot3',
    };

    // Parameter handlers — set from main.js
    this.paramHandlers = {};
  }

  /**
   * Initialize Web MIDI access.
   * Returns true if MIDI is available.
   */
  async init() {
    if (!navigator.requestMIDIAccess) {
      console.warn('[MIDI] Web MIDI API not available');
      return false;
    }

    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      this._updateInputs();

      // Listen for device changes (hot-plug)
      this.access.onstatechange = () => {
        this._updateInputs();
      };

      console.log(`[MIDI] Initialized — ${this.inputs.length} input(s) found`);
      return true;
    } catch (err) {
      console.warn('[MIDI] Access denied:', err);
      return false;
    }
  }

  _updateInputs() {
    // Disconnect old listeners
    this.inputs.forEach(input => {
      input.onmidimessage = null;
    });

    this.inputs = [];
    if (!this.access) return;

    for (const input of this.access.inputs.values()) {
      input.onmidimessage = (e) => this._handleMessage(e);
      this.inputs.push(input);
    }

    // Auto-select first input if none active
    if (this.inputs.length > 0 && !this.activeInput) {
      this.activeInput = this.inputs[0];
    }

    if (this.onDeviceChange) {
      this.onDeviceChange(this.getDevices());
    }
  }

  _handleMessage(event) {
    const [status, data1, data2] = event.data;
    const msgType = status & 0xF0;
    const channel = status & 0x0F;

    switch (msgType) {
      case 0x90: // Note On
        if (data2 > 0) {
          if (this.onNoteOn) this.onNoteOn(data1, data2, channel);
        } else {
          // Note On with velocity 0 = Note Off
          if (this.onNoteOff) this.onNoteOff(data1, channel);
        }
        break;

      case 0x80: // Note Off
        if (this.onNoteOff) this.onNoteOff(data1, channel);
        break;

      case 0xB0: // Control Change
        this._handleCC(data1, data2, channel);
        break;

      case 0xE0: // Pitch Bend
        // Convert to 0–127 range for consistency
        const bend = ((data2 << 7) | data1) / 16383 * 127;
        this._handleCC('pitchBend', Math.round(bend), channel);
        break;
    }
  }

  _handleCC(cc, value, channel) {
    // Learning mode: assign this CC to the target parameter
    if (this.learning && this._learnTarget) {
      // Remove old mapping for this CC
      delete this.ccMap[cc];
      // Remove old CC for this target
      for (const [key, val] of Object.entries(this.ccMap)) {
        if (val === this._learnTarget) delete this.ccMap[key];
      }
      this.ccMap[cc] = this._learnTarget;
      this.learning = false;
      if (this._learnCallback) this._learnCallback(cc, this._learnTarget);
      this._learnTarget = null;
      this._learnCallback = null;
      return;
    }

    // Fire generic CC callback
    if (this.onCC) this.onCC(cc, value, channel);

    // Route to mapped parameter
    const param = this.ccMap[cc];
    if (param && this.paramHandlers[param]) {
      // Normalize 0–127 to 0–1
      const normalized = value / 127;
      this.paramHandlers[param](normalized, value);
    }
  }

  /**
   * Enter learn mode — next CC received will be mapped to the target parameter.
   */
  learn(targetParam, callback) {
    this.learning = true;
    this._learnTarget = targetParam;
    this._learnCallback = callback;
  }

  cancelLearn() {
    this.learning = false;
    this._learnTarget = null;
    this._learnCallback = null;
  }

  /**
   * Register a parameter handler.
   * @param {string} paramName - parameter name (e.g., 'vowel', 'master')
   * @param {function} handler - (normalizedValue: 0–1, rawValue: 0–127) => void
   */
  registerParam(paramName, handler) {
    this.paramHandlers[paramName] = handler;
  }

  /**
   * Get list of connected MIDI devices.
   */
  getDevices() {
    return this.inputs.map(input => ({
      id: input.id,
      name: input.name || 'Unknown MIDI Device',
      manufacturer: input.manufacturer || '',
      state: input.state,
    }));
  }

  /**
   * Select a specific MIDI input by ID.
   */
  selectInput(deviceId) {
    this.activeInput = this.inputs.find(i => i.id === deviceId) || null;
  }

  /**
   * Get current CC map for display.
   */
  getCCMap() {
    return { ...this.ccMap };
  }

  destroy() {
    this.inputs.forEach(input => {
      input.onmidimessage = null;
    });
    this.inputs = [];
    this.access = null;
  }
}
