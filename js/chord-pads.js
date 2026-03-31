/**
 * chord-pads.js — Live Chord Pad Grid Generator
 * ================================================
 * Builds a 3-row chord grid from any key for live performance:
 *   Row 1: Diatonic chords (I ii iii IV V vi vii)
 *   Row 2: Secondary dominants (V7/x) — with tritone sub variants
 *   Row 3: ii-V approaches (ii-7 of each V7) — with dominant 7 variants
 *
 * Copyright 2026 Blues Prince Media.
 */

import { NOTE_NAMES, NOTE_NAMES_FLAT, NOTE_MAP, SCALE_FORMULAS } from './scales.js';

// ── Diatonic chord quality by scale degree (major key) ──────────────
// I=maj7, ii=m7, iii=m7, IV=maj7, V=7, vi=m7, vii=m7b5
const DIATONIC_QUALITIES = ['maj7', 'm7', 'm7', 'maj7', '7', 'm7', 'm7b5'];

// ── Note name selection (prefer flats for flat keys) ────────────────
const FLAT_KEYS = new Set(['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb']);

function noteName(pitchClass, key) {
  const useFlats = FLAT_KEYS.has(key);
  return useFlats ? NOTE_NAMES_FLAT[pitchClass % 12] : NOTE_NAMES[pitchClass % 12];
}

// ── Build chord symbol from root + quality ──────────────────────────
function chordSymbol(root, quality) {
  if (quality === 'maj7') return root + 'maj7';
  if (quality === 'm7') return root + 'm7';
  if (quality === 'm7b5') return root + 'm7b5';
  if (quality === '7') return root + '7';
  if (quality === 'dim7') return root + 'dim7';
  return root + quality;
}

/**
 * Build the full 3-row chord grid for a given key.
 *
 * @param {string} key - Root note name (e.g., 'C', 'Bb', 'F#')
 * @returns {Object} Grid data with 5 arrays of chord objects
 */
export function buildChordGrid(key) {
  const rootPc = NOTE_MAP[key];
  if (rootPc === undefined) return null;

  const formula = SCALE_FORMULAS['major'];
  if (!formula) return null;

  // ── Row 1: Diatonic chords ──
  const diatonic = formula.map((interval, degree) => {
    const pc = (rootPc + interval) % 12;
    const root = noteName(pc, key);
    const quality = DIATONIC_QUALITIES[degree];
    return { symbol: chordSymbol(root, quality), root, quality };
  });

  // ── Row 2: Secondary dominants (V7 of each diatonic chord) ──
  // V7/x = dominant 7th whose root is a perfect 5th above the target
  const dominants = diatonic.map(chord => {
    const targetPc = NOTE_MAP[chord.root];
    const domRoot = (targetPc + 7) % 12; // perfect 5th above
    const root = noteName(domRoot, key);
    return { symbol: root + '7', root, quality: '7' };
  });

  // ── Row 2 alt: Tritone substitutions ──
  // Tritone sub of V7 = dom7 chord a tritone (6 semitones) from the V7 root
  const tritones = dominants.map(dom => {
    const domPc = NOTE_MAP[dom.root];
    const ttRoot = (domPc + 6) % 12;
    const root = noteName(ttRoot, key);
    return { symbol: root + '7', root, quality: '7' };
  });

  // ── Row 3: ii-7 approach to each V7 ──
  // ii of V = minor 7th chord whose root is a whole step below the V root
  const approaches = dominants.map(dom => {
    const domPc = NOTE_MAP[dom.root];
    const iiRoot = (domPc + 10) % 12; // whole step below = -2 = +10
    const root = noteName(iiRoot, key);
    // Determine quality: most are m7, but ii of a m7b5 target could be m7b5
    // For simplicity and musical convention, all ii chords are m7
    // Exception: if the ii root lands on the 7th degree, it's m7b5
    const iiPc = NOTE_MAP[root];
    const degreeInKey = formula.findIndex(i => (rootPc + i) % 12 === iiPc);
    const quality = (degreeInKey === 6) ? 'm7b5' : 'm7';
    return { symbol: chordSymbol(root, quality), root, quality };
  });

  // ── Row 3 alt: Dominant versions of each ii chord ──
  const approachesDom = approaches.map(ap => {
    return { symbol: ap.root + '7', root: ap.root, quality: '7' };
  });

  return { diatonic, dominants, tritones, approaches, approachesDom };
}

/**
 * Get the Roman numeral label for a diatonic degree.
 */
const ROMAN_NUMERALS = ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii\u00B0'];
export function getRomanNumeral(degree) {
  return ROMAN_NUMERALS[degree] || '';
}

/**
 * Get descriptive label for Row 2/3 chords.
 */
export function getDominantLabel(degree) {
  return 'V/' + ROMAN_NUMERALS[degree];
}

export function getApproachLabel(degree) {
  return 'ii/' + ROMAN_NUMERALS[degree];
}
