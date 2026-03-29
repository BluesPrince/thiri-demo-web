# THIRI — Live Vocal Harmonizer POC

**WoodShed chord intelligence engine + real-time vocal harmonization.**

## Quick Start

```bash
cd thiri-poc
npx serve .
```

Open `http://localhost:3000` in Chrome. Allow mic access. Sing.

## How It Works

```
Mic → YIN pitch detection → WoodShed harmony engine → Web Audio oscillators → Speakers
```

1. **Pitch detection** (`pitch.js`) — YIN autocorrelation identifies your sung note in real time
2. **Harmony engine** (`harmony.js`) — calculates diatonic harmony notes based on key, mode, and voicing type
3. **Synthesis** (`synth.js`) — plays those harmony notes as oscillator tones through your speakers

Your dry voice passes through a separate signal path so it doesn't feed back into pitch detection.

## Controls

| Control | Description |
|---|---|
| KEY | Root note of the scale (C, Db, D … B) |
| MODE | Scale mode — Major, Dorian, Mixolydian, etc. |
| VOICES | Number of harmony voices (1–4) |
| VOICING | Close (3rds), Open (spread), Drop-2, Parallel |
| DIRECTION | Above / Below / Around the lead note |
| MIX | Dry (voice only) ↔ Wet (harmony only) |
| Per-voice | Waveform, detune (chorus thickness), volume |
| FM Mode | Switches oscillators to FM synthesis for organ/brass timbre |

## File Structure

```
thiri-poc/
├── index.html          — App layout
├── css/style.css       — Studio dark UI
└── js/
    ├── scales.js       — Music theory (ported from WoodShed harmonySpelling.ts)
    ├── pitch.js        — YIN pitch detection
    ├── harmony.js      — Diatonic harmony resolver (WoodShed seed)
    ├── synth.js        — Web Audio oscillator synthesis
    └── main.js         — App wiring + UI
```

## WoodShed Alignment

`scales.js` and `harmony.js` are the vanilla JS seed of the WoodShed chord intelligence layer:
- Same `SCALE_FORMULAS`, `NOTE_MAP`, `PITCH_MAP` as `harmonySpelling.ts`
- Same Drop-2 logic as `voicingEngine.ts`
- Same `midiToFreq`/`freqToMidi` as `harmonyEngine.ts`
- `smoothVoiceTransition()` mirrors `voiceLeadingOptimizer.ts` greedy matching

## Upgrade Path

| Phase | Renderer | Sound |
|---|---|---|
| POC (now) | Oscillators | Sine/triangle waves |
| Phase 2 | PSOLA/phase vocoder | Your actual voice pitch-shifted |
| Phase 3 | Qwen3-TTS / XTTS-v2 | Cloned vocal ensemble |

Copyright 2026 Blues Prince Media. PATENT PENDING.
