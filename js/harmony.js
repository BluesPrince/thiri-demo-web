/**
 * harmony.js — WoodShed Harmony Engine (Seed)
 * =============================================
 * Given a detected pitch + key + mode + voicing type → array of harmony MIDI notes.
 *
 * This is the core of what makes Evocal a harmony-aware vocoder, not just a pitch shifter.
 * The WoodShed engine lives here. All harmony math is diatonic — not chromatic.
 *
 * Voicing types (matching WoodShed's VoicingEngine patterns):
 *   close    — diatonic 3rds stacked above/below/around lead
 *   open     — spread across octaves (root low, 3rd up, 5th higher)
 *   drop2    — close position, 2nd-from-top drops an octave (WoodShed getDrop2())
 *   parallel — all voices at same diatonic interval
 *   chordTone — voices gravitate to nearest chord tones
 *
 * Jazz voicing modes (Theory Matrix — voice-count-aware):
 *   jazz2    — diatonic 3rds/6ths with guide-tone preference
 *   jazz3    — three-way close (root, 3rd, 7th — omit 5th)
 *   jazz4    — four-way close / drop-2 / drop-3 / drop-2/4
 *   jazz5    — 4-voice voicing + lead doubled 8vb or added tension
 *
 * Copyright 2026 Blues Prince Media. PATENT PENDING.
 * Part of the WoodShed chord intelligence layer.
 */

import {
  getScalePitchClasses,
  getScaleMidiNotes,
  moveDiatonically,
  midiToPitchClass,
  clampToRange,
  VOICE_RANGE,
  getChordTonesMidi,
  nearestChordTone,
  NOTE_MAP,
  CHORD_INTERVALS,
  isChordTone,
  getGuideTones,
  getGuideTonesNear,
  buildDim7,
  getAvailableTensions,
  getChordTonesNo5th,
  getScaleDegree,
  isAvoidNote,
  replaceAvoidNote,
  hasMinor9th,
} from './scales.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

/** Diatonic steps for "close" harmony intervals */
const CLOSE_STEPS_ABOVE = [2, 4, 6]; // 3rds and 5ths above (2 scale steps, 4, 6)
const CLOSE_STEPS_BELOW = [-2, -4, -6];

/** Diatonic steps for "parallel" mode (thirds above by default) */
const PARALLEL_DEFAULT_STEP = 2; // diatonic 3rd above

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN HARMONY RESOLVER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get harmony notes for a sung pitch.
 *
 * @param {number} leadMidi       - MIDI note of the sung (lead) voice
 * @param {string} key            - Root note name, e.g. "C", "Bb", "F#"
 * @param {string} mode           - Scale mode key from SCALE_FORMULAS, e.g. "major", "dorian"
 * @param {string} voicingType    - "close" | "open" | "drop2" | "parallel"
 * @param {number} numVoices      - Number of harmony voices (1–4)
 * @param {string} direction      - "above" | "below" | "around"
 * @param {object} options        - Additional options
 * @param {number} options.parallelStep - Diatonic steps for parallel mode (default 2 = 3rd)
 * @returns {number[]} Array of harmony MIDI notes (excluding lead)
 */
export function getHarmonyNotes(
  leadMidi,
  key,
  mode,
  voicingType = 'close',
  numVoices = 2,
  direction = 'above',
  options = {}
) {
  // Snap lead to the scale (handle slightly out-of-tune detection)
  const snappedLead = snapLeadToScale(leadMidi, key, mode);

  let harmonyNotes;

  switch (voicingType) {
    case 'close':
      harmonyNotes = closeHarmony(snappedLead, key, mode, numVoices, direction);
      break;
    case 'open':
      harmonyNotes = openVoicing(snappedLead, key, mode, numVoices, direction);
      break;
    case 'drop2':
      harmonyNotes = drop2Voicing(snappedLead, key, mode, numVoices, direction);
      break;
    case 'parallel':
      harmonyNotes = parallelHarmony(
        snappedLead, key, mode, numVoices, direction,
        options.parallelStep ?? PARALLEL_DEFAULT_STEP
      );
      break;
    case 'chordTone':
      harmonyNotes = chordToneHarmony(
        snappedLead, numVoices, direction,
        options.chordRoot ?? key,
        options.chordQuality ?? 'maj',
        options.prevTargets ?? []
      );
      break;
    case 'jazz2':
      harmonyNotes = jazzTwoVoice(
        snappedLead, key, mode, direction,
        options.chordRoot, options.chordQuality,
      );
      break;
    case 'jazz3':
      harmonyNotes = jazzThreeVoice(
        snappedLead, key, mode,
        options.chordRoot, options.chordQuality,
        options.prevVoices ?? [],
      );
      break;
    case 'jazz4':
      harmonyNotes = jazzFourVoice(
        snappedLead, key, mode,
        options.chordRoot, options.chordQuality,
        options.dropType ?? 'drop2',
        options.prevVoices ?? [],
      );
      break;
    case 'jazz5':
      harmonyNotes = jazzFiveVoice(
        snappedLead, key, mode,
        options.chordRoot, options.chordQuality,
        options.dropType ?? 'drop2',
        options.fifthVoiceMode ?? 'double8vb',
        options.prevVoices ?? [],
      );
      break;
    default:
      harmonyNotes = closeHarmony(snappedLead, key, mode, numVoices, direction);
  }

  // Apply voice range clamping
  return harmonyNotes
    .map(midi => clampToRange(midi, VOICE_RANGE.low, VOICE_RANGE.high))
    .filter(midi => midi !== snappedLead); // Never double the lead
}

// ═══════════════════════════════════════════════════════════════════════════════
// VOICING IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Close harmony: stack diatonic 3rds above and/or below the lead.
 * Matches WoodShed's generateClosePosition() pattern.
 */
function closeHarmony(leadMidi, key, mode, numVoices, direction) {
  const voices = [];

  if (direction === 'above') {
    // Stack thirds above: +2, +4, +6 diatonic steps
    for (let i = 0; i < numVoices; i++) {
      const step = CLOSE_STEPS_ABOVE[i % CLOSE_STEPS_ABOVE.length];
      voices.push(moveDiatonically(leadMidi, step, key, mode));
    }
  } else if (direction === 'below') {
    // Stack thirds below: -2, -4, -6 diatonic steps
    for (let i = 0; i < numVoices; i++) {
      const step = CLOSE_STEPS_BELOW[i % CLOSE_STEPS_BELOW.length];
      voices.push(moveDiatonically(leadMidi, step, key, mode));
    }
  } else {
    // Around: alternate above and below
    const pairs = [
      [2, -2],
      [4, -4],
      [6, -6],
    ];
    for (let i = 0; i < numVoices; i++) {
      const pair = pairs[Math.floor(i / 2) % pairs.length];
      voices.push(moveDiatonically(leadMidi, pair[i % 2], key, mode));
    }
  }

  return voices;
}

/**
 * Open voicing: spread voices across octaves.
 * Inspired by WoodShed's getRootlessA/B register spreading and
 * voiceLeadingOptimizer's spread voicing type.
 */
function openVoicing(leadMidi, key, mode, numVoices, direction) {
  const scaleNotes = getScaleMidiNotes(key, mode, 0, 127);
  if (scaleNotes.length === 0) return [];

  // Find lead's position in the scale
  const leadIdx = findClosestScaleIdx(leadMidi, scaleNotes);
  const voices = [];

  if (direction === 'above') {
    // Place voices at wider intervals: 3rd, 5th, octave+3rd
    const openSteps = [2, 4, 9]; // diatonic 3rd, 5th, octave+2nd
    for (let i = 0; i < numVoices; i++) {
      const step = openSteps[i % openSteps.length] + Math.floor(i / openSteps.length) * 7;
      const targetIdx = leadIdx + step;
      if (targetIdx < scaleNotes.length) {
        voices.push(scaleNotes[targetIdx]);
      }
    }
  } else if (direction === 'below') {
    const openSteps = [-2, -4, -9];
    for (let i = 0; i < numVoices; i++) {
      const step = openSteps[i % openSteps.length] - Math.floor(i / openSteps.length) * 7;
      const targetIdx = leadIdx + step;
      if (targetIdx >= 0) {
        voices.push(scaleNotes[targetIdx]);
      }
    }
  } else {
    // Around: one below, others above with octave spread
    const aboveSteps = [4, 9];  // 5th, octave+3rd
    const belowStep = -4;       // 5th below
    
    voices.push(moveDiatonically(leadMidi, belowStep, key, mode));
    for (let i = 0; i < numVoices - 1; i++) {
      const step = aboveSteps[i % aboveSteps.length];
      const targetIdx = leadIdx + step;
      if (targetIdx < scaleNotes.length) {
        voices.push(scaleNotes[targetIdx]);
      }
    }
  }

  return voices.slice(0, numVoices);
}

/**
 * Drop-2: close position, then drop the second-from-top voice by an octave.
 * Direct port of WoodShed's getDrop2() / generateDrop2() logic.
 *
 * "Take the close voicing, find the 2nd voice from the top, drop it an octave."
 */
function drop2Voicing(leadMidi, key, mode, numVoices, direction) {
  // Start with close harmony (need at least 3 voices total including lead)
  const voiceCount = Math.max(numVoices, 2);
  const close = closeHarmony(leadMidi, key, mode, voiceCount, 'above');

  // Build the full set: lead + close voices, sorted
  const allVoices = [leadMidi, ...close].sort((a, b) => a - b);

  if (allVoices.length < 3) return close.slice(0, numVoices);

  // Drop the second-from-top voice by one octave (WoodShed getDrop2)
  const drop2 = [...allVoices];
  drop2[drop2.length - 2] = drop2[drop2.length - 2] - 12;
  drop2.sort((a, b) => a - b);

  // Return all voices except the lead
  const withoutLead = drop2.filter(m => m !== leadMidi);
  return withoutLead.slice(0, numVoices);
}

/**
 * Parallel harmony: all voices at the same diatonic interval from the lead.
 * E.g., all a diatonic 3rd above, all a 5th below.
 */
function parallelHarmony(leadMidi, key, mode, numVoices, direction, parallelStep) {
  const sign = direction === 'below' ? -1 : 1;
  const step = sign * Math.abs(parallelStep);
  const voices = [];

  for (let i = 0; i < numVoices; i++) {
    // Stack parallel voices: each additional voice is another step away
    const totalStep = step * (i + 1);
    voices.push(moveDiatonically(leadMidi, totalStep, key, mode));
  }

  return voices;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHORD-TONE TARGETED HARMONY (H2)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Chord-tone harmony: voices gravitate to the nearest chord tone of the
 * active chord, not fixed diatonic intervals. This is what makes harmony
 * follow a chord chart intelligently.
 *
 * On Bbm7: chord tones are [Bb, Db, F, Ab]
 *   lead = Bb → Voice 1 = Db, Voice 2 = F, Voice 3 = Ab
 *
 * Contrary motion: if the lead moves up, prefer voices that move down
 * (and vice versa). This creates the "breathing" effect of real vocal harmony.
 *
 * @param {number}   leadMidi      - Lead MIDI note
 * @param {number}   numVoices     - Number of harmony voices
 * @param {string}   direction     - "above" | "below" | "around"
 * @param {string}   chordRoot     - Root note name, e.g. "Bb"
 * @param {string}   chordQuality  - Quality key, e.g. "m7"
 * @param {number[]} prevTargets   - Previous voice MIDI notes (for smooth transitions)
 * @returns {number[]} Harmony MIDI notes
 */
function chordToneHarmony(leadMidi, numVoices, direction, chordRoot, chordQuality, prevTargets) {
  const chordTones = getChordTonesMidi(chordRoot, chordQuality, VOICE_RANGE.low, VOICE_RANGE.high);
  if (chordTones.length === 0) return [];

  // Remove chord tones that match the lead pitch class (don't double the lead)
  const leadPc = midiToPitchClass(leadMidi);
  const available = chordTones.filter(ct => midiToPitchClass(ct) !== leadPc);
  if (available.length === 0) return [];

  const voices = [];
  const used = new Set();

  for (let i = 0; i < numVoices; i++) {
    // Determine target zone based on direction
    let candidates;
    if (direction === 'above') {
      candidates = available.filter(ct => ct > leadMidi && !used.has(ct));
    } else if (direction === 'below') {
      candidates = available.filter(ct => ct < leadMidi && !used.has(ct));
    } else {
      // Around: alternate above/below
      if (i % 2 === 0) {
        candidates = available.filter(ct => ct > leadMidi && !used.has(ct));
      } else {
        candidates = available.filter(ct => ct < leadMidi && !used.has(ct));
      }
    }

    // Fallback: any unused chord tone
    if (candidates.length === 0) {
      candidates = available.filter(ct => !used.has(ct));
    }
    if (candidates.length === 0) break;

    // If we have a previous target for this voice, prefer minimal movement
    let chosen;
    if (prevTargets.length > i && prevTargets[i] > 0) {
      chosen = nearestChordTone(prevTargets[i], candidates);
    } else {
      // Pick nearest chord tone to lead, offset by direction preference
      chosen = nearestChordTone(leadMidi + (direction === 'below' ? -7 : 7) * (i + 1), candidates);
    }

    voices.push(chosen);
    used.add(chosen);
  }

  return voices;
}

// ═══════════════════════════════════════════════════════════════════════════════
// JAZZ VOICING ALGORITHMS (THIRI Theory Matrix)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get the lead voice's context against the current chord.
 * Used by all jazz voicing modes to understand what the singer is doing.
 */
export function getLeadContext(leadMidi, chordRoot, chordQuality, key, mode) {
  const ct = isChordTone(leadMidi, chordRoot, chordQuality);
  const degree = getScaleDegree(leadMidi, key, mode);
  return {
    midi: leadMidi,
    isChordTone: ct.isChordTone,
    chordToneIndex: ct.chordToneIndex,
    intervalFromRoot: ct.intervalFromRoot,
    scaleDegree: degree,  // 0-based, -1 if chromatic
  };
}

/**
 * JAZZ 2-VOICE: Diatonic 3rd/6th with guide-tone preference.
 *
 * Core rule: interval must be DIATONIC, not chromatic.
 * In C major, a 3rd below E is C, not Eb.
 * When chord is active, prefer guide tones (3rd and 7th of chord).
 */
function jazzTwoVoice(leadMidi, key, mode, direction, chordRoot, chordQuality) {
  const sign = direction === 'above' ? 1 : -1;
  const diatonicThird = moveDiatonically(leadMidi, sign * -2, key, mode); // 3rd below or above

  // If no chord context, just use diatonic third
  if (!chordRoot || !chordQuality) {
    return [diatonicThird];
  }

  // With chord context: prefer placing the harmony on a guide tone (3rd or 7th)
  const guidePcs = getGuideTones(chordRoot, chordQuality);
  if (guidePcs.length === 0) return [diatonicThird];

  // Check if the diatonic third already lands on a guide tone
  const thirdPc = midiToPitchClass(diatonicThird);
  if (guidePcs.includes(thirdPc)) {
    return [diatonicThird]; // Perfect — diatonic interval hits a guide tone
  }

  // Try diatonic 6th (= 3rd above inverted = -5 steps below) as alternative
  const diatonicSixth = moveDiatonically(leadMidi, sign * -5, key, mode);
  const sixthPc = midiToPitchClass(diatonicSixth);
  if (guidePcs.includes(sixthPc)) {
    return [diatonicSixth]; // 6th hits a guide tone — use it
  }

  // Neither hits a guide tone — find nearest guide tone to the diatonic third
  const guideNotes = getGuideTonesNear(chordRoot, chordQuality, diatonicThird);
  // Pick the guide tone that's closest to the diatonic third (preserve diatonic feel)
  let bestGuide = diatonicThird;
  let bestDist = Infinity;
  for (const g of guideNotes) {
    const dist = Math.abs(g - diatonicThird);
    if (dist < bestDist && dist <= 2) { // Only snap if within a whole step
      bestDist = dist;
      bestGuide = g;
    }
  }

  return [bestGuide];
}

/**
 * JAZZ 3-VOICE: Three-way close — lead + two chord tones below.
 *
 * Chord tone priority: root, 3rd, 7th — OMIT THE 5th.
 * Voice leading: minimize movement from prevVoices.
 */
function jazzThreeVoice(leadMidi, key, mode, chordRoot, chordQuality, prevVoices) {
  if (!chordRoot || !chordQuality) {
    // No chord context — fall back to close harmony
    return closeHarmony(leadMidi, key, mode, 2, 'below');
  }

  // Get chord tones without the 5th (standard jazz omission)
  const chordPcs = getChordTonesNo5th(chordRoot, chordQuality);
  const leadPc = midiToPitchClass(leadMidi);

  // Remove lead's pitch class from candidates (don't double)
  const candidatePcs = chordPcs.filter(pc => pc !== leadPc);

  // Build MIDI candidates below the lead, within one octave
  const candidates = [];
  for (const pc of candidatePcs) {
    // Find this pitch class just below the lead
    for (let m = leadMidi - 1; m >= leadMidi - 14; m--) {
      if (midiToPitchClass(m) === pc) {
        candidates.push(m);
        break;
      }
    }
  }

  if (candidates.length === 0) {
    return closeHarmony(leadMidi, key, mode, 2, 'below');
  }

  // Sort by pitch (highest first — closest to lead on top)
  candidates.sort((a, b) => b - a);

  // Take the top 2 candidates
  let voices = candidates.slice(0, 2);

  // Voice leading: if we have previous voices, prefer minimal movement
  if (prevVoices.length >= 2) {
    voices = voiceLeadPair(voices, prevVoices.slice(0, 2), candidates);
  }

  return voices;
}

/**
 * JAZZ 4-VOICE: Four-way close, drop-2, drop-3, or drop-2/4.
 *
 * Builds a four-note chord (1, 3, 5, 7) with melody on top.
 * Handles non-chord-tone melody with passing diminished.
 * Fixes the maj7 root-on-top semitone clash.
 */
function jazzFourVoice(leadMidi, key, mode, chordRoot, chordQuality, dropType, prevVoices) {
  if (!chordRoot || !chordQuality) {
    return drop2Voicing(leadMidi, key, mode, 3, 'above');
  }

  const rootPc = NOTE_MAP[chordRoot];
  if (rootPc === undefined) return closeHarmony(leadMidi, key, mode, 3, 'below');

  const intervals = CHORD_INTERVALS[chordQuality] || CHORD_INTERVALS['maj'];
  const leadPc = midiToPitchClass(leadMidi);
  const leadCtInfo = isChordTone(leadMidi, chordRoot, chordQuality);

  // === NON-CHORD-TONE HANDLING ===
  if (!leadCtInfo.isChordTone) {
    return handleNonChordTone(leadMidi, key, mode, chordRoot, chordQuality, dropType, prevVoices);
  }

  // === MAJ7 ROOT-ON-TOP FIX ===
  // When melody = root of a maj7 chord, the semitone between root and maj7
  // at the top of the voicing obscures the melody. Sub root with 9th.
  let chordPcs = intervals.map(i => (rootPc + i) % 12);
  const isMaj7 = chordQuality === 'maj7' || chordQuality === 'maj';
  const leadIsRoot = leadCtInfo.intervalFromRoot === 0;

  if (isMaj7 && leadIsRoot) {
    // Replace root pitch class with 9th (root + 2 semitones)
    const ninthPc = (rootPc + 2) % 12;
    chordPcs = chordPcs.map(pc => pc === rootPc ? ninthPc : pc);
  }

  // Remove lead's pitch class
  const voicePcs = chordPcs.filter(pc => pc !== leadPc);

  // === BUILD FOUR-WAY CLOSE ===
  // Place 3 chord tones below the lead, within one octave
  const closeVoices = [];
  for (const pc of voicePcs) {
    for (let m = leadMidi - 1; m >= leadMidi - 14; m--) {
      if (midiToPitchClass(m) === pc) {
        closeVoices.push(m);
        break;
      }
    }
  }
  closeVoices.sort((a, b) => b - a); // highest first
  let voices = closeVoices.slice(0, 3);

  // === APPLY DROP VOICING ===
  if (voices.length >= 3) {
    voices = applyDropVoicing(leadMidi, voices, dropType);
  }

  // Voice leading from previous frame
  if (prevVoices.length >= 3) {
    voices = voiceLeadPair(voices, prevVoices.slice(0, 3), voices);
  }

  return voices;
}

/**
 * JAZZ 5-VOICE: 4-voice voicing + lead doubled 8vb or added tension.
 */
function jazzFiveVoice(leadMidi, key, mode, chordRoot, chordQuality, dropType, fifthVoiceMode, prevVoices) {
  // Build the 4-voice voicing first
  const fourVoices = jazzFourVoice(leadMidi, key, mode, chordRoot, chordQuality, dropType, prevVoices.slice(0, 3));

  let fifthVoice;

  switch (fifthVoiceMode) {
    case 'double8vb':
      // Double the melody one octave below
      fifthVoice = leadMidi - 12;
      break;

    case 'tension9':
    case 'tension11':
    case 'tension13': {
      // Add a tension as the 5th voice
      if (!chordRoot || !chordQuality) {
        fifthVoice = leadMidi - 12; // fallback to doubling
        break;
      }
      const tensions = getAvailableTensions(chordRoot, chordQuality, leadMidi - 5);
      const targetTension = fifthVoiceMode.replace('tension', '');
      const match = tensions.find(t =>
        t.name === targetTension || t.name === '#' + targetTension || t.name === 'b' + targetTension
      );
      fifthVoice = match ? match.midi : leadMidi - 12;
      break;
    }

    default:
      fifthVoice = leadMidi - 12;
  }

  // Clamp the 5th voice
  fifthVoice = clampToRange(fifthVoice, VOICE_RANGE.low, VOICE_RANGE.high);

  // ── Minor 9th check on 8vb doubled lead ──
  // If the doubled lead creates a minor 9th with any of the 4 inner voices,
  // substitute the 9th of the chord (standard big band arranging fix).
  const allVoices = [...fourVoices, fifthVoice];
  for (const v of fourVoices) {
    if (hasMinor9th(fifthVoice, v)) {
      // Try the 9th of the chord as replacement
      if (chordRoot) {
        const rootPc = NOTE_MAP[chordRoot];
        if (rootPc !== undefined) {
          const ninthPc = (rootPc + 14) % 12; // 9th = 14 semitones = 2 semitones above root
          // Find nearest MIDI note with that pitch class below the lead
          for (let m = leadMidi - 14; m >= VOICE_RANGE.low; m--) {
            if (midiToPitchClass(m) === ninthPc) {
              fifthVoice = m;
              break;
            }
          }
        }
      }
      break; // only fix once
    }
  }

  return [...fourVoices, fifthVoice];
}

// ─── Jazz Voicing Helpers ────────────────────────────────────────────────────

/**
 * Handle melody notes that aren't chord tones.
 * Strategy 1: Passing diminished (V7b9 no root)
 * Strategy 2: Hold previous voicing (approach tone)
 */
function handleNonChordTone(leadMidi, key, mode, chordRoot, chordQuality, dropType, prevVoices) {
  // If we have previous voices, hold them (approach tone strategy)
  // This is the safest and most musical default
  if (prevVoices.length >= 3) {
    return [...prevVoices.slice(0, 3)];
  }

  // No previous voices — use passing diminished
  // Dim7 from the melody note = V7b9 with no root — strong resolution pull
  const dim7 = buildDim7(leadMidi);
  // Take 3 notes below the lead from the dim7
  const voices = dim7
    .filter(m => m !== leadMidi)
    .map(m => {
      // Place below the lead
      while (m > leadMidi) m -= 12;
      while (m < leadMidi - 14) m += 12;
      return m;
    })
    .sort((a, b) => b - a)
    .slice(0, 3);

  return voices;
}

/**
 * Apply drop voicing transformation to a set of voices below the lead.
 * @param {number} leadMidi - The melody note (top)
 * @param {number[]} voices - Voices below lead, sorted high to low
 * @param {string} dropType - 'close' | 'drop2' | 'drop3' | 'drop24'
 * @returns {number[]} Transformed voices
 */
function applyDropVoicing(leadMidi, voices, dropType) {
  // Build full voicing: lead + voices, sorted high to low
  const all = [leadMidi, ...voices].sort((a, b) => b - a);

  switch (dropType) {
    case 'drop2':
      // Drop 2nd from top down an octave
      if (all.length >= 2) all[1] -= 12;
      break;
    case 'drop3':
      // Drop 3rd from top down an octave
      if (all.length >= 3) all[2] -= 12;
      break;
    case 'drop24':
      // Drop 2nd and 4th from top down an octave
      if (all.length >= 2) all[1] -= 12;
      if (all.length >= 4) all[3] -= 12;
      break;
    case 'close':
    default:
      // No transformation
      break;
  }

  // Remove lead, return remaining voices
  return all.filter(m => m !== leadMidi).sort((a, b) => b - a);
}

/**
 * Simple voice leading for a pair/trio of voices.
 * Tries to minimize total movement from prevVoices.
 */
function voiceLeadPair(newVoices, prevVoices, allCandidates) {
  const n = Math.min(newVoices.length, prevVoices.length);
  const result = [...newVoices];
  const used = new Set();

  // For each previous voice, find the closest new voice
  for (let i = 0; i < n; i++) {
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let j = 0; j < result.length; j++) {
      if (used.has(j)) continue;
      const dist = Math.abs(result[j] - prevVoices[i]);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = j;
      }
    }
    if (bestIdx >= 0) {
      used.add(bestIdx);
      // Swap to match the previous voice ordering
      if (bestIdx !== i && i < result.length) {
        [result[i], result[bestIdx]] = [result[bestIdx], result[i]];
      }
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Snap the lead note to the nearest diatonic note in the scale.
 * Handles slightly out-of-tune pitch detection gracefully.
 */
function snapLeadToScale(leadMidi, key, mode) {
  const pitchClasses = getScalePitchClasses(key, mode);
  const pc = midiToPitchClass(leadMidi);

  if (pitchClasses.includes(pc)) return leadMidi;

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

  // Only snap if very close (within a semitone) — this avoids mangling chromatic passing tones
  if (bestDist <= 1) {
    let diff = bestPc - pc;
    if (diff > 6) diff -= 12;
    if (diff < -6) diff += 12;
    return leadMidi + diff;
  }

  return leadMidi; // leave it alone if it's further away
}

/**
 * Find the index of the closest scale note to a given MIDI note.
 */
function findClosestScaleIdx(midi, scaleNotes) {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < scaleNotes.length; i++) {
    const dist = Math.abs(scaleNotes[i] - midi);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

// ═══════════════════════════════════════════════════════════════════════════════
// VOICE TRANSITION SMOOTHER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Given a new set of target harmony notes and the previous set,
 * assign new targets to minimize total voice movement using the
 * Hungarian-inspired greedy algorithm from WoodShed's voiceLeadingOptimizer.
 *
 * Improvements over basic nearest-neighbor:
 *   - Held notes: if a note appears in both old and new sets, pin it (zero movement)
 *   - Contrary motion: minimizes total movement cost, not per-voice — allows
 *     voices to cross and move in opposite directions when it reduces total distance
 *   - Movement budget: large jumps (>7 semitones) are penalized 2x to prefer stepwise motion
 *
 * @param {number[]} newTargets - New harmony MIDI notes
 * @param {number[]} prevTargets - Previous harmony MIDI notes
 * @returns {number[]} Reordered newTargets for smooth voice leading
 */
export function smoothVoiceTransition(newTargets, prevTargets) {
  if (!prevTargets || prevTargets.length === 0) return newTargets;
  if (newTargets.length === 0) return newTargets;

  const n = Math.min(prevTargets.length, newTargets.length);
  const matched = new Array(newTargets.length).fill(-1);
  const usedNew = new Set();
  const usedPrev = new Set();

  // Pass 0: Pin common pitch classes (same note name, possibly different octave)
  // If a pitch class appears in both old and new, keep it in the same voice
  for (let i = 0; i < n; i++) {
    const prevPc = midiToPitchClass(prevTargets[i]);
    for (let j = 0; j < newTargets.length; j++) {
      if (usedNew.has(j)) continue;
      if (midiToPitchClass(newTargets[j]) === prevPc && Math.abs(newTargets[j] - prevTargets[i]) <= 12) {
        matched[i] = newTargets[j];
        usedNew.add(j);
        usedPrev.add(i);
        break;
      }
    }
  }

  // Pass 1: Pin exact held notes (same MIDI number — zero movement)
  for (let i = 0; i < n; i++) {
    if (usedPrev.has(i)) continue; // already matched by pitch class
    for (let j = 0; j < newTargets.length; j++) {
      if (usedNew.has(j)) continue;
      if (prevTargets[i] === newTargets[j]) {
        matched[i] = newTargets[j];
        usedNew.add(j);
        usedPrev.add(i);
        break;
      }
    }
  }

  // Pass 2: Assign remaining voices by minimum total movement
  // Build cost matrix for unmatched pairs, penalizing large jumps
  const unmatchedPrev = [];
  const unmatchedNew = [];
  for (let i = 0; i < n; i++) {
    if (!usedPrev.has(i)) unmatchedPrev.push(i);
  }
  for (let j = 0; j < newTargets.length; j++) {
    if (!usedNew.has(j)) unmatchedNew.push(j);
  }

  // Greedy assignment with jump penalty
  const assignedNew = new Set();
  for (const pi of unmatchedPrev) {
    let bestJ = -1;
    let bestCost = Infinity;
    for (const nj of unmatchedNew) {
      if (assignedNew.has(nj)) continue;
      const dist = Math.abs(newTargets[nj] - prevTargets[pi]);
      // Penalize jumps > 7 semitones (prefer stepwise contrary motion)
      const cost = dist > 7 ? dist * 2 : dist;
      if (cost < bestCost) {
        bestCost = cost;
        bestJ = nj;
      }
    }
    if (bestJ >= 0) {
      matched[pi] = newTargets[bestJ];
      assignedNew.add(bestJ);
    }
  }

  // Fill any remaining slots (voice count changed)
  let fillIdx = 0;
  for (let i = 0; i < matched.length; i++) {
    if (matched[i] === -1) {
      while (fillIdx < newTargets.length && (usedNew.has(fillIdx) || assignedNew.has(fillIdx))) fillIdx++;
      if (fillIdx < newTargets.length) {
        matched[i] = newTargets[fillIdx];
        fillIdx++;
      } else {
        matched[i] = newTargets[newTargets.length - 1]; // fallback
      }
    }
  }

  return matched;
}

// ═══════════════════════════════════════════════════════════════════════════════
// VOICE LEADING VALIDATION — Jazz rule enforcement
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate and fix a voicing according to jazz voice leading rules.
 * Returns the corrected voicing + any violations found (for notation display).
 *
 * Rules applied (in order):
 *   1. Avoid note replacement
 *   2. Minor 9th / minor 2nd elimination
 *   3. Voice spacing (top 2 voices ≥ 3 semitones apart)
 *   4. No voice crossing
 *
 * @param {number[]} voices - Harmony MIDI notes (sorted low to high)
 * @param {string} chordRoot - Root note name
 * @param {string} chordQuality - Chord quality
 * @param {string} mode - Scale mode
 * @returns {{ voices: number[], violations: Array }}
 */
export function validateVoicing(voices, chordRoot, chordQuality, mode) {
  if (!voices.length || !chordRoot) return { voices, violations: [] };

  const violations = [];
  const rootPc = NOTE_MAP[chordRoot];
  if (rootPc === undefined) return { voices, violations };

  let fixed = [...voices];

  // ── 1. Avoid note replacement ──
  for (let i = 0; i < fixed.length; i++) {
    const pc = midiToPitchClass(fixed[i]);
    if (isAvoidNote(pc, rootPc, chordQuality, mode)) {
      violations.push({ type: 'avoid_note', voice: i, note: fixed[i] });
      fixed[i] = replaceAvoidNote(fixed[i], chordRoot, chordQuality);
    }
  }

  // ── 2. Minor 9th elimination ──
  // Check all pairs, prioritize fixing clashes with the bass (lowest voice)
  for (let i = 0; i < fixed.length; i++) {
    for (let j = i + 1; j < fixed.length; j++) {
      if (hasMinor9th(fixed[i], fixed[j])) {
        violations.push({ type: 'minor_9th', voices: [i, j], notes: [fixed[i], fixed[j]] });
        // Move the upper voice up 1 semitone to turn minor 2nd into major 2nd
        fixed[j] = fixed[j] + 1;
      }
    }
  }

  // ── 3. Voice spacing — top 2 voices ≥ 3 semitones (minor 3rd) ──
  if (fixed.length >= 2) {
    const sorted = [...fixed].sort((a, b) => a - b);
    const top = sorted[sorted.length - 1];
    const secondTop = sorted[sorted.length - 2];
    const spacing = top - secondTop;
    if (spacing > 0 && spacing < 3) {
      violations.push({ type: 'tight_spacing', voices: [fixed.length - 2, fixed.length - 1], spacing });
      // Don't auto-fix spacing — it could break the voicing. Just flag it.
    }
  }

  // ── 4. No voice crossing (each voice must be ≥ the one below) ──
  for (let i = 1; i < fixed.length; i++) {
    if (fixed[i] < fixed[i - 1]) {
      violations.push({ type: 'voice_crossing', voices: [i - 1, i] });
      // Swap to uncross
      [fixed[i - 1], fixed[i]] = [fixed[i], fixed[i - 1]];
    }
  }

  return { voices: fixed, violations };
}

/**
 * Check for parallel fifths or octaves between outer voices across two frames.
 * @param {number[]} prevVoices - Previous frame voices (sorted low to high)
 * @param {number[]} currVoices - Current frame voices (sorted low to high)
 * @returns {Array} Violations found
 */
export function checkParallelMotion(prevVoices, currVoices) {
  const violations = [];
  if (!prevVoices.length || !currVoices.length) return violations;
  if (prevVoices.length < 2 || currVoices.length < 2) return violations;

  // Outer voices = lowest (bass) and highest (lead)
  const prevBass = prevVoices[0];
  const prevLead = prevVoices[prevVoices.length - 1];
  const currBass = currVoices[0];
  const currLead = currVoices[currVoices.length - 1];

  // Check if both moved in the same direction
  const bassMotion = currBass - prevBass;
  const leadMotion = currLead - prevLead;

  if (bassMotion !== 0 && leadMotion !== 0 && Math.sign(bassMotion) === Math.sign(leadMotion)) {
    // Same direction — check for parallel 5ths or octaves
    const prevInterval = ((prevLead - prevBass) % 12 + 12) % 12;
    const currInterval = ((currLead - currBass) % 12 + 12) % 12;

    if (prevInterval === currInterval) {
      if (currInterval === 7) {
        violations.push({ type: 'parallel_5th', prev: [prevBass, prevLead], curr: [currBass, currLead] });
      } else if (currInterval === 0) {
        violations.push({ type: 'parallel_octave', prev: [prevBass, prevLead], curr: [currBass, currLead] });
      }
    }
  }

  return violations;
}
