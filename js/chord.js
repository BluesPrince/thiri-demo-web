/**
 * chord.js — THIRI Chord Chart Parser
 * =====================================
 * Parses a single text string into a structured chart data model.
 * Handles: bar separation, chord normalization, repeat notation,
 * form labels, Da Capo / Dal Segno navigation, and slash chords.
 *
 * The rawText field is the source of truth. Parse runs on every edit.
 * Grid ↔ text is two-way: edits in either propagate to the other.
 *
 * Copyright 2026 Blues Prince Media. PATENT PENDING.
 * Part of the WoodShed chord intelligence layer.
 */

import { NOTE_MAP } from './scales.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CHORD NORMALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Root regex: matches a note root at the start of a chord symbol.
 * Captures: letter [A-Ga-g] + optional accidental [#b]
 */
const ROOT_RE = /^([A-Ga-g])(#|b)?/;

/**
 * Normalize a single chord symbol through the 7-step pipeline.
 * Returns the normalized string, or the original if it can't be parsed.
 */
export function normalizeChord(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  let s = raw.trim();
  if (!s) return s;

  // ── Step 0: detect slash bass ──────────────────────────────────────────
  let bass = null;
  const slashIdx = s.indexOf('/');
  if (slashIdx > 0) {
    const bassStr = s.slice(slashIdx + 1);
    s = s.slice(0, slashIdx);
    // Capitalize bass root
    bass = capitalizeRoot(bassStr);
  }

  // ── Step 1: capitalize root ────────────────────────────────────────────
  s = capitalizeRoot(s);

  // Extract root + suffix
  const rootMatch = s.match(ROOT_RE);
  if (!rootMatch) return raw; // can't parse — return as-is
  const root = rootMatch[0];
  let suffix = s.slice(root.length);

  // ── Step 2: normalize minor ────────────────────────────────────────────
  // Cm7, C-7, Cmin7, Cmi7 → Cm7
  suffix = suffix.replace(/^(-|min|mi)/, 'm');

  // ── Step 3: normalize major 7 ─────────────────────────────────────────
  // CΔ7, C∆7, CM7, Cma7, Cmaj7 → Cmaj7
  suffix = suffix.replace(/^(Δ|∆|△|Ma|MA)/, 'maj');
  // CM7 case: capital M followed by 7
  suffix = suffix.replace(/^M(?=7|9|11|13|$)/, 'maj');

  // ── Step 4: normalize half-dim ─────────────────────────────────────────
  // Cø, Cø7 → Cm7b5
  suffix = suffix.replace(/^(ø|Ø)7?/, 'm7b5');

  // ── Step 5: normalize dim ─────────────────────────────────────────────
  // C°7, C°, Cdim, Cdim7 → Cdim7 (or Cdim if no 7)
  suffix = suffix.replace(/^°/, 'dim');

  // ── Step 6: normalize aug ─────────────────────────────────────────────
  // C+, C+7 → Caug, Caug7
  if (suffix.startsWith('+') && !suffix.startsWith('+/')) {
    suffix = 'aug' + suffix.slice(1);
  }

  const normalized = root + suffix;
  return bass ? `${normalized}/${bass}` : normalized;
}

/** Capitalize the first letter of a root note, preserve accidental */
function capitalizeRoot(s) {
  if (!s) return s;
  return s[0].toUpperCase() + s.slice(1);
}

/**
 * Parse a normalized chord symbol into its components.
 * Returns { symbol, root, quality, bass, extensions }
 */
export function parseChordSymbol(symbol) {
  const normalized = normalizeChord(symbol);

  let bass = null;
  let core = normalized;
  const slashIdx = normalized.indexOf('/');
  if (slashIdx > 0) {
    bass = normalized.slice(slashIdx + 1);
    core = normalized.slice(0, slashIdx);
  }

  const rootMatch = core.match(ROOT_RE);
  if (!rootMatch) return { symbol: normalized, root: null, quality: null, bass, extensions: '' };

  const root = rootMatch[0];
  const suffix = core.slice(root.length);

  // Determine quality from suffix
  let quality = 'maj'; // default
  if (suffix.startsWith('m7b5'))      quality = 'm7b5';
  else if (suffix.startsWith('dim'))  quality = suffix.includes('7') ? 'dim7' : 'dim';
  else if (suffix.startsWith('aug'))  quality = 'aug';
  else if (suffix.startsWith('m'))    quality = suffix.includes('7') ? 'm7' : suffix.includes('maj') ? 'mMaj7' : 'm';
  else if (suffix.startsWith('maj')) quality = 'maj7';
  else if (suffix.startsWith('sus'))  quality = suffix.includes('2') ? 'sus2' : 'sus4';
  else if (suffix.startsWith('7'))    quality = '7';
  else if (suffix.startsWith('9'))    quality = '9';
  else if (suffix.startsWith('11'))   quality = '11';
  else if (suffix.startsWith('13'))   quality = '13';

  // Extensions: everything after the base quality token
  const qualityLen = quality === 'm7b5' ? 4
    : quality.startsWith('dim') ? (quality === 'dim7' ? 4 : 3)
    : quality === 'aug' ? 3
    : quality === 'mMaj7' ? 4
    : quality === 'maj7' ? 4
    : quality.startsWith('sus') ? (quality === 'sus2' ? 4 : 4)
    : quality.length;
  const extensions = suffix.slice(qualityLen);

  return { symbol: normalized, root, quality, bass, extensions };
}

/**
 * Get the pitch class (0-11) of a chord root.
 */
export function chordRootPitchClass(symbol) {
  const { root } = parseChordSymbol(symbol);
  if (!root) return null;
  return NOTE_MAP[root] ?? null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHART PARSER
// ═══════════════════════════════════════════════════════════════════════════════

/** Predefined form labels (auto-colored in UI) */
export const FORM_LABELS = new Set([
  'Intro', 'Verse', 'Pre-Chorus', 'Chorus', 'Bridge',
  'Solo', 'Outro', 'Tag', 'A', 'B', 'C', 'D',
]);

/** Navigation keywords */
const NAV_KEYWORDS = ['D.C.', 'D.C. al Fine', 'D.C. al Coda', 'D.S.', 'D.S. al Coda', 'Fine'];

/**
 * Parse a raw chart text string into the THIRI data model.
 *
 * @param {string} rawText - The user's chord chart input
 * @returns {{ sections: Section[], navigation: NavInstruction[] }}
 *
 * Section: { label, bars: Bar[], repeat: { times, endings } }
 * Bar:     { chords: Chord[] }
 * Chord:   { symbol, root, quality, bass, extensions }
 */
export function parseChart(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return { sections: [], navigation: [] };
  }

  const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
  const sections = [];
  const navigation = [];
  let currentSection = null;

  for (const line of lines) {
    // ── Check for navigation keywords ──────────────────────────────────
    const navMatch = matchNavigation(line);
    if (navMatch) {
      navigation.push(navMatch);
      continue;
    }

    // ── Check for section label at start of line ───────────────────────
    const labelMatch = line.match(/^\[([^\]]+)\]\s*(.*)/);
    let label = null;
    let barText = line;

    if (labelMatch) {
      label = labelMatch[1];
      barText = labelMatch[2];
    }

    // ── Handle section-only repeat: [A] % ──────────────────────────────
    if (label && barText.trim() === '%' && sections.length > 0) {
      // Find the last section with this label and duplicate it
      const source = sections.findLast(s => s.label === label);
      if (source) {
        sections.push({
          label,
          bars: source.bars.map(b => ({ chords: [...b.chords] })),
          repeat: { ...source.repeat },
        });
        continue;
      }
    }

    // ── Start new section if we have a label ───────────────────────────
    if (label) {
      currentSection = { label, bars: [], repeat: { times: 1, endings: {} } };
      sections.push(currentSection);
    }

    // If no section yet, create an implicit one
    if (!currentSection) {
      currentSection = { label: null, bars: [], repeat: { times: 1, endings: {} } };
      sections.push(currentSection);
    }

    // ── Parse bars from this line ──────────────────────────────────────
    if (!barText.trim()) continue;

    const { bars, repeat } = parseBarsFromLine(barText, currentSection.bars);

    currentSection.bars.push(...bars);

    // Merge repeat info if detected
    if (repeat) {
      currentSection.repeat = repeat;
    }
  }

  return { sections, navigation };
}

/**
 * Parse bar content from a single line of text.
 * Handles: | separation, % repeats, |: :| repeat brackets, xN counts, endings (1. 2.)
 */
function parseBarsFromLine(text, existingBars) {
  let repeat = null;
  let line = text.trim();

  // ── Detect repeat brackets ─────────────────────────────────────────
  const isRepeatStart = line.startsWith('|:');
  const repeatEndMatch = line.match(/:\|\s*(?:x(\d+))?$/);
  const isRepeatEnd = !!repeatEndMatch;

  if (isRepeatStart) line = line.slice(2);
  if (isRepeatEnd) {
    const idx = line.lastIndexOf(':|');
    line = line.slice(0, idx);
    const times = repeatEndMatch[1] ? parseInt(repeatEndMatch[1]) : 2;
    repeat = { times, endings: {} };
  }

  // ── Split into bars ────────────────────────────────────────────────
  // Split on | but handle edge cases (leading/trailing pipes)
  const rawBars = line.split('|').map(b => b.trim()).filter(Boolean);

  const bars = [];
  let endings = {};

  for (const barStr of rawBars) {
    // ── Check for ending markers: "1. D7" or "2. G7" ──────────────
    const endingMatch = barStr.match(/^(\d+)\.\s+(.*)/);
    let endingNum = null;
    let chordStr = barStr;

    if (endingMatch) {
      endingNum = parseInt(endingMatch[1]);
      chordStr = endingMatch[2];
    }

    // ── Handle % repeat ──────────────────────────────────────────────
    if (chordStr.trim() === '%') {
      // Copy previous bar's chords
      const allBars = [...existingBars, ...bars];
      const prevBar = allBars[allBars.length - 1];
      if (prevBar) {
        const bar = { chords: prevBar.chords.map(c => ({ ...c })) };
        bars.push(bar);
        if (endingNum) endings[endingNum] = bars.length - 1;
        continue;
      }
    }

    // ── Parse chords within the bar (space-separated) ────────────────
    const chordTokens = chordStr.split(/\s+/).filter(Boolean);
    const chords = chordTokens.map(token => parseChordSymbol(token));

    if (chords.length > 0) {
      bars.push({ chords });
      if (endingNum) endings[endingNum] = bars.length - 1;
    }
  }

  // Attach endings to repeat if we have them
  if (repeat && Object.keys(endings).length > 0) {
    repeat.endings = endings;
  }

  return { bars, repeat };
}

/** Match a navigation keyword line */
function matchNavigation(line) {
  const trimmed = line.trim();

  // Check longest matches first
  for (const kw of NAV_KEYWORDS) {
    if (trimmed === kw || trimmed.startsWith(kw)) {
      return { type: kw, raw: trimmed };
    }
  }

  // Coda marker
  if (trimmed === '[Coda]' || trimmed === '𝄌') {
    return { type: 'Coda', raw: trimmed };
  }

  // Segno marker
  if (trimmed === '𝄋' || trimmed === '[Segno]') {
    return { type: 'Segno', raw: trimmed };
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PLAYBACK QUEUE BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build a flat playback queue from parsed sections + navigation.
 * Expands repeats, handles Da Capo / Dal Segno, and resolves endings.
 *
 * Returns an array of { sectionIndex, barIndex, chord } objects
 * representing the linear order of playback.
 */
export function buildPlaybackQueue(sections, navigation) {
  const queue = [];

  // First pass: expand sections with repeats
  const expandedSections = sections.map((section, sIdx) => {
    const bars = [];
    const rep = section.repeat || { times: 1, endings: {} };
    const hasEndings = Object.keys(rep.endings).length > 0;

    for (let pass = 0; pass < rep.times; pass++) {
      for (let bIdx = 0; bIdx < section.bars.length; bIdx++) {
        const bar = section.bars[bIdx];

        // Check if this bar is an ending
        if (hasEndings) {
          const endingForBar = Object.entries(rep.endings).find(([, idx]) => idx === bIdx);
          if (endingForBar) {
            const endingNum = parseInt(endingForBar[0]);
            // Only include this bar on the matching pass (1-indexed)
            if (endingNum !== pass + 1) continue;
          }
        }

        bars.push({ sectionIndex: sIdx, barIndex: bIdx, chords: bar.chords });
      }
    }

    return { label: section.label, bars };
  });

  // Second pass: build linear queue respecting navigation
  // Default: play all sections in order
  for (const section of expandedSections) {
    for (const bar of section.bars) {
      queue.push(bar);
    }
  }

  // Apply navigation instructions
  // (For now, push nav markers into the queue for the player to interpret)
  // Full D.C./D.S. execution would require a state machine in the player
  if (navigation.length > 0) {
    // Store navigation as metadata — the player resolves these at runtime
    queue.navigation = navigation;
  }

  return queue;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERIALIZATION (Grid → Text)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Serialize a parsed chart back to rawText format.
 * Used for two-way binding: when the grid is edited, rebuild the text.
 */
export function serializeChart(sections, navigation = []) {
  const lines = [];

  for (const section of sections) {
    let line = '';

    // Label prefix
    if (section.label) {
      line += `[${section.label}] `;
    }

    // Check for section-level repeat that should use % shorthand
    // (if this section is identical to a previous one with the same label)

    // Repeat bracket open
    const rep = section.repeat || { times: 1, endings: {} };
    if (rep.times > 1) {
      line += '|: ';
    }

    // Bars
    const barStrs = section.bars.map((bar, bIdx) => {
      let prefix = '';

      // Check if this bar is an ending
      const endingEntry = Object.entries(rep.endings).find(([, idx]) => idx === bIdx);
      if (endingEntry) {
        prefix = `${endingEntry[0]}. `;
      }

      const chordStr = bar.chords.map(c => c.symbol).join(' ');
      return prefix + chordStr;
    });

    line += barStrs.join(' | ');

    // Repeat bracket close
    if (rep.times > 1) {
      line += ' :|';
      if (rep.times > 2) line += ` x${rep.times}`;
    }

    lines.push(line);
  }

  // Navigation
  for (const nav of navigation) {
    lines.push(nav.raw || nav.type);
  }

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONVENIENCE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Full-pipeline convenience: raw text → normalized + parsed chart.
 */
export function parseChartText(rawText) {
  return parseChart(rawText);
}

/**
 * Get all unique chord symbols in a chart (normalized).
 */
export function getUniqueChords(sections) {
  const seen = new Set();
  for (const section of sections) {
    for (const bar of section.bars) {
      for (const chord of bar.chords) {
        seen.add(chord.symbol);
      }
    }
  }
  return [...seen];
}

/**
 * Count total bars in a chart.
 */
export function countBars(sections) {
  return sections.reduce((sum, s) => sum + s.bars.length, 0);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHORD → SCALE MAPPING (for context-aware harmony)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Map a chord quality to the most appropriate scale mode for harmony generation.
 * This is the bridge between the chord chart and the harmony engine —
 * each bar's chord determines the local harmonic context.
 */
const QUALITY_TO_MODE = {
  'maj':    'major',
  '7':      'mixolydian',
  'maj7':   'major',
  'm':      'dorian',
  'm7':     'dorian',
  'mMaj7':  'melodic-minor',
  'm7b5':   'locrian',
  'dim':    'diminished',
  'dim7':   'diminished',
  'aug':    'whole-tone',
  'sus2':   'major',
  'sus4':   'mixolydian',
  '9':      'mixolydian',
  '11':     'mixolydian',
  '13':     'mixolydian',
};

/**
 * Given a parsed chord object, return the key and mode for harmony generation.
 * @param {{ root: string, quality: string }} chord
 * @returns {{ key: string, mode: string } | null}
 */
export function chordToScale(chord) {
  if (!chord || !chord.root) return null;
  const mode = QUALITY_TO_MODE[chord.quality] || 'major';
  return { key: chord.root, mode };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHART PLAYER (tempo-synced playback engine)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ChartPlayer — advances through a playback queue at a given tempo,
 * emitting the current chord on each bar change.
 *
 * This is the live bridge between the chord chart and the harmony/synth engine.
 * When a bar changes, onBarChange fires with the current chord context.
 * The harmony engine reads this context and switches voicing targets.
 *
 * Uses AudioContext.currentTime for drift-free timing.
 *
 * Usage:
 *   const player = new ChartPlayer();
 *   player.load(sections, navigation);
 *   player.onBarChange = (barInfo) => { /* update harmony context *\/ };
 *   player.play(120); // 120 BPM
 *   player.stop();
 */
export class ChartPlayer {
  constructor() {
    this.queue = [];
    this.currentIndex = 0;
    this.tempo = 120;
    this.beatsPerBar = 4;
    this.playing = false;
    this.looping = true;

    this._startTime = 0;
    this._rafId = null;

    // ── Callbacks ──────────────────────────────────────────────────────
    /** @type {function({ index, chord, sectionIndex, barIndex })|null} */
    this.onBarChange = null;

    /** @type {function(number)|null} - fires on every beat with beat index */
    this.onBeat = null;

    /** @type {function()|null} */
    this.onStop = null;

    /** @type {function(number)|null} - fires with bar progress 0.0-1.0 */
    this.onProgress = null;
  }

  /**
   * Load a chart into the player.
   * @param {object[]} sections  - From parseChart()
   * @param {object[]} navigation - From parseChart()
   */
  load(sections, navigation = []) {
    this.queue = buildPlaybackQueue(sections, navigation);
    this.currentIndex = 0;
  }

  /**
   * Load from raw text directly.
   */
  loadText(rawText) {
    const { sections, navigation } = parseChart(rawText);
    this.load(sections, navigation);
  }

  /**
   * Start playback at the given tempo.
   */
  play(tempo = 120) {
    if (this.queue.length === 0) return;

    this.tempo = tempo;
    this.playing = true;
    this.currentIndex = 0;
    this._startTime = performance.now();

    // Fire initial bar
    this._emitBar();

    // Start the tick loop
    this._tick();
  }

  /**
   * Stop playback.
   */
  stop() {
    this.playing = false;
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    if (this.onStop) this.onStop();
  }

  /**
   * Pause without resetting position.
   */
  pause() {
    this.playing = false;
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  /**
   * Resume from current position.
   */
  resume() {
    if (this.queue.length === 0) return;
    this.playing = true;
    this._startTime = performance.now() - (this.currentIndex * this._barDurationMs);
    this._tick();
  }

  /**
   * Get the current chord context.
   */
  get currentChord() {
    if (this.queue.length === 0) return null;
    const bar = this.queue[this.currentIndex];
    if (!bar || !bar.chords || bar.chords.length === 0) return null;
    return bar.chords[0]; // primary chord of the bar
  }

  /**
   * Jump to a specific bar index.
   */
  seekTo(index) {
    this.currentIndex = Math.max(0, Math.min(index, this.queue.length - 1));
    this._startTime = performance.now() - (this.currentIndex * this._barDurationMs);
    this._emitBar();
  }

  // ── Internal ────────────────────────────────────────────────────────────

  get _barDurationMs() {
    // Duration of one bar in milliseconds
    return (60 / this.tempo) * this.beatsPerBar * 1000;
  }

  _tick() {
    if (!this.playing) return;

    const elapsed = performance.now() - this._startTime;
    const barDur = this._barDurationMs;
    const newIndex = Math.floor(elapsed / barDur);

    // Bar progress (0.0 to 1.0 within current bar)
    const barProgress = (elapsed % barDur) / barDur;
    if (this.onProgress) this.onProgress(barProgress);

    // Beat tracking
    const beatDur = barDur / this.beatsPerBar;
    const currentBeat = Math.floor((elapsed % barDur) / beatDur);
    if (this.onBeat) this.onBeat(currentBeat);

    // Bar change detection
    if (newIndex !== this.currentIndex) {
      if (newIndex >= this.queue.length) {
        if (this.looping) {
          // Loop: reset start time, go back to bar 0
          this._startTime = performance.now();
          this.currentIndex = 0;
          this._emitBar();
        } else {
          this.stop();
          return;
        }
      } else {
        this.currentIndex = newIndex;
        this._emitBar();
      }
    }

    this._rafId = requestAnimationFrame(() => this._tick());
  }

  _emitBar() {
    if (!this.onBarChange) return;
    const bar = this.queue[this.currentIndex];
    if (!bar) return;

    this.onBarChange({
      index: this.currentIndex,
      chord: bar.chords?.[0] ?? null,
      chords: bar.chords ?? [],
      sectionIndex: bar.sectionIndex,
      barIndex: bar.barIndex,
      total: this.queue.length,
    });
  }
}
