# THIRI Demo Web

> Browser-based real-time vocal harmonizer demo powered by Web Audio API

## What It Does

Interactive web demo of the THIRI vocal harmonizer. Sing into your mic and hear real-time diatonic harmonies generated on the fly. Features YIN pitch detection, formant-preserving vocoder, jazz voice leading, chord pads, an arpeggiator, drum machine, and live notation display. This is the public-facing proof of concept at thiri.ai.

## Tech Stack

- **Audio:** Web Audio API (AudioWorklet for pitch shifting)
- **Pitch Detection:** YIN algorithm
- **Synthesis:** Custom vocoder, multi-oscillator synth
- **Frontend:** Vanilla HTML/CSS/JS — no framework, no bundler
- **Hosting:** Vercel (static)

## Setup

```bash
# No build step — static files
npx serve .
# Or deploy to Vercel:
vercel
```

Open `http://localhost:3000` in Chrome. Allow mic access. Sing.

## Architecture

```
js/
  pitch.js              YIN pitch detection
  harmony.js            Diatonic harmony generation + voice leading
  synth.js              Multi-oscillator synthesizer
  vocoder-voice.js      Formant-preserving vocoder
  chord-pads.js         Interactive chord pad grid (diatonic + V7 + ii-V)
  arp.js                Arpeggiator
  drums.js              Drum machine
  notation.js           Live notation display
  scales.js             Scale/mode definitions
  pitch-shifter-worklet.js  AudioWorklet pitch shifter
  midi.js               MIDI input support
  api.js / auth.js      License verification
css/style.css           Styling
demo/                   Standalone demo page
```

## Features (v1.2)

- Real-time pitch detection and harmony generation
- Formant-preserving vocoder voice processing
- Chord pad grid with diatonic, V7, and ii-V voicings
- Tritone substitution and dominant function toggles
- Jazz voice leading rules (minor-9th avoidance, smooth motion)
- Arpeggiator and drum machine
- Live notation display
- MIDI controller input

## WoodShed Alignment

`scales.js` and `harmony.js` are the vanilla JS seed of the WoodShed chord intelligence layer — same scale formulas, Drop-2 logic, and voice leading optimizer as the TypeScript engine.

## Status

Live at thiri.ai — version 1.2.

## License

Private — Blues Prince Media. PATENT PENDING.
