import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadLibrary, pickSound, resolveAudio } from "./audio/library.ts";
import { fileSha256, probe, type Probe, renderStill, renderVideo } from "./engine/encode.ts";
import { hashSeed, rng } from "./engine/util.ts";
import { Queue, slotKey } from "./publish/queue.ts";
import { addDays, zonedIso } from "./publish/schedule.ts";
import { buildSpec, type ChannelConfig, loadCaptions, loadChannels, readJson, TEMPLATES } from "./spec.ts";
import { type Platform, PLATFORMS, type VideoSpec } from "./templates/types.ts";

export interface Manifest {
  id: string;
  platform: Platform;
  file: string;
  silentFile: string | null;
  still: string;
  sha256: string;
  probe: Probe;
  audio: VideoSpec["audio"];
  title: string;
  text: string;
  dueAt: string | null;
  counter: { start: number; end: number; goal: number; trackFrom: number };
  captions: string[];
  theme: string;
  seed: number;
  durationSec: number;
}

export interface Planned {
  spec: VideoSpec;
  title: string;
  text: string;
  dueAt: string | null;
}

/** Render MP4 (+ silent twin when music is embedded), still and manifest for one spec. */
export async function renderOne(p: Planned, dir: string, opts: { silentTwin?: boolean } = {}): Promise<Manifest> {
  const { spec } = p;
  const file = join(dir, `${spec.id}.mp4`);
  const still = join(dir, `${spec.id}.png`);
  await renderVideo(spec, file);
  let silentFile: string | null = null;
  if (opts.silentTwin && spec.audio.mode === "embedded") {
    silentFile = join(dir, `${spec.id}.silent.mp4`);
    await renderVideo(spec, silentFile, { forceSilent: true });
  }
  renderStill(spec, spec.tapAt - 0.03, still); // counter at rest, pointer on the CTA
  const m: Manifest = {
    id: spec.id,
    platform: spec.platform,
    file,
    silentFile,
    still,
    sha256: fileSha256(file),
    probe: probe(file),
    audio: spec.audio,
    title: p.title,
    text: p.text,
    dueAt: p.dueAt,
    counter: { start: spec.startCount, end: spec.endCount, goal: spec.goal, trackFrom: spec.trackFrom },
    captions: spec.captions.map((c) => c.text),
    theme: spec.theme,
    seed: spec.seed,
    durationSec: spec.durationSec,
  };
  writeFileSync(join(dir, `${spec.id}.json`), JSON.stringify(m, null, 2));
  return m;
}

interface SampleDef {
  id: string;
  platform: Platform;
  soundIndex: number;
  captionSet: number;
  theme: string;
  startCount: number;
  trackFrom: number;
  gainFrac: number;
}

export function planSamples(date: string): Planned[] {
  const channels = loadChannels();
  const captions = loadCaptions();
  return readJson<SampleDef[]>("config/samples.json").map((s) => {
    const cap = captions[s.platform];
    const audio = resolveAudio(pickSound(loadLibrary(s.platform), date, s.soundIndex), s.platform);
    return {
      spec: buildSpec({
        id: s.id,
        platform: s.platform,
        channel: channels[s.platform],
        captions: cap.sets[s.captionSet % cap.sets.length],
        audio,
        theme: s.theme,
        startCount: s.startCount,
        trackFrom: s.trackFrom,
        gainFrac: s.gainFrac,
        disclosure: channels.disclosure,
      }),
      title: cap.titles[s.captionSet % cap.titles.length],
      text: cap.description,
      dueAt: null,
    };
  });
}

const GOAL_LADDER = [1e3, 5e3, 1e4, 2.5e4, 5e4, 1e5, 2.5e5, 5e5, 1e6, 5e6, 1e7];

/**
 * Deterministic plan for `days` days starting at `start` (YYYY-MM-DD): one
 * video per configured slot per platform. Counters continue from video to
 * video, sounds/captions/themes rotate, and no two videos in a batch share the
 * same caption set + theme + sound combination back-to-back.
 */
export function planBatch(start: string, days: number, platforms: Platform[] = PLATFORMS): Planned[] {
  const channels = loadChannels();
  const captions = loadCaptions();
  const schedule = readJson<{ timezone: string; slots: Record<Platform, string[]> }>("config/schedule.json");
  const out: Planned[] = [];
  for (const platform of platforms) {
    const ch: ChannelConfig = { ...channels[platform] };
    const lib = loadLibrary(platform);
    const cap = captions[platform];
    const tpl = TEMPLATES[platform];
    const r = rng(hashSeed(`batch|${platform}|${start}`));
    const dayOffset = Math.round((Date.parse(start) - Date.parse("2026-01-01")) / 86400000);
    let count = ch.startCount;
    let n = 0;
    for (let d = 0; d < days; d++) {
      const date = addDays(start, d);
      schedule.slots[platform].forEach((hhmm, slot) => {
        const idx = dayOffset * schedule.slots[platform].length + n;
        // move to the next goal tier once the current one is effectively reached
        if (count >= ch.goal * 0.985) {
          ch.goal = GOAL_LADDER.find((g) => g > ch.goal) ?? ch.goal * 2;
          ch.trackFrom = 0;
        }
        // alternate the full-range tracker with a zoomed "last stretch" one;
        // the absolute gain per video stays the same either way
        const zoom = n % 2 === 1;
        const tenth = ch.goal / 10;
        const trackFrom = zoom ? Math.max(ch.trackFrom, Math.min(Math.floor(count / tenth) * tenth, ch.goal - tenth)) : ch.trackFrom;
        const gainFrac = (ch.gainFrac * (ch.goal - ch.trackFrom)) / (ch.goal - trackFrom);
        const spec = buildSpec({
          id: `${platform}-${date}-${String.fromCharCode(97 + slot)}`,
          platform,
          channel: ch,
          captions: cap.sets[idx % cap.sets.length],
          audio: resolveAudio(pickSound(lib, date, idx), platform),
          theme: tpl.themes[Math.floor(idx / 2) % tpl.themes.length],
          startCount: Math.round(count),
          trackFrom,
          gainFrac,
          disclosure: channels.disclosure,
          targetSec: 7.6 + r() * 1.8,
        });
        out.push({
          spec,
          title: cap.titles[idx % cap.titles.length],
          text: cap.description,
          dueAt: zonedIso(date, hhmm, schedule.timezone),
        });
        // growth "between" videos so the next one does not start exactly where this ended
        count = spec.endCount + Math.round((spec.endCount - spec.startCount) * (0.2 + r() * 0.5));
        n++;
      });
    }
  }
  return out;
}

/** Adds rendered videos to the publish queue as pending_approval. Duplicate slots are skipped. */
export function enqueueBatch(queue: Queue, batchId: string, manifests: Manifest[]) {
  const channels = loadChannels();
  let added = 0;
  for (const m of manifests) {
    if (!m.dueAt) continue;
    const ok = queue.enqueue({
      key: slotKey(m.platform, channels[m.platform].bufferChannelId ?? channels[m.platform].handle, m.dueAt),
      videoId: m.id,
      batchId,
      platform: m.platform,
      file: m.file,
      audioMode: m.audio.mode,
      title: m.title,
      text: m.text,
      dueAt: m.dueAt,
    });
    if (ok) added++;
  }
  queue.save();
  return added;
}
