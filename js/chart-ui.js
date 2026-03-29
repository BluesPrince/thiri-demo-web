/**
 * chart-ui.js — THIRI Chord Chart UI
 * ====================================
 * Two-way binding between text input and visual grid.
 *
 *   Text input → parseChart() → render grid
 *   Grid cell click → edit → serializeChart() → update text input
 *
 * The grid is a 4-column bar layout with section headers,
 * repeat brackets, and chord tone display.
 *
 * Copyright 2026 Blues Prince Media. PATENT PENDING.
 */

import {
  parseChart,
  serializeChart,
  normalizeChord,
  parseChordSymbol,
  buildPlaybackQueue,
  getUniqueChords,
  countBars,
  FORM_LABELS,
} from './chord.js';

import { NOTE_MAP, NOTE_NAMES_FLAT } from './scales.js';

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

let chartState = {
  rawText: '',
  sections: [],
  navigation: [],
  playbackQueue: [],
  barsPerRow: 4,
  showNotes: false,
  loopEnabled: false,
  isPlaying: false,
  playheadIndex: -1,   // index into playbackQueue
  tempo: 120,
  editingCell: null,    // { sectionIdx, barIdx } when user is editing a grid cell
};

let debounceTimer = null;
let onChartChange = null; // callback for main.js to receive chart updates

// ═══════════════════════════════════════════════════════════════════════════════
// DOM
// ═══════════════════════════════════════════════════════════════════════════════

const $ = id => document.getElementById(id);

// ═══════════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Initialize the chart UI. Call once on DOMContentLoaded.
 * @param {Function} onChange - callback(sections, navigation, playbackQueue)
 */
export function initChartUI(onChange) {
  onChartChange = onChange;
  wireChartControls();
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEXT → GRID (parse on every keystroke, debounced)
// ═══════════════════════════════════════════════════════════════════════════════

function onTextInput() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const rawText = $('chartInput').value;
    chartState.rawText = rawText;
    const { sections, navigation } = parseChart(rawText);
    chartState.sections = sections;
    chartState.navigation = navigation;
    chartState.playbackQueue = buildPlaybackQueue(sections, navigation);
    renderGrid();
    notifyChange();
  }, 200);
}

// ═══════════════════════════════════════════════════════════════════════════════
// GRID → TEXT (edit a cell, serialize back)
// ═══════════════════════════════════════════════════════════════════════════════

function onCellEdit(sectionIdx, barIdx, newValue) {
  const section = chartState.sections[sectionIdx];
  if (!section || !section.bars[barIdx]) return;

  // Parse the new value into chords
  const tokens = newValue.trim().split(/\s+/).filter(Boolean);
  const chords = tokens.map(t => parseChordSymbol(t));
  section.bars[barIdx].chords = chords;

  // Rebuild text from sections
  const newText = serializeChart(chartState.sections, chartState.navigation);
  chartState.rawText = newText;
  $('chartInput').value = newText;

  // Re-parse to keep everything in sync
  const { sections, navigation } = parseChart(newText);
  chartState.sections = sections;
  chartState.navigation = navigation;
  chartState.playbackQueue = buildPlaybackQueue(sections, navigation);

  renderGrid();
  notifyChange();
}

// ═══════════════════════════════════════════════════════════════════════════════
// RENDER GRID
// ═══════════════════════════════════════════════════════════════════════════════

function renderGrid() {
  const grid = $('chartGrid');
  if (!grid) return;
  grid.innerHTML = '';

  if (chartState.sections.length === 0) {
    grid.innerHTML = '<div class="chart-empty">Type a chord chart above</div>';
    return;
  }

  for (let sIdx = 0; sIdx < chartState.sections.length; sIdx++) {
    const section = chartState.sections[sIdx];

    // Section header
    if (section.label) {
      const header = document.createElement('div');
      header.className = 'chart-section-header';
      const isKnown = FORM_LABELS.has(section.label);
      header.classList.add(isKnown ? 'chart-label-known' : 'chart-label-custom');
      header.textContent = section.label;
      header.addEventListener('click', () => scrollToSection(sIdx));
      grid.appendChild(header);
    }

    // Repeat bracket open
    const rep = section.repeat || { times: 1 };
    if (rep.times > 1) {
      const bracket = document.createElement('div');
      bracket.className = 'chart-repeat-start';
      bracket.innerHTML = '<span class="repeat-dots">𝄆</span>';
      grid.appendChild(bracket);
    }

    // Bar cells in rows of barsPerRow
    const barRow = document.createElement('div');
    barRow.className = 'chart-bar-row';
    barRow.style.gridTemplateColumns = `repeat(${chartState.barsPerRow}, 1fr)`;
    grid.appendChild(barRow);

    for (let bIdx = 0; bIdx < section.bars.length; bIdx++) {
      const bar = section.bars[bIdx];
      const cell = createBarCell(sIdx, bIdx, bar);
      barRow.appendChild(cell);

      // Start new row after barsPerRow
      if ((bIdx + 1) % chartState.barsPerRow === 0 && bIdx < section.bars.length - 1) {
        const newRow = document.createElement('div');
        newRow.className = 'chart-bar-row';
        newRow.style.gridTemplateColumns = `repeat(${chartState.barsPerRow}, 1fr)`;
        grid.appendChild(newRow);
        // Re-point barRow (for subsequent cells)
        grid._currentRow = newRow;
      }
    }

    // Repeat bracket close
    if (rep.times > 1) {
      const bracket = document.createElement('div');
      bracket.className = 'chart-repeat-end';
      bracket.innerHTML = `<span class="repeat-dots">𝄇</span>${rep.times > 2 ? ` x${rep.times}` : ''}`;
      grid.appendChild(bracket);
    }
  }

  // Update bar count display
  const countEl = $('chartBarCount');
  if (countEl) countEl.textContent = countBars(chartState.sections);
}

function createBarCell(sIdx, bIdx, bar) {
  const cell = document.createElement('div');
  cell.className = 'chart-bar-cell';
  cell.dataset.section = sIdx;
  cell.dataset.bar = bIdx;

  // Bar number
  const numEl = document.createElement('span');
  numEl.className = 'bar-number';
  // Compute global bar number
  let globalBar = bIdx + 1;
  for (let i = 0; i < sIdx; i++) {
    globalBar += chartState.sections[i].bars.length;
  }
  numEl.textContent = globalBar;
  cell.appendChild(numEl);

  // Chord symbols
  const chordEl = document.createElement('div');
  chordEl.className = 'bar-chords';
  chordEl.textContent = bar.chords.map(c => c.symbol).join('  ');
  cell.appendChild(chordEl);

  // Chord tones (if showNotes is on)
  if (chartState.showNotes && bar.chords.length > 0) {
    const tonesEl = document.createElement('div');
    tonesEl.className = 'bar-tones';
    const first = bar.chords[0];
    const tones = getChordTones(first);
    if (tones) tonesEl.textContent = tones;
    cell.appendChild(tonesEl);
  }

  // Playhead highlight
  if (chartState.isPlaying && chartState.playheadIndex >= 0) {
    const qItem = chartState.playbackQueue[chartState.playheadIndex];
    if (qItem && qItem.sectionIndex === sIdx && qItem.barIndex === bIdx) {
      cell.classList.add('chart-bar-active');
    }
  }

  // Click to edit
  cell.addEventListener('dblclick', () => startCellEdit(cell, sIdx, bIdx, bar));

  return cell;
}

/** Get chord tones as a display string, e.g. "Bb Db F Ab" */
function getChordTones(chord) {
  if (!chord.root) return null;
  const rootPC = NOTE_MAP[chord.root];
  if (rootPC === undefined) return null;

  // Basic chord tone intervals based on quality
  const intervals = QUALITY_INTERVALS[chord.quality] || [0, 4, 7]; // default major triad
  return intervals.map(i => NOTE_NAMES_FLAT[(rootPC + i) % 12]).join(' ');
}

/** Semitone intervals for common chord qualities */
const QUALITY_INTERVALS = {
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
  '13':     [0, 4, 7, 10, 14, 21],
};

// ═══════════════════════════════════════════════════════════════════════════════
// INLINE CELL EDITING
// ═══════════════════════════════════════════════════════════════════════════════

function startCellEdit(cell, sIdx, bIdx, bar) {
  if (chartState.editingCell) return; // already editing

  chartState.editingCell = { sectionIdx: sIdx, barIdx: bIdx };
  const currentText = bar.chords.map(c => c.symbol).join(' ');

  cell.innerHTML = '';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'chart-cell-input';
  input.value = currentText;
  cell.appendChild(input);
  input.focus();
  input.select();

  const commit = () => {
    chartState.editingCell = null;
    onCellEdit(sIdx, bIdx, input.value);
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { input.blur(); }
    if (e.key === 'Escape') {
      chartState.editingCell = null;
      renderGrid(); // revert
    }
    // Tab to next bar
    if (e.key === 'Tab') {
      e.preventDefault();
      commit();
      // Focus next cell after re-render
      setTimeout(() => {
        const nextBar = bIdx + 1;
        const section = chartState.sections[sIdx];
        if (section && nextBar < section.bars.length) {
          const nextCell = document.querySelector(
            `.chart-bar-cell[data-section="${sIdx}"][data-bar="${nextBar}"]`
          );
          if (nextCell) nextCell.dispatchEvent(new Event('dblclick'));
        }
      }, 50);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCROLL TO SECTION (label click in grid → cursor in text)
// ═══════════════════════════════════════════════════════════════════════════════

function scrollToSection(sIdx) {
  const section = chartState.sections[sIdx];
  if (!section?.label) return;

  const input = $('chartInput');
  const text = input.value;
  const searchStr = `[${section.label}]`;
  const idx = text.indexOf(searchStr);
  if (idx >= 0) {
    input.focus();
    input.setSelectionRange(idx, idx + searchStr.length);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONTROLS WIRING
// ═══════════════════════════════════════════════════════════════════════════════

function wireChartControls() {
  // Text input
  const input = $('chartInput');
  if (input) {
    input.addEventListener('input', onTextInput);
  }

  // Bars-per-row buttons
  const barsGroup = $('chartBarsGroup');
  if (barsGroup) {
    barsGroup.querySelectorAll('[data-bars]').forEach(btn => {
      btn.addEventListener('click', e => {
        chartState.barsPerRow = parseInt(e.currentTarget.dataset.bars);
        barsGroup.querySelectorAll('[data-bars]').forEach(b => b.classList.remove('active'));
        e.currentTarget.classList.add('active');
        renderGrid();
      });
    });
  }

  // Loop toggle
  const loopBtn = $('chartLoopBtn');
  if (loopBtn) {
    loopBtn.addEventListener('click', () => {
      chartState.loopEnabled = !chartState.loopEnabled;
      loopBtn.classList.toggle('active', chartState.loopEnabled);
    });
  }

  // Notes toggle
  const notesBtn = $('chartNotesBtn');
  if (notesBtn) {
    notesBtn.addEventListener('click', () => {
      chartState.showNotes = !chartState.showNotes;
      notesBtn.classList.toggle('active', chartState.showNotes);
      renderGrid();
    });
  }

  // Tempo slider
  const tempoInput = $('chartTempo');
  if (tempoInput) {
    tempoInput.addEventListener('input', e => {
      chartState.tempo = parseInt(e.target.value);
      const tempoVal = $('chartTempoVal');
      if (tempoVal) tempoVal.textContent = chartState.tempo;
    });
  }
}

function notifyChange() {
  if (onChartChange) {
    onChartChange(chartState.sections, chartState.navigation, chartState.playbackQueue);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PLAYHEAD (for future loop player integration)
// ═══════════════════════════════════════════════════════════════════════════════

/** Advance playhead to a specific queue index. Called by the player. */
export function setPlayhead(index) {
  chartState.playheadIndex = index;
  chartState.isPlaying = index >= 0;
  renderGrid();
}

/** Get current chart state (for session logging, etc.) */
export function getChartState() {
  return { ...chartState };
}

/** Programmatically set chart text (e.g., loading from a saved session) */
export function setChartText(text) {
  $('chartInput').value = text;
  chartState.rawText = text;
  const { sections, navigation } = parseChart(text);
  chartState.sections = sections;
  chartState.navigation = navigation;
  chartState.playbackQueue = buildPlaybackQueue(sections, navigation);
  renderGrid();
  notifyChange();
}
