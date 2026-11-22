import { execFileSync } from "node:child_process";

/**
 * Local tempo estimate, no external services: decode to mono PCM with ffmpeg,
 * build an onset-strength envelope, and pick the tempo whose beat grid lines
 * up best with the onsets. Good enough to snap video length to whole bars and
 * land the final hold on a beat; explicit `beats` in the sound entry override it.
 */
export function detectBeat(file: string, minBpm = 80, maxBpm = 180): { bpm: number; offsetSec: number; confidence: number } {
  const sr = 11025;
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", String(sr), "-f", "s16le", "-"], { maxBuffer: 1 << 28 });
  const n = Math.floor(raw.length / 2);
  const hop = 128;
  const frames = Math.floor(n / hop);
  const rate = sr / hop; // envelope samples per second
  const energy = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = 0; i < hop; i++) {
      const v = raw.readInt16LE((f * hop + i) * 2) / 32768;
      e += v * v;
    }
    energy[f] = Math.log1p(e * 50);
  }
  const onset = new Float64Array(frames);
  for (let f = 1; f < frames; f++) onset[f] = Math.max(0, energy[f] - energy[f - 1]);
  const mean = onset.reduce((a, b) => a + b, 0) / frames || 1;

  // score a tempo by how much onset energy sits on its beat grid, best phase
  const score = (bpm: number) => {
    const period = (60 / bpm) * rate;
    let best = 0;
    let bestPhase = 0;
    const steps = Math.max(1, Math.floor(period));
    for (let p = 0; p < steps; p++) {
      let s = 0;
      let k = 0;
      for (let t = p; t < frames - 1; t += period, k++) {
        const i = Math.round(t);
        s += Math.max(onset[i - 1] ?? 0, onset[i], onset[i + 1] ?? 0);
      }
      s /= Math.max(1, k);
      if (s > best) (best = s), (bestPhase = p);
    }
    return { s: best / mean, phase: bestPhase / rate };
  };
  let top = { bpm: 120, s: 0, phase: 0 };
  for (let bpm = minBpm; bpm <= maxBpm; bpm += 0.5) {
    const r = score(bpm);
    if (r.s > top.s) top = { bpm, s: r.s, phase: r.phase };
  }
  return { bpm: top.bpm, offsetSec: +top.phase.toFixed(3), confidence: +top.s.toFixed(2) };
}
