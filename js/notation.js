/**
 * notation.js — Live Grand Staff Voicing Display
 * =================================================
 * Renders a real-time grand staff (treble + bass clef) showing:
 *   - Lead note (highlighted in gold)
 *   - Harmony voices (white)
 *   - Chord symbol above the staff
 *   - Voicing type label
 *   - Rule violations highlighted in red
 *
 * Uses VexFlow 4.x (loaded globally via <script> tag).
 *
 * Copyright 2026 Blues Prince Media.
 */

const VF = () => window.Vex?.Flow || window.VexFlow;

// MIDI note name lookup for VexFlow key format: "c/4", "bb/3", etc.
const PC_TO_VEX = ['c', 'c#', 'd', 'eb', 'e', 'f', 'f#', 'g', 'ab', 'a', 'bb', 'b'];

/**
 * Convert MIDI note number to VexFlow key string.
 * VexFlow format: "c/4", "eb/5", "f#/3"
 */
function midiToVexKey(midi) {
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return `${PC_TO_VEX[pc]}/${octave}`;
}

/**
 * Split MIDI notes into treble (≥60) and bass (<60) groups.
 */
function splitByClef(midiNotes) {
  const treble = [];
  const bass = [];
  for (const n of midiNotes) {
    if (n >= 60) treble.push(n);
    else bass.push(n);
  }
  return { treble, bass };
}

let _renderer = null;
let _context = null;
let _containerEl = null;
let _frameCount = 0;
const THROTTLE = 3; // render every 3rd call (~12fps at 36fps pitch rate)

/**
 * Initialize the notation display.
 * @param {HTMLElement} container - DOM element to render into
 */
export function initNotation(container) {
  _containerEl = container;
  const vf = VF();
  if (!vf) {
    console.warn('[THIRI] VexFlow not loaded — notation display disabled');
    return;
  }

  _renderer = new vf.Renderer(container, vf.Renderer.Backends.SVG);
  _renderer.resize(700, 200);
  _context = _renderer.getContext();
  _context.setFont('Inter', 10);
}

/**
 * Update the notation display with current voicing.
 * @param {number} leadMidi - Detected lead MIDI note
 * @param {number[]} harmonyNotes - All harmony MIDI notes (may include lead)
 * @param {string} chordSymbol - Current chord symbol (e.g., "Cmaj7")
 * @param {string} voicingType - Voicing label (e.g., "close", "drop2", "jazz4")
 * @param {Array} violations - Rule violations from validateVoicing
 */
export function updateNotation(leadMidi, harmonyNotes, chordSymbol, voicingType, violations) {
  // Throttle rendering
  _frameCount++;
  if (_frameCount % THROTTLE !== 0) return;

  const vf = VF();
  if (!vf || !_context || !_containerEl) return;

  // Clear previous render
  _context.clear();
  _containerEl.innerHTML = '';
  _renderer = new vf.Renderer(_containerEl, vf.Renderer.Backends.SVG);
  _renderer.resize(700, 200);
  _context = _renderer.getContext();

  // Collect all MIDI notes (lead + harmony)
  const allNotes = [leadMidi, ...harmonyNotes].filter(n => n > 0);
  if (!allNotes.length) return;

  // Build violation note set for highlighting
  const violatedNotes = new Set();
  if (violations) {
    for (const v of violations) {
      if (v.note) violatedNotes.add(v.note);
      if (v.notes) v.notes.forEach(n => violatedNotes.add(n));
    }
  }

  const { treble, bass } = splitByClef(allNotes);

  try {
    // Create staves
    const trebleStave = new vf.Stave(40, 10, 600);
    trebleStave.addClef('treble');
    if (chordSymbol) {
      trebleStave.setText(chordSymbol, vf.Modifier.Position.ABOVE, {
        shift_y: -10,
        justification: vf.TextNote?.Justification?.LEFT ?? 1,
      });
    }
    trebleStave.setContext(_context).draw();

    const bassStave = new vf.Stave(40, 100, 600);
    bassStave.addClef('bass');
    bassStave.setContext(_context).draw();

    // Draw connector
    const connector = new vf.StaveConnector(trebleStave, bassStave);
    connector.setType(vf.StaveConnector.type.BRACE);
    connector.setContext(_context).draw();

    // Create treble notes
    if (treble.length > 0) {
      const keys = treble.map(m => midiToVexKey(m));
      const staveNote = new vf.StaveNote({
        clef: 'treble',
        keys,
        duration: 'w', // whole note (sustained voicing snapshot)
      });

      // Color each note head
      for (let i = 0; i < treble.length; i++) {
        const midi = treble[i];
        let color = '#c0c0d0'; // default: dim white
        if (midi === leadMidi) color = '#d4af37'; // gold for lead
        if (violatedNotes.has(midi)) color = '#e04040'; // red for violations
        staveNote.setKeyStyle(i, { fillStyle: color, strokeStyle: color });
      }

      // Add accidentals
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (key.includes('#')) staveNote.addModifier(new vf.Accidental('#'), i);
        else if (key.includes('b') && !key.startsWith('b/')) staveNote.addModifier(new vf.Accidental('b'), i);
      }

      const trebleVoice = new vf.Voice({ num_beats: 4, beat_value: 4 }).setStrict(false);
      trebleVoice.addTickable(staveNote);
      new vf.Formatter().joinVoices([trebleVoice]).format([trebleVoice], 500);
      trebleVoice.draw(_context, trebleStave);
    }

    // Create bass notes
    if (bass.length > 0) {
      const keys = bass.map(m => midiToVexKey(m));
      const staveNote = new vf.StaveNote({
        clef: 'bass',
        keys,
        duration: 'w',
      });

      for (let i = 0; i < bass.length; i++) {
        const midi = bass[i];
        let color = '#c0c0d0';
        if (midi === leadMidi) color = '#d4af37';
        if (violatedNotes.has(midi)) color = '#e04040';
        staveNote.setKeyStyle(i, { fillStyle: color, strokeStyle: color });
      }

      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (key.includes('#')) staveNote.addModifier(new vf.Accidental('#'), i);
        else if (key.includes('b') && !key.startsWith('b/')) staveNote.addModifier(new vf.Accidental('b'), i);
      }

      const bassVoice = new vf.Voice({ num_beats: 4, beat_value: 4 }).setStrict(false);
      bassVoice.addTickable(staveNote);
      new vf.Formatter().joinVoices([bassVoice]).format([bassVoice], 500);
      bassVoice.draw(_context, bassStave);
    }

    // Draw voicing label below bass staff
    if (voicingType) {
      _context.save();
      _context.setFont('JetBrains Mono', 9);
      _context.fillText(voicingType.toUpperCase(), 50, 190);
      _context.restore();
    }

  } catch (err) {
    // VexFlow can throw on edge cases — don't crash the app
    console.warn('[THIRI] Notation render error:', err.message);
  }
}

/**
 * Clear the notation display.
 */
export function clearNotation() {
  if (_context) _context.clear();
  if (_containerEl) _containerEl.innerHTML = '';
}
