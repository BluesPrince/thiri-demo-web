/**
 * scales.js — Music Theory Foundation
 * ====================================
 * Ported from WoodShed's harmonySpelling.ts + harmonyEngine.ts
 * 
 * Provides:
 *   - Note/pitch maps, MIDI ↔ frequency conversion
 *   - Scale formulas (15 scales from WoodShed SCALE_FORMULAS)
 *   - Diatonic note generation, scale snapping, degree calculation
 * 
 * Copyright 2026 Blues Prince Media. PATENT PENDING.
 * Part of the WoodShed chord intelligence layer.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// NOTE CONSTANTS (from WoodShed harmonySpelling.ts PITCH_MAP + chordAnalysis.ts)
// ═══════════════════════════════════════════════════════════════════════════════

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const NOTE_NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

/** Maps note name → pitch class (0-11), matching WoodShed's NOTE_MAP / PITCH_MAP */
export const NOTE_MAP = {
  'C': 0, 'B#': 0,
  'C#': 1, 'Db': 1,
  'D': 2,
  'D#': 3, 'Eb': 3,
  'E': 4, 'Fb': 4,
  'F': 5, 'E#': 5,
  'F#': 6, 'Gb': 6,
  'G': 7,
  'G#': 8, 'Ab': 8,
  'A': 9,
  'A#': 10, 'Bb': 10,
  'B': 11, 'Cb': 11,
};

// ═══════════════════════════════════════════════════════════════════════════════
// SCALE FORMULAS (from WoodShed harmonySpelling.ts SCALE_FORMULAS)
// ═══════════════════════════════════════════════════════════════════════════════

/** Scale intervals in semitones from root — direct port from WoodShed */
export const SCALE_FORMULAS = {
  'major':            [0, 2, 4, 5, 7, 9, 11],
  'natural-minor':    [0, 2, 3, 5, 7, 8, 10],
  'dorian':           [0, 2, 3, 5, 7, 9, 10],
  'phrygian':         [0, 1, 3, 5, 7, 8, 10],
  'lydian':           [0, 2, 4, 6, 7, 9, 11],
  'mixolydian':       [0, 2, 4, 5, 7, 9, 10],
  'locrian':          [0, 1, 3, 5, 6, 8, 10],
  'harmonic-minor':   [0, 2, 3, 5, 7, 8, 11],
  'melodic-minor':    [0, 2, 3, 5, 7, 9, 11],
  'whole-tone':       [0, 2, 4, 6, 8, 10],
  'diminished':       [0, 2, 3, 5, 6, 8, 9, 11],
  'blues':            [0, 3, 5, 6, 7, 10],
  'bebop-dominant':   [0, 2, 4, 5, 7, 9, 10, 11],
  'altered':          [0, 1, 3, 4, 6, 8, 10],
  'lydian-dominant':  [0, 2, 4, 6, 7, 9, 10],
};

/** User-friendly mode names for UI */
export const MODE_DISPLAY_NAMES = {
  'major':            'Major (Ionian)',
  'natural-minor':    'Minor (Aeolian)',
  'dorian':           'Dorian',
  'phrygian':         'Phrygian',
  'lydian':           'Lydian',
  'mixolydian':       'Mixolydian',
  'locrian':          'Locrian',
  'harmonic-minor':   'Harmonic Minor',
  'melodic-minor':    'Melodic Minor',
  'whole-tone':       'Whole Tone',
  'diminished':       'Diminished',
  'blues':            'Blues',
  'bebop-dominant':   'Bebop Dominant',
  'altered':          'Altered',
  'lydian-dominant':  'Lydian Dominant',
};

// ═══════════════════════════════════════════════════════════════════════════════
// MIDI ↔ FREQUENCY (from WoodShed harmonyEngine.ts)
// ═══════════════════════════════════════════════════════════════════════════════

/** Convert MIDI note number to frequency (A4 = 440Hz = MIDI 69) */
export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Convert frequency to MIDI note number */
export function freqToMidi(freq) {
  if (freq <= 0) return -1;
  return 12 * Math.log2(freq / 440) + 69;
}

/** Convert frequency to nearest integer MIDI note */
export function freqToMidiRounded(freq) {
  return Math.round(freqToMidi(freq));
}

// ═══════════════════════════════════════════════════════════════════════════════
// NOTE NAME UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/** MIDI note → note name + octave (e.g., 60 → "C4") */
export function midiToNoteName(midi) {
  const noteIndex = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return NOTE_NAMES[noteIndex] + octave;
}

/** MIDI note → just the note name without octave (e.g., 60 → "C") */
export function midiToNoteNameOnly(midi) {
  const noteIndex = ((midi % 12) + 12) % 12;
  return NOTE_NAMES[noteIndex];
}

/** MIDI note → octave number (e.g., 60 → 4) */
export function midiToOctave(midi) {
  return Math.floor(midi / 12) - 1;
}

/** Get pitch class (0-11) from MIDI note */
export function midiToPitchClass(midi) {
  return ((midi % 12) + 12) % 12;
}

/** Note name to pitch class (e.g., "C#" → 1) */
export function noteNameToPitchClass(name) {
  return NOTE_MAP[name] ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCALE GENERATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get the pitch classes (0-11) for a given key + mode.
 * E.g., getScalePitchClasses('C', 'major') → [0, 2, 4, 5, 7, 9, 11]
 *       getScalePitchClasses('G', 'major') → [7, 9, 11, 0, 2, 4, 6]
 */
export function getScalePitchClasses(keyName, mode) {
  const rootPc = NOTE_MAP[keyName];
  if (rootPc === undefined) return [];
  const formula = SCALE_FORMULAS[mode];
  if (!formula) return [];
  return formula.map(interval => (rootPc + interval) % 12);
}

/**
 * Get all MIDI notes in the scale within a given range.
 * Returns sorted array of MIDI note numbers.
 */
export function getScaleMidiNotes(keyName, mode, midiLow = 36, midiHigh = 84) {
  const pitchClasses = getScalePitchClasses(keyName, mode);
  if (pitchClasses.length === 0) return [];

  const notes = [];
  for (let midi = midiLow; midi <= midiHigh; midi++) {
    if (pitchClasses.includes(midiToPitchClass(midi))) {
      notes.push(midi);
    }
  }
  return notes;
}

/**
 * Snap a MIDI note to the nearest note in the scale.
 * Returns the closest diatonic MIDI note.
 */
export function snapToScale(midiNote, keyName, mode) {
  const pitchClasses = getScalePitchClasses(keyName, mode);
  if (pitchClasses.length === 0) return midiNote;

  const pc = midiToPitchClass(midiNote);
  if (pitchClasses.includes(pc)) return midiNote;

  // Find nearest diatonic pitch class
  let bestDist = 12;
  let bestPc = pc;
  for (const scalePc of pitchClasses) {
    const dist = Math.min(
      Math.abs(scalePc - pc),
      12 - Math.abs(scalePc - pc)
    );
    if (dist < bestDist) {
      bestDist = dist;
      bestPc = scalePc;
    }
  }

  // Compute MIDI note adjustment
  const currentPc = pc;
  let diff = bestPc - currentPc;
  // Choose the shortest path (up or down)
  if (diff > 6) diff -= 12;
  if (diff < -6) diff += 12;
  return midiNote + diff;
}

/**
 * Get the scale degree index (0-based) of a MIDI note within a key+mode.
 * Returns -1 if the note is not in the scale.
 */
export function getScaleDegree(midiNote, keyName, mode) {
  const pitchClasses = getScalePitchClasses(keyName, mode);
  const pc = midiToPitchClass(midiNote);
  return pitchClasses.indexOf(pc);
}

/**
 * Move a note up or down by N diatonic scale steps.
 * Positive = up, negative = down.
 */
export function moveDiatonically(midiNote, steps, keyName, mode) {
  const scaleNotes = getScaleMidiNotes(keyName, mode, 0, 127);
  if (scaleNotes.length === 0) return midiNote;

  // Find the closest scale note to the input
  let closestIdx = 0;
  let closestDist = Infinity;
  for (let i = 0; i < scaleNotes.length; i++) {
    const dist = Math.abs(scaleNotes[i] - midiNote);
    if (dist < closestDist) {
      closestDist = dist;
      closestIdx = i;
    }
  }

  // Move by steps
  const targetIdx = closestIdx + steps;
  if (targetIdx < 0) return scaleNotes[0];
  if (targetIdx >= scaleNotes.length) return scaleNotes[scaleNotes.length - 1];
  return scaleNotes[targetIdx];
}

// ═══════════════════════════════════════════════════════════════════════════════
// VOICE RANGE LIMITS
// ═══════════════════════════════════════════════════════════════════════════════

/** Vocal/harmony range limits in MIDI (C2 to C6) */
export const VOICE_RANGE = {
  low: 36,   // C2
  high: 84,  // C6
};

/** Clamp a MIDI note to the voice range */
export function clampToRange(midi, low = VOICE_RANGE.low, high = VOICE_RANGE.high) {
  while (midi < low) midi += 12;
  while (midi > high) midi -= 12;
  return midi;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHORD-TONE RESOLUTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Chord quality → semitone intervals from root.
 * These are the ACTUAL chord tones, not scale tones.
 * E.g., m7 = [0, 3, 7, 10] = root, minor 3rd, perfect 5th, minor 7th
 */
export const CHORD_INTERVALS = {
  'maj':    [0, 4, 7],
  '7':      [0, 4, 7, 10],
  'maj7':   [0, 4, 7, 11],
  'm':      [0, 3, 7],
  'm7':     [0, 3, 7, 10],
  'mMaj7':  [0, 3, 7, 11],
  'm7b5':   [0, 3, 6, 10],
  'dim':    [0, 3, 6],
  'dim7':   [0, 3, 6, 9],
  'aug':    [0, 4, 8],
  'sus2':   [0, 2, 7],
  'sus4':   [0, 5, 7],
  '9':      [0, 4, 7, 10, 14],
  '11':     [0, 4, 7, 10, 14, 17],
  '13':     [0, 4, 7, 10, 14, 17, 21],
};

/**
 * Get all MIDI chord tones for a given root + quality within a range.
 * @param {string} rootName - Root note name, e.g. "Bb", "F#"
 * @param {string} quality  - Chord quality key from CHORD_INTERVALS
 * @param {number} midiLow  - Lowest MIDI note (default 36 = C2)
 * @param {number} midiHigh - Highest MIDI note (default 84 = C6)
 * @returns {number[]} Sorted array of MIDI note numbers
 */
export function getChordTonesMidi(rootName, quality, midiLow = 36, midiHigh = 84) {
  const rootPc = NOTE_MAP[rootName];
  if (rootPc === undefined) return [];
  const intervals = CHORD_INTERVALS[quality] || CHORD_INTERVALS['maj'];

  const pitchClasses = intervals.map(i => (rootPc + i) % 12);
  const notes = [];
  for (let midi = midiLow; midi <= midiHigh; midi++) {
    if (pitchClasses.includes(midiToPitchClass(midi))) {
      notes.push(midi);
    }
  }
  return notes;
}

/**
 * Find the nearest chord tone MIDI note to a given MIDI note.
 * @param {number} midi - Input MIDI note
 * @param {number[]} chordTones - Array of valid MIDI chord tones
 * @returns {number} Nearest chord tone
 */
export function nearestChordTone(midi, chordTones) {
  if (chordTones.length === 0) return midi;
  let best = chordTones[0];
  let bestDist = Infinity;
  for (const ct of chordTones) {
    const dist = Math.abs(ct - midi);
    if (dist < bestDist) {
      bestDist = dist;
      best = ct;
    }
  }
  return best;
}

// ═══════════════════════════════════════════════════════════════════════════════
// JAZZ HARMONY UTILITIES (THIRI Theory Matrix)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Available tensions for each chord quality.
 * Semitone intervals from root — tensions that sound good over each quality.
 */
export const CHORD_TENSIONS = {
  'maj':    { 9: 14, '#11': 18, 13: 21 },
  'maj7':   { 9: 14, '#11': 18, 13: 21 },
  '7':      { 9: 14, '#11': 18, 13: 21, 'b9': 13, '#9': 15, 'b13': 20 },
  'm':      { 9: 14, 11: 17, 13: 21 },
  'm7':     { 9: 14, 11: 17, 13: 21 },
  'mMaj7':  { 9: 14, 11: 17, 13: 21 },
  'm7b5':   { 9: 14, 11: 17, 'b13': 20 },
  'dim7':   { 9: 14, 11: 17, 'b13': 20 },
  'aug':    { 9: 14, '#11': 18 },
  'sus4':   { 9: 14, 13: 21 },
  'sus2':   { 11: 17, 13: 21 },
};

// ═══════════════════════════════════════════════════════════════════════════════
// AVOID NOTES — diatonic tones that clash with chord tones (minor 9th above)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Avoid note intervals (semitones from root) by chord quality and mode.
 * An avoid note is a diatonic scale tone a half step above a chord tone.
 * Voicing these as sustained harmony notes creates harsh minor 9th clashes.
 */
export const AVOID_NOTES = {
  'maj7':  { 'major': [5], 'lydian': [] },                    // 4 (F over Cmaj7) — half step above 3rd
  'maj':   { 'major': [5], 'lydian': [] },
  '7':     { 'mixolydian': [5] },                              // 4 over dom7 — half step above 3rd
  '9':     { 'mixolydian': [5] },
  '11':    { 'mixolydian': [5] },
  '13':    { 'mixolydian': [5] },
  'm7':    { 'dorian': [], 'aeolian': [8], 'phrygian': [1, 8] }, // b6 over Aeolian; b2+b6 over Phrygian
  'm':     { 'dorian': [], 'aeolian': [8], 'phrygian': [1, 8] },
  'mMaj7': { 'melodic-minor': [] },
  'm7b5':  { 'locrian': [1] },                                // b2 over Locrian — half step above root
  'dim7':  { 'diminished': [] },
  'sus4':  { 'mixolydian': [] },
  'sus2':  { 'major': [] },
  'aug':   { 'whole-tone': [] },
};

/**
 * Check if a pitch class is an avoid note for the given chord/mode.
 * @param {number} pitchClass - 0-11 pitch class
 * @param {number} rootPc - Root pitch class (0-11)
 * @param {string} quality - Chord quality key
 * @param {string} mode - Scale mode (e.g., 'major', 'dorian')
 * @returns {boolean}
 */
export function isAvoidNote(pitchClass, rootPc, quality, mode) {
  const qualityEntry = AVOID_NOTES[quality];
  if (!qualityEntry) return false;
  const avoidIntervals = qualityEntry[mode] || qualityEntry[Object.keys(qualityEntry)[0]] || [];
  const interval = ((pitchClass - rootPc) % 12 + 12) % 12;
  return avoidIntervals.includes(interval);
}

/**
 * Find the nearest non-avoid chord tone or tension to replace an avoid note.
 * Searches ±2 semitones for the closest chord tone that isn't an avoid note.
 * @param {number} midi - The avoid note MIDI number
 * @param {string} rootName - Chord root
 * @param {string} quality - Chord quality
 * @returns {number} Replacement MIDI note
 */
export function replaceAvoidNote(midi, rootName, quality) {
  const rootPc = NOTE_MAP[rootName];
  if (rootPc === undefined) return midi;
  const intervals = CHORD_INTERVALS[quality] || CHORD_INTERVALS['maj'];
  const chordPcs = new Set(intervals.map(i => (rootPc + i) % 12));

  // Also include safe tensions
  const tensions = CHORD_TENSIONS[quality] || {};
  for (const t of Object.values(tensions)) {
    chordPcs.add((rootPc + t) % 12);
  }

  // Search ±1 then ±2 semitones for nearest chord tone / tension
  for (let offset of [-1, 1, -2, 2]) {
    const candidate = midi + offset;
    const pc = ((candidate % 12) + 12) % 12;
    if (chordPcs.has(pc)) return candidate;
  }
  return midi; // fallback: no replacement found
}

/**
 * Check for minor 9th (or minor 2nd) between two MIDI notes.
 * @returns {boolean} True if the interval is a minor 2nd (1 semitone) in any octave
 */
export function hasMinor9th(midiA, midiB) {
  const interval = Math.abs(midiA - midiB) % 12;
  return interval === 1;
}

/**
 * Check if a MIDI note is a chord tone of the given chord.
 * @param {number} midi - MIDI note number
 * @param {string} rootName - Chord root name (e.g. "C", "Bb")
 * @param {string} quality - Chord quality key from CHORD_INTERVALS
 * @returns {{ isChordTone: boolean, chordToneIndex: number, intervalFromRoot: number }}
 */
export function isChordTone(midi, rootName, quality) {
  const rootPc = NOTE_MAP[rootName];
  if (rootPc === undefined) return { isChordTone: false, chordToneIndex: -1, intervalFromRoot: -1 };
  const intervals = CHORD_INTERVALS[quality] || CHORD_INTERVALS['maj'];
  const pc = midiToPitchClass(midi);
  const intervalFromRoot = ((pc - rootPc) % 12 + 12) % 12;

  for (let i = 0; i < intervals.length; i++) {
    if ((intervals[i] % 12) === intervalFromRoot) {
      return { isChordTone: true, chordToneIndex: i, intervalFromRoot };
    }
  }
  return { isChordTone: false, chordToneIndex: -1, intervalFromRoot };
}

/**
 * Get the guide tones (3rd and 7th) of a chord as pitch classes.
 * Guide tones define chord quality and are the most important voices in jazz harmony.
 * @param {string} rootName - Chord root name
 * @param {string} quality - Chord quality
 * @returns {number[]} Array of 1-2 pitch classes (the guide tones)
 */
export function getGuideTones(rootName, quality) {
  const rootPc = NOTE_MAP[rootName];
  if (rootPc === undefined) return [];
  const intervals = CHORD_INTERVALS[quality] || CHORD_INTERVALS['maj'];

  const guides = [];
  // 3rd (interval 3 or 4 semitones from root)
  const third = intervals.find(i => i === 3 || i === 4);
  if (third !== undefined) guides.push((rootPc + third) % 12);
  // 7th (interval 9, 10, or 11 semitones from root)
  const seventh = intervals.find(i => i === 9 || i === 10 || i === 11);
  if (seventh !== undefined) guides.push((rootPc + seventh) % 12);

  return guides;
}

/**
 * Get the guide tones as MIDI notes nearest to a reference pitch.
 * @param {string} rootName - Chord root
 * @param {string} quality - Chord quality
 * @param {number} nearMidi - Reference MIDI note to place guides near
 * @returns {number[]} MIDI note numbers for guide tones
 */
export function getGuideTonesNear(rootName, quality, nearMidi) {
  const guidePcs = getGuideTones(rootName, quality);
  return guidePcs.map(pc => {
    // Find the nearest MIDI note with this pitch class
    const baseMidi = nearMidi - 12; // search range
    let best = nearMidi;
    let bestDist = Infinity;
    for (let m = baseMidi; m <= nearMidi + 12; m++) {
      if (midiToPitchClass(m) === pc) {
        const dist = Math.abs(m - nearMidi);
        if (dist < bestDist) { bestDist = dist; best = m; }
      }
    }
    return best;
  });
}

/**
 * Build a diminished 7th chord from a root MIDI note.
 * Used for passing diminished harmonization of non-chord tones.
 * Dim7 = stacked minor 3rds: root, b3, b5, bb7 (= [0, 3, 6, 9])
 * @param {number} rootMidi - Root MIDI note
 * @returns {number[]} Array of 4 MIDI notes forming the dim7
 */
export function buildDim7(rootMidi) {
  return [rootMidi, rootMidi + 3, rootMidi + 6, rootMidi + 9];
}

/**
 * Get available tension MIDI notes for a chord, near a reference pitch.
 * @param {string} rootName - Chord root
 * @param {string} quality - Chord quality
 * @param {number} nearMidi - Reference pitch to place tensions near
 * @returns {{ name: string, midi: number }[]} Available tensions
 */
export function getAvailableTensions(rootName, quality, nearMidi) {
  const rootPc = NOTE_MAP[rootName];
  if (rootPc === undefined) return [];
  const tensions = CHORD_TENSIONS[quality] || {};

  return Object.entries(tensions).map(([name, semitones]) => {
    const pc = (rootPc + semitones) % 12;
    // Find nearest MIDI note with this pitch class
    let best = nearMidi;
    let bestDist = Infinity;
    for (let m = nearMidi - 12; m <= nearMidi + 12; m++) {
      if (midiToPitchClass(m) === pc) {
        const dist = Math.abs(m - nearMidi);
        if (dist < bestDist) { bestDist = dist; best = m; }
      }
    }
    return { name, midi: best };
  });
}

/**
 * Get the chord tone pitch classes for a chord, omitting the 5th.
 * Standard jazz practice: root, 3rd, 7th (5th is almost always omittable).
 * @param {string} rootName - Chord root
 * @param {string} quality - Chord quality
 * @returns {number[]} Pitch classes without the 5th
 */
export function getChordTonesNo5th(rootName, quality) {
  const rootPc = NOTE_MAP[rootName];
  if (rootPc === undefined) return [];
  const intervals = CHORD_INTERVALS[quality] || CHORD_INTERVALS['maj'];

  // Filter out perfect 5th (7 semitones), keep everything else
  return intervals
    .filter(i => (i % 12) !== 7)
    .map(i => (rootPc + i) % 12);
}
