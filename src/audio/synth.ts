import { rng } from "../engine/util.ts";

/**
 * Tiny procedural beat generator. Everything here is synthesised from maths —
 * no samples, no third-party recordings — so the output is ours to embed and
 * upload. It exists so beat-synced samples can ship with audio before any
 * licensed tracks are supplied; it is not meant to replace real music.
 */
export function synthBeat(opts: { bpm: number; seconds: number; seed: number; offsetSec?: number }): Buffer {
  const sr = 44100;
  const n = Math.ceil(opts.seconds * sr);
  const out = new Float32Array(n);
  const beat = 60 / opts.bpm;
  const off = opts.offsetSec ?? 0;
  const r = rng(opts.seed);
  const scale = [0, 3, 5, 7, 10, 12, 15]; // minor pentatonic-ish
  const root = 43 + Math.floor(r() * 5); // G1..B1
  const prog = [0, 0, 5, 3].map((p) => (r() < 0.25 ? p + 2 : p));
  const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);
  const noise = rng(opts.seed ^ 0x9e3779b9);

  const add = (t0: number, dur: number, fn: (t: number) => number) => {
    const i0 = Math.max(0, Math.floor(t0 * sr));
    const i1 = Math.min(n, Math.floor((t0 + dur) * sr));
    for (let i = i0; i < i1; i++) out[i] += fn((i - i0) / sr);
  };

  const beats = Math.ceil((opts.seconds - off) / beat);
  for (let b = 0; b < beats; b++) {
    const t0 = off + b * beat;
    const chord = prog[Math.floor(b / 4) % prog.length];
    // kick
    add(t0, 0.32, (t) => {
      // pitch sweeps 156Hz -> 46Hz; phase is the integral of that sweep
      return Math.sin(2 * Math.PI * (46 * t + (110 / 28) * (1 - Math.exp(-t * 28)))) * Math.exp(-t * 9) * 0.9;
    });
    // clap/snare on 2 and 4
    if (b % 2 === 1) add(t0, 0.18, (t) => (noise() * 2 - 1) * Math.exp(-t * 26) * 0.32);
    // hats on 8ths
    for (const h of [0, 0.5]) add(t0 + h * beat, 0.05, (t) => (noise() * 2 - 1) * Math.exp(-t * 90) * (h ? 0.16 : 0.08));
    // bass
    const bf = hz(root + chord);
    add(t0 + beat * 0.5, beat * 0.45, (t) => Math.tanh(Math.sin(2 * Math.PI * bf * t) * 2.2) * Math.exp(-t * 5) * 0.3);
    // pluck arpeggio on 8ths
    for (let k = 0; k < 2; k++) {
      const note = root + 24 + chord + scale[Math.floor(r() * scale.length)];
      const f = hz(note);
      add(t0 + k * beat * 0.5, beat * 0.48, (t) => {
        const e = Math.exp(-t * 9);
        return (Math.sin(2 * Math.PI * f * t) + 0.35 * Math.sin(4 * Math.PI * f * t)) * e * 0.14;
      });
    }
  }

  // soft clip + short fades, 16-bit stereo WAV
  const fade = Math.floor(0.12 * sr);
  const pcm = Buffer.alloc(44 + n * 4);
  pcm.write("RIFF", 0);
  pcm.writeUInt32LE(36 + n * 4, 4);
  pcm.write("WAVEfmt ", 8);
  pcm.writeUInt32LE(16, 16);
  pcm.writeUInt16LE(1, 20);
  pcm.writeUInt16LE(2, 22);
  pcm.writeUInt32LE(sr, 24);
  pcm.writeUInt32LE(sr * 4, 28);
  pcm.writeUInt16LE(4, 32);
  pcm.writeUInt16LE(16, 34);
  pcm.write("data", 36);
  pcm.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const g = Math.min(1, i / 200, (n - i) / fade);
    const v = Math.round(Math.tanh(out[i] * 1.1) * g * 30000);
    pcm.writeInt16LE(v, 44 + i * 4);
    pcm.writeInt16LE(v, 46 + i * 4);
  }
  return pcm;
}
