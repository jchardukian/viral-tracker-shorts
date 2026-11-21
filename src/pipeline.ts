import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { activeSounds, loadLibrary, pickSound, resolveAudio } from "./audio/library.ts";
import { fileSha256, probe, type Probe, renderStill, renderVideo } from "./engine/encode.ts";
import { hashSeed, rng } from "./engine/util.ts";
import { Queue, slotKey } from "./publish/queue.ts";
import { addDays, zonedIso } from "./publish/schedule.ts";
import { buildSpec, loadCaptions, loadChannels, readJson, TEMPLATES } from "./spec.ts";
import { type Platform, PLATFORMS, type VideoSpec } from "./templates/types.ts";

export interface Manifest {
  id: string;
  platform: Platform;
  variant: string;
  file: string;
  silentFile: string | null;
  still: string;
  sha256: string;
  probe: Probe;
  audio: VideoSpec["audio"];
  title: string;
  text: string;
  dueAt: string | null;
  counter: { start: number; end: number };
  caption: string;
  cuts: number;
  dataSource: VideoSpec["dataSource"];
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
  renderStill(spec, spec.durationSec - 0.1, still); // the final held dashboard
  const m: Manifest = {
    id: spec.id,
    platform: spec.platform,
    variant: spec.variant,
    file,
    silentFile,
    still,
    sha256: fileSha256(file),
    probe: probe(file),
    audio: spec.audio,
    title: p.title,
    text: p.text,
    dueAt: p.dueAt,
    counter: { start: spec.startCount, end: spec.endCount },
    caption: spec.caption,
    cuts: spec.cuts.length,
    dataSource: spec.dataSource,
    seed: spec.seed,
    durationSec: spec.durationSec,
  };
  writeFileSync(join(dir, `${spec.id}.json`), JSON.stringify(m, null, 2));
  return m;
}

interface SampleDef {
  id: string;
  platform: Platform;
  variant?: string;
  soundIndex: number;
  caption: number;
  targetSec: number;
  currentCount: number;
  historySeed: string;
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
        variant: s.variant,
        // samples show three differently shaped growth curves
        channel: { ...channels[s.platform], history: null, asOf: date, currentCount: s.currentCount, historySeed: s.historySeed },
        caption: cap.captions[s.caption % cap.captions.length],
        contentTitles: cap.contentTitles,
        audio,
        date,
        targetSec: s.targetSec,
        disclosure: channels.disclosure,
      }),
      title: cap.titles[s.caption % cap.titles.length],
      text: cap.description,
      dueAt: null,
    };
  });
}

/**
 * Deterministic plan for `days` days starting at `start` (YYYY-MM-DD): one
 * video per configured slot per platform. Every video is the full time-lapse
 * from day one up to its own date, so the final count grows day by day.
 * Captions and sounds rotate and length varies, so consecutive videos differ.
 */
export function planBatch(start: string, days: number, platforms: Platform[] = PLATFORMS): Planned[] {
  const channels = loadChannels();
  const captions = loadCaptions();
  const schedule = readJson<{ timezone: string; slots: Record<Platform, string[]> }>("config/schedule.json");
  const out: Planned[] = [];
  for (const platform of platforms) {
    const lib = loadLibrary(platform);
    const cap = captions[platform];
    const perDay = schedule.slots[platform].length;
    const variants = channels[platform].variants?.length ? channels[platform].variants! : [Object.keys(TEMPLATES[platform])[0]];
    const dayOffset = Math.round((Date.parse(start) - Date.parse("2026-01-01")) / 86400000);
    for (let d = 0; d < days; d++) {
      const date = addDays(start, d);
      schedule.slots[platform].forEach((hhmm, slot) => {
        const idx = (dayOffset + d) * perDay + slot;
        const r = rotation(idx, cap.captions.length, Math.max(1, activeSounds(lib, date).length), variants.length);
        const id = `${platform}-${date}-${String.fromCharCode(97 + slot)}`;
        out.push({
          spec: buildSpec({
            id,
            platform,
            variant: variants[r.variant],
            channel: channels[platform],
            caption: cap.captions[r.caption],
            contentTitles: cap.contentTitles,
            audio: resolveAudio(pickSound(lib, date, r.sound), platform),
            date,
            targetSec: 13 + rng(hashSeed(id))() * 5,
            disclosure: channels.disclosure,
          }),
          title: cap.titles[r.caption % cap.titles.length],
          text: cap.description,
          dueAt: zonedIso(date, hhmm, schedule.timezone),
        });
      });
    }
  }
  return out;
}

/**
 * Which caption / sound / template variant post number `idx` gets.
 * Caption changes every post, sound every `nCaptions` posts, and the variant
 * is offset by both, so the three dimensions are crossed rather than moving
 * together: every caption meets every sound, and each variant meets both.
 */
export function rotation(idx: number, nCaptions: number, nSounds: number, nVariants: number) {
  const caption = idx % nCaptions;
  const block = Math.floor(idx / nCaptions);
  const sound = block % nSounds;
  const variant = (caption + sound + Math.floor(block / nSounds)) % nVariants;
  return { caption, sound, variant };
}

/** The experiment plan as a CSV: one row per planned post, before anything is rendered. */
export function planCsv(plans: Planned[]): string {
  const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = "platform,video_id,due_at,caption,audio_id,audio_mode,native_sound_link,template_variant,duration_sec,final_count,title";
  return (
    [head, ...plans.map((p) => [p.spec.platform, p.spec.id, p.dueAt, p.spec.caption, p.spec.audio.soundId, p.spec.audio.mode, p.spec.audio.link, p.spec.variant, p.spec.durationSec.toFixed(2), p.spec.endCount, p.title].map(q).join(","))].join("\n") + "\n"
  );
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
      caption: m.caption,
      audioId: m.audio.soundId,
      variant: m.variant,
      title: m.title,
      text: m.text,
      dueAt: m.dueAt,
    });
    if (ok) added++;
  }
  queue.save();
  return added;
}
