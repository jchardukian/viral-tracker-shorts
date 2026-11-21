import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { contactSheet, probe, renderStill } from "./engine/encode.ts";
import { ROOT } from "./engine/draw.ts";
import { enqueueBatch, type Manifest, planBatch, planSamples, renderOne } from "./pipeline.ts";
import { BufferPublisher } from "./publish/buffer.ts";
import { DryRunPublisher, publishQueue, Queue } from "./publish/queue.ts";
import { loadChannels } from "./spec.ts";
import { type Platform, PLATFORMS } from "./templates/types.ts";

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name: string, def?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : "true") : def;
};
const QUEUE_PATH = flag("queue-file", join(ROOT, "state", "queue.json"))!;
const today = () => new Date().toISOString().slice(0, 10);

/** Technical checks on every MP4 in a directory. Returns true when all pass. */
function qa(dir: string): boolean {
  const rows: Record<string, unknown>[] = [];
  let ok = true;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".mp4")).sort()) {
    const p = probe(join(dir, f));
    const silent = f.endsWith(".silent.mp4") || JSON.parse(readFileSync(join(dir, f.replace(/\.mp4$/, ".json")), "utf8")).audio.mode === "silent";
    const checks = {
      "1080x1920": p.width === 1080 && p.height === 1920,
      h264: p.vcodec === "h264" && p.pixFmt === "yuv420p",
      "30fps": Math.abs(p.fps - 30) < 0.01,
      aac: p.acodec === "aac",
      duration: p.durationSec >= 8 && p.durationSec <= 30,
      audio: silent ? (p.meanVolumeDb ?? 0) < -80 : (p.meanVolumeDb ?? -99) > -40,
      size: p.sizeBytes < 30e6,
    };
    const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
    if (failed.length) ok = false;
    rows.push({
      file: f,
      res: `${p.width}x${p.height}`,
      video: `${p.vcodec}/${p.pixFmt}`,
      fps: p.fps,
      audio: `${p.acodec} ${silent ? "silent" : `${p.meanVolumeDb} dB`}`,
      sec: +p.durationSec.toFixed(2),
      MB: +(p.sizeBytes / 1e6).toFixed(2),
      result: failed.length ? `FAIL: ${failed.join(", ")}` : "pass",
    });
  }
  console.table(rows);
  writeFileSync(join(dir, "qa-report.json"), JSON.stringify(rows, null, 2));
  return ok && rows.length > 0;
}

async function main() {
  if (cmd === "samples") {
    const dir = flag("out", join(ROOT, "samples"))!;
    mkdirSync(dir, { recursive: true });
    const plans = planSamples(flag("date", today())!);
    const manifests: Manifest[] = [];
    for (const p of plans) {
      const t0 = Date.now();
      manifests.push(await renderOne(p, dir));
      console.log(`rendered ${p.spec.id} (${p.spec.durationSec.toFixed(2)}s, ${p.spec.audio.bpm} bpm, ${p.spec.audio.mode}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
    await contactSheet(manifests.map((m) => m.still), join(dir, "contact-sheet.png"), 3);
    // filmstrips for visual inspection of the animation (not committed)
    const strips = join(ROOT, "out", "filmstrips");
    for (const p of plans) {
      const d = p.spec.durationSec;
      const frames = [0, d * 0.12, d * 0.3, d * 0.5, d * 0.7, d * 0.85, d - 0.05].map((t, i) => {
        const f = join(strips, `${p.spec.id}-${i}.png`);
        renderStill(p.spec, t, f);
        return f;
      });
      await contactSheet(frames, join(strips, `${p.spec.id}.png`), 7, 300);
    }
    if (!qa(dir)) process.exit(1);
  } else if (cmd === "batch") {
    const start = flag("start", today())!;
    const days = Number(flag("days", "1"));
    const platforms = (flag("platform") ? [flag("platform")] : PLATFORMS) as Platform[];
    const limit = Number(flag("limit", "0"));
    const batchId = `${start}_${days}d`;
    const dir = flag("out", join(ROOT, "out", "batches", batchId))!;
    let plans = planBatch(start, days, platforms);
    if (limit) plans = plans.slice(0, limit);
    console.log(`batch ${batchId}: ${plans.length} videos -> ${dir}`);
    const manifests: Manifest[] = [];
    for (const p of plans) {
      manifests.push(await renderOne(p, join(dir, p.spec.platform), { silentTwin: true }));
      console.log(`  ${p.spec.id}  ${p.dueAt}  sound=${p.spec.audio.soundId ?? "none"} (${p.spec.audio.mode})  0 -> ${p.spec.endCount} in ${p.spec.cuts.length} cuts`);
    }
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ batchId, start, days, videos: manifests }, null, 2));
    for (const pf of new Set(manifests.map((m) => m.platform))) if (!qa(join(dir, pf))) process.exit(1);
    const added = enqueueBatch(new Queue(QUEUE_PATH), batchId, manifests);
    console.log(`queued ${added} new item(s) as pending_approval (${manifests.length - added} duplicate slot(s) skipped). Nothing is published until approved.`);
  } else if (cmd === "qa") {
    if (!qa(argv[1] ?? join(ROOT, "samples"))) process.exit(1);
  } else if (cmd === "queue") {
    const sub = argv[1];
    const queue = new Queue(QUEUE_PATH);
    if (sub === "list") {
      console.table(queue.items.map((i) => ({ video: i.videoId, due: i.dueAt, status: i.status, audio: i.audioMode, attempts: i.attempts, remote: i.remoteId, error: i.lastError })));
    } else if (sub === "approve") {
      const batch = flag("batch");
      const id = flag("id");
      if (!batch && !id) throw new Error("approve needs --batch <batchId> or --id <videoId>");
      const n = queue.approve((i) => (batch ? i.batchId === batch : i.videoId === id));
      queue.save();
      console.log(`approved ${n} item(s)`);
    } else if (sub === "publish") {
      const live = flag("live") === "true";
      const log = (l: string) => console.log(`[${new Date().toISOString()}] ${l}`);
      if (!live) {
        console.log("DRY RUN — no network calls. Pass --live to schedule approved items in Buffer.");
        console.log(await publishQueue(queue, new DryRunPublisher(), { log }));
        return;
      }
      const { BUFFER_API_KEY, MEDIA_BASE_URL } = process.env;
      if (!BUFFER_API_KEY || !MEDIA_BASE_URL) throw new Error("--live needs BUFFER_API_KEY and MEDIA_BASE_URL in the environment");
      const ch = loadChannels();
      const publisher = new BufferPublisher({
        apiKey: BUFFER_API_KEY,
        mediaBaseUrl: MEDIA_BASE_URL,
        channelIds: { youtube: ch.youtube.bufferChannelId, tiktok: ch.tiktok.bufferChannelId },
        youtubeCategoryId: ch.youtube.youtubeCategoryId ?? "24",
      });
      console.log(await publishQueue(queue, publisher, { log }));
    } else if (sub === "export") {
      // Upload-ready package for manual/other-tool scheduling when Buffer is unavailable.
      const dir = flag("out", join(ROOT, "out", "export"))!;
      mkdirSync(dir, { recursive: true });
      const rows = ["file,platform,due_at,title,text,audio_mode,status"];
      for (const i of queue.items.filter((i) => i.status === "approved")) {
        if (existsSync(i.file)) cpSync(i.file, join(dir, basename(i.file)));
        rows.push([basename(i.file), i.platform, i.dueAt, i.title, i.text, i.audioMode, i.status].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
      }
      writeFileSync(join(dir, "schedule.csv"), rows.join("\n") + "\n");
      console.log(`exported ${rows.length - 1} approved item(s) to ${dir}`);
    } else throw new Error("queue <list|approve|publish|export>");
  } else {
    console.log(`usage:
  npm run samples                          render the 6 approval samples into samples/
  npm run batch -- --start 2026-11-23 --days 14 [--platform youtube|tiktok] [--limit N]
  npm run qa -- <dir>                      technical checks on rendered MP4s
  npm run queue -- list
  npm run queue -- approve --batch <id> | --id <videoId>
  npm run queue -- publish [--live]        dry run unless --live
  npm run queue -- export                  upload-ready package of approved items`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
