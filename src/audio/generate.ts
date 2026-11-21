import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Original instrumental tracks from ElevenLabs Music (POST /v1/music,
 * verified 2026-11-21). The prompt is stored with the sound so a track that
 * performs well can be used as the starting point for the next ones.
 * Needs ELEVENLABS_API_KEY. Check the plan's terms for commercial use.
 */
export const HOOK_FIRST = "starts immediately on the main hook at full energy, no intro, no vocals";

export function variationPrompt(basePrompt: string, n: number): string {
  const twists = [
    "same style and tempo, a different equally catchy lead melody",
    "same style, slightly faster and brighter, new hook",
    "same groove and instruments, new chord progression and hook",
    "same energy, swap the lead instrument, keep the rhythm",
  ];
  return `${basePrompt}. Variation: ${twists[n % twists.length]}`;
}

export async function generateTrack(prompt: string, out: string, opts: { seconds?: number; apiKey?: string; fetchImpl?: typeof fetch } = {}) {
  const key = opts.apiKey ?? process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("track generation needs ELEVENLABS_API_KEY in the environment");
  const res = await (opts.fetchImpl ?? fetch)("https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128", {
    method: "POST",
    headers: { "Content-Type": "application/json", "xi-api-key": key },
    body: JSON.stringify({ prompt, music_length_ms: Math.round((opts.seconds ?? 22) * 1000), model_id: "music_v1" }),
  });
  if (!res.ok) throw new Error(`ElevenLabs music HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, buf);
  return buf.length;
}
