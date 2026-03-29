# THIRI Chord Intelligence API

**Base URL:** `https://your-server/api/thiri`
**Auth:** Supabase JWT Bearer token (`Authorization: Bearer <token>`)
**Content-Type:** `application/json`

---

## 1. Chord Analysis

**`POST /api/thiri/analyze-chord`**

Parses a chord symbol into root, quality, intervals, extensions, alterations. When a key is provided, returns Roman numeral analysis and harmonic function classification.

### Request

```json
{
  "chord": "Dm7",
  "key": "C"
}
```

| Field   | Type   | Required | Description                                      |
|---------|--------|----------|--------------------------------------------------|
| `chord` | string | Yes      | Chord symbol (e.g. `"Dm7"`, `"Bbmaj7"`, `"F#m7b5"`, `"Cmaj7/E"`) |
| `key`   | string | No       | Key center for Roman numeral analysis (e.g. `"C"`, `"Gm"`) |

### Response (with key)

```json
{
  "symbol": "Dm7",
  "root": "D",
  "rootIndex": 2,
  "suffix": "m7",
  "quality": "minor7",
  "intervals": [0, 3, 7, 10],
  "has7th": true,
  "seventhInterval": 10,
  "thirdInterval": 3,
  "fifthInterval": 7,
  "extensions": [],
  "alterations": [],
  "bassNote": null,
  "numeral": "ii",
  "degree": 2,
  "diatonic": true,
  "function": "predominant"
}
```

### Response (without key)

Same as above but without `numeral`, `degree`, `diatonic`, `function`.

### Field Reference

| Field              | Type       | Description                                         |
|--------------------|------------|-----------------------------------------------------|
| `symbol`           | string     | Original chord symbol                               |
| `root`             | string     | Root note name (`"C"`, `"Db"`, etc.)                |
| `rootIndex`        | number     | Root as pitch class (0–11)                          |
| `suffix`           | string     | Everything after the root (`"m7"`, `"maj7#11"`)     |
| `quality`          | string     | Classification — see Quality Types below            |
| `intervals`        | number[]   | Semitone intervals from root                        |
| `has7th`           | boolean    | Whether chord contains a 7th                        |
| `seventhInterval`  | number?    | 7th interval (9=dim7, 10=b7, 11=maj7)              |
| `thirdInterval`    | number?    | 3rd interval (3=minor, 4=major)                     |
| `fifthInterval`    | number?    | 5th interval (6=b5, 7=P5, 8=#5)                    |
| `extensions`       | number[]   | Upper extensions (9=14, 11=17, 13=21, alterations)  |
| `alterations`      | string[]   | Present alterations (`"b9"`, `"#11"`, `"b13"`, etc.)|
| `bassNote`         | string?    | Slash chord bass note (`"E"` in `"Cmaj7/E"`)        |
| `numeral`          | string     | Roman numeral (`"ii"`, `"V"`, `"bVII"`)             |
| `degree`           | number     | Scale degree (1–7)                                  |
| `diatonic`         | boolean    | Whether chord is diatonic to the key                |
| `function`         | string     | Harmonic function — see below                       |

### Quality Types

`major` · `minor` · `dominant` · `diminished` · `half-diminished` · `augmented` · `sus4` · `sus2` · `major7` · `minor7` · `dominant7` · `minor-major7` · `dim7` · `augmented7`

### Harmonic Functions

`tonic` (I, iii, vi) · `subdominant` (IV) · `predominant` (ii) · `dominant` (V, vii, any dom7)

### Special Input Handling

| Input    | Behavior                        |
|----------|---------------------------------|
| `%`      | Repeat — returns empty/default  |
| `N.C.`   | No chord — returns empty        |
| `Δ` / `Δ7` | Normalized to `maj7`         |
| `°`      | Normalized to `dim`             |
| `ø` / `Ø` | Normalized to `m7b5`          |

---

## 2. Chord Resolver

**`POST /api/thiri/resolve-chord`**

Resolves a chord symbol to spelled-out notes, frequencies, MIDI numbers, and recommended scales. Uses pre-computed harmony data from the WoodShed spelling engine.

### Request

```json
{
  "chord": "Cm7"
}
```

| Field   | Type   | Required | Description                          |
|---------|--------|----------|--------------------------------------|
| `chord` | string | Yes      | Chord symbol (e.g. `"Cm7"`, `"F#dim7"`) |

### Response

```json
{
  "root": "C",
  "quality": "m7",
  "notes": ["C", "Eb", "G", "Bb"],
  "intervals": ["1", "b3", "5", "b7"],
  "semitones": [0, 3, 7, 10],
  "frequencies": [261.63, 311.13, 392.0, 466.16],
  "midi": [60, 63, 67, 70],
  "scales": ["dorian", "aeolian", "phrygian"]
}
```

### Field Reference

| Field         | Type     | Description                                          |
|---------------|----------|------------------------------------------------------|
| `root`        | string   | Root note name                                       |
| `quality`     | string   | Normalized chord quality                             |
| `notes`       | string[] | Spelled note names                                   |
| `intervals`   | string[] | Interval names (`"1"`, `"b3"`, `"5"`, `"b7"`)       |
| `semitones`   | number[] | Semitone offsets from root                           |
| `frequencies` | number[] | Frequencies in Hz (concert pitch, A4=440)            |
| `midi`        | number[] | MIDI note numbers                                    |
| `scales`      | string[] | Recommended scales for improvisation                 |

### Quality Aliases

| Input             | Normalized To |
|-------------------|---------------|
| `""`, `"M"`, `"maj"` | `maj`      |
| `"M7"`, `"Δ7"`, `"Δ"` | `maj7`   |
| `"-"`, `"min"`    | `m`           |
| `"-7"`, `"min7"`  | `m7`          |
| `"ø7"`, `"ø"`, `"-7b5"` | `m7b5` |
| `"°7"`            | `dim7`        |
| `"°"`             | `dim`         |
| `"+"`             | `aug`         |
| `"dom7"`          | `7`           |

### Error

Returns `404` if chord not found in the pre-computed dictionary.

---

## 3. Voicing Generator

**`POST /api/thiri/generate-voicing`**

Generates piano-style voicings for a chord in a specified style. Supports voice leading from a previous voicing.

### Request

```json
{
  "chord": "Dm7",
  "style": "rootless",
  "octave": 3,
  "previousNotes": ["E3", "G3", "Bb3", "D4"]
}
```

| Field           | Type     | Required | Default     | Description                              |
|-----------------|----------|----------|-------------|------------------------------------------|
| `chord`         | string   | Yes      | —           | Chord symbol                             |
| `style`         | string   | No       | `"pad"`     | Voicing style — see below                |
| `octave`        | number   | No       | `3`         | Base octave for voicing                  |
| `previousNotes` | string[] | No       | —           | Previous voicing for voice leading       |

### Response

```json
{
  "notes": ["F3", "A3", "C4", "E4"],
  "style": "rootless",
  "chord": "Dm7"
}
```

### Voicing Styles

| Style      | Description                                                    |
|------------|----------------------------------------------------------------|
| `rootless` | Jazz A/B forms (3-5-7-9 or 7-9-3-5). Auto-selects A-form for roots C–F, B-form for F#–B. |
| `shell`    | Root + 3rd + 7th only. Economical comping.                     |
| `drop2`    | Rootless A-form with 2nd-from-top note dropped down an octave. |
| `drop3`    | Rootless A-form with 3rd-from-top note dropped down an octave. |
| `pad`      | Basic interval stacking (close position).                      |
| `triad`    | Basic interval stacking (close position).                      |

### Voice Leading

When `previousNotes` is provided, the engine computes the average MIDI pitch of both voicings and shifts the new voicing up/down by octave to minimize the average distance. This prevents jarring register jumps during chord changes.

---

## 4. Reharmonization

**`POST /api/thiri/reharmonize`**

Analyzes a chord progression and generates reharmonization suggestions using rule-based jazz harmony. Returns per-bar suggestions plus complete alternative progressions.

### Request

```json
{
  "bars": ["Cmaj7", "Dm7", "G7", "Cmaj7"],
  "key": "C"
}
```

| Field  | Type     | Required | Description                          |
|--------|----------|----------|--------------------------------------|
| `bars` | string[] | Yes      | Array of chord symbols (one per bar) |
| `key`  | string   | Yes      | Key center (e.g. `"C"`, `"Gm"`)     |

### Response

```json
{
  "original": ["Cmaj7", "Dm7", "G7", "Cmaj7"],
  "key": "C",
  "suggestions": {
    "0": [
      {
        "strategy": "secondary-dominant",
        "name": "Secondary Dominant (V7/ii)",
        "chords": ["A7"],
        "explanation": "A7 is the V7 of Dm7. It creates stronger forward motion...",
        "adventurousness": 2,
        "genres": ["jazz", "pop", "gospel", "blues"],
        "barIndex": 0,
        "spanBars": 1
      }
    ],
    "2": [
      {
        "strategy": "tritone-sub",
        "name": "Tritone Substitution",
        "chords": ["Db7"],
        "explanation": "G7 and Db7 share the same tritone (guide tones)...",
        "adventurousness": 3,
        "genres": ["jazz", "bebop", "neo-soul"],
        "barIndex": 2,
        "spanBars": 1
      },
      {
        "strategy": "backdoor-ii-V",
        "name": "Backdoor ii-V (iv → bVII7)",
        "chords": ["Fm7", "Bb7"],
        "explanation": "Fm7 → Bb7 → Cmaj7 is the backdoor resolution...",
        "adventurousness": 5,
        "genres": ["jazz", "neo-soul", "pop"],
        "barIndex": 2,
        "spanBars": 1
      }
    ]
  },
  "alternatives": [
    {
      "name": "Tritone Subs",
      "description": "All dominant 7th chords get their tritone substitutions. Chromatic bass motion everywhere.",
      "bars": ["Cmaj7", "Dm7", "Db7", "Cmaj7"],
      "adventurousness": 4
    },
    {
      "name": "ii-V Motion",
      "description": "Static harmony replaced with ii-V approaches — constant forward motion like a classic bebop arrangement.",
      "bars": ["Am7", "Am7", "Dm7", "Cmaj7"],
      "adventurousness": 4
    },
    {
      "name": "Dark Mode (Modal Interchange)",
      "description": "Borrowed chords from the parallel minor — darker, more emotional coloring.",
      "bars": ["Cmaj7", "Fm7", "G7", "Cmaj7"],
      "adventurousness": 5
    },
    {
      "name": "The Works",
      "description": "A curated mix of the most musical substitutions — tritone subs, chromatic approaches, and modal interchange combined.",
      "bars": ["Cmaj7", "Fm7", "Db7", "Cmaj7"],
      "adventurousness": 6
    }
  ]
}
```

### Suggestion Fields

| Field             | Type     | Description                                              |
|-------------------|----------|----------------------------------------------------------|
| `strategy`        | string   | Strategy identifier — see Strategies table               |
| `name`            | string   | Human-readable technique name                            |
| `chords`          | string[] | Replacement chord(s) — may expand 1 bar into 2+ chords  |
| `explanation`     | string   | Why this works (learning content for the musician)        |
| `adventurousness` | number   | How "out" the substitution is (1–10 scale)               |
| `genres`          | string[] | Where this sub sounds most natural                       |
| `barIndex`        | number   | Which bar is being replaced                              |
| `spanBars`        | number   | How many original bars this suggestion covers             |

### Reharmonization Strategies

| Strategy              | Description                                          | Adventurousness |
|-----------------------|------------------------------------------------------|:---------------:|
| `tritone-sub`         | Replace dom7 with dom7 a tritone away                | 3               |
| `secondary-dominant`  | V7 of the next chord                                 | 2               |
| `related-ii-V`        | Expand into ii–V targeting next chord                | 3               |
| `modal-interchange`   | Borrow from parallel minor/major                     | 4–5             |
| `diminished-passing`  | Chromatic dim7 between whole-step root motion         | 3               |
| `chromatic-approach`  | Dom7 a half-step above target (bII7)                 | 4               |
| `backdoor-ii-V`       | iv-m7 → bVII7 → I instead of V7 → I                 | 5               |
| `line-cliché`         | Descending chromatic inner voice on minor chords      | 3               |
| `coltrane-changes`    | *(defined, not yet implemented)*                     | —               |
| `upper-structure`     | *(defined, not yet implemented)*                     | —               |
| `pedal-point`         | *(defined, not yet implemented)*                     | —               |

### Pre-Built Alternatives

The engine auto-generates up to 4 complete reharmonized progressions:

| Name                          | Strategy                              | Adventurousness |
|-------------------------------|---------------------------------------|:---------------:|
| **Tritone Subs**              | All dom7 chords get tritone subs      | 4               |
| **ii-V Motion**               | Static chords → ii-V approaches       | 4               |
| **Dark Mode (Modal Interchange)** | Minor-borrowed chords              | 5               |
| **The Works**                 | Curated mix of best substitutions     | 6               |

---

## Source Engines

| Endpoint             | WoodShed Engine File              | Entry Function                    |
|----------------------|-----------------------------------|-----------------------------------|
| `/analyze-chord`     | `src/lib/chordAnalysis.ts`        | `analyzeChord()`, `analyzeHarmony()` |
| `/resolve-chord`     | `src/lib/harmonyEngine.ts`        | `resolveChord()`                  |
| `/generate-voicing`  | `src/lib/voicingEngine.ts`        | `VoicingEngine.getVoicing()`      |
| `/reharmonize`       | `src/lib/reharmonizationEngine.ts`| `reharmonize()`                   |

---

*Copyright 2026 Blues Prince Media. PATENT PENDING.*
