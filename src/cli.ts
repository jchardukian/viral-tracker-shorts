import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { contactSheet, probe, renderStill } from "./engine/encode.ts";
import { ROOT } from "./engine/draw.ts";
import { applyBufferMetrics, importMetrics, parseCsv, readLedger, summarize, syncFromQueue, writeLedger } from "./analytics.ts";
import { detectBeat } from "./audio/beat.ts";
import { generateTrack, HOOK_FIRST, variationPrompt } from "./audio/generate.ts";
import { type AudioLibrary, loadLibrary } from "./audio/library.ts";
import { DIMENSIONS, type ExperimentConfig, recommend } from "./experiment.ts";
import { enqueueBatch, loadExperiment, type Manifest, planBatch, planCsv, planSamples, renderOne } from "./pipeline.ts";
import { type BufferConfig, BufferPublisher, fetchPost, listChannels } from "./publish/buffer.ts";
import { mediaConfigFromEnv, uploadVideo, verifyPublicUrl } from "./publish/media.ts";
import { DryRunPublisher, publishQueue, Queue, slotKey } from "./publish/queue.ts";
import { loadCaptions, loadChannels, TEMPLATES } from "./spec.ts";
import { type Platform, PLATFORMS } from "./templates/types.ts";

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name: string, def?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : "true") : def;
};
const QUEUE_PATH = flag("queue-file", join(ROOT, "state", "queue.json"))!;
const LEDGER_PATH = flag("ledger", join(ROOT, "data", "analytics", "posts.csv"))!;
const today = () => new Date().toISOString().slice(0, 10);

function bufferConfig(): BufferConfig {
  if (!process.env.BUFFER_API_KEY) throw new Error("this needs BUFFER_API_KEY in the environment");
  const ch = loadChannels();
  return {
    apiKey: process.env.BUFFER_API_KEY,
    channelIds: { youtube: ch.youtube.bufferChannelId, tiktok: ch.tiktok.bufferChannelId },
    youtubeCategoryId: ch.youtube.youtubeCategoryId ?? "24",
  };
}

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
    await contactSheet(manifests.filter((m) => m.platform === "tiktok").sort((a, b) => a.id.slice(-1).localeCompare(b.id.slice(-1)) || a.variant.localeCompare(b.variant)).map((m) => m.still), join(dir, "tiktok-variants.png"), 2);
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
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plan.csv"), planCsv(plans));
    if (flag("plan-out")) {
      mkdirSync(join(flag("plan-out")!, ".."), { recursive: true });
      writeFileSync(flag("plan-out")!, planCsv(plans));
    }
    if (flag("plan-only") === "true") {
      console.log(`planned ${plans.length} videos (not rendered) -> ${join(dir, "plan.csv")}`);
      return;
    }
    console.log(`batch ${batchId}: ${plans.length} videos -> ${dir}`);
    const manifests: Manifest[] = [];
    for (const p of plans) {
      manifests.push(await renderOne(p, join(dir, p.spec.platform), { silentTwin: true }));
      console.log(`  ${p.spec.id}  ${p.dueAt}  sound=${p.spec.audio.soundId ?? "none"} (${p.spec.audio.mode})  ${p.spec.variant}  ${p.spec.countTier ?? ""}  0 -> ${p.spec.endCount}`);
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
      // --id sends exactly one approved item (used for live validation)
      const only = flag("id");
      if (only && !queue.items.some((i) => i.videoId === only)) throw new Error(`no queued video with id ${only}`);
      const publisher = new BufferPublisher(bufferConfig());
      console.log(
        await publishQueue(queue, publisher, {
          log,
          filter: only ? (i) => i.videoId === only : undefined,
          requireAudio: loadChannels().publishSilent !== true,
          maxScheduled: flag("max-scheduled") ? Number(flag("max-scheduled")) : undefined,
        }),
      );
    } else if (sub === "validation") {
      // one post per platform from the approval samples, due a few minutes from now
      const mins = Number(flag("in", "20"));
      const dueAt = new Date(Math.ceil((Date.now() + mins * 60000) / 60000) * 60000).toISOString();
      const ch = loadChannels();
      for (const [platform, sample] of [["youtube", flag("youtube", "youtube-dashboard-1")!], ["tiktok", flag("tiktok", "tiktok-analytics-1")!]] as const) {
        const m = JSON.parse(readFileSync(join(ROOT, "samples", `${sample}.json`), "utf8")) as Manifest;
        const file = join(ROOT, "samples", `${sample}.mp4`);
        const videoId = `validation-${platform}`;
        const key = slotKey(platform, ch[platform].bufferChannelId ?? ch[platform].handle, dueAt);
        const prev = queue.items.find((i) => i.videoId === videoId);
        if (prev?.status === "scheduled") {
          console.log(`${videoId}: already sent to Buffer as ${prev.remoteId}; not touching it`);
          continue;
        }
        if (prev) {
          // refresh the time slot; approval and uploaded media are kept
          Object.assign(prev, { key, dueAt, file });
          prev.history.push({ at: new Date().toISOString(), event: `validation slot moved to ${dueAt}` });
        } else {
          queue.enqueue({ key, videoId, batchId: "validation", platform, file, audioMode: m.audio.mode, caption: m.caption, audioId: m.audio.soundId, variant: m.variant, countTier: m.countTier ?? null, title: m.title, text: m.text, dueAt });
        }
        console.log(`${videoId}: ${sample}.mp4 due ${dueAt} (${prev?.status ?? "pending_approval"})`);
      }
      queue.save();
    } else if (sub === "preflight") {
      // read-only readiness check; exits non-zero while anything blocks a live publish
      const batch = flag("batch", "validation")!;
      const items = queue.items.filter((i) => i.batchId === batch);
      const ch = loadChannels();
      const rows: { check: string; ok: boolean; detail: string }[] = [];
      const add = (check: string, ok: boolean, detail: string) => rows.push({ check, ok, detail });
      add(`queue has "${batch}" items`, items.length > 0, items.length ? `${items.length} item(s)` : `run: npm run queue -- ${batch === "validation" ? "validation" : "list"}`);
      add("items approved", items.length > 0 && items.every((i) => i.status !== "pending_approval"), `${items.filter((i) => i.status === "pending_approval").length} awaiting approval`);
      add("slots in the future", items.filter((i) => i.status !== "scheduled").every((i) => new Date(i.dueAt) > new Date()), "re-run `queue validation` if a slot has passed");
      add("audio embedded", ch.publishSilent === true || items.every((i) => i.audioMode === "embedded"), `${items.filter((i) => i.audioMode !== "embedded").length} silent`);
      let mediaOk = items.length > 0;
      for (const i of items) {
        const v = i.mediaUrl && existsSync(i.file) ? await verifyPublicUrl(i.mediaUrl, readFileSync(i.file).length).catch(() => null) : null;
        if (!v?.ok) mediaOk = false;
      }
      add("media hosted and publicly retrievable", mediaOk, mediaOk ? "verified just now" : "run: npm run media -- upload (after approval)");
      for (const pf of PLATFORMS) add(`${pf} channel id configured`, !!ch[pf].bufferChannelId, ch[pf].bufferChannelId ?? "set bufferChannelId in config/channels.json");
      if (!process.env.BUFFER_API_KEY) add("Buffer API key", false, "set BUFFER_API_KEY");
      else {
        try {
          const remote = await listChannels(bufferConfig());
          add("Buffer API key", true, `${remote.length} channel(s) visible`);
          for (const pf of PLATFORMS) {
            const c = remote.find((r) => r.id === ch[pf].bufferChannelId);
            add(`${pf} channel usable in Buffer`, !!c && c.service === pf && !c.isDisconnected && !c.isLocked, c ? `${c.name} (${c.service}, org "${c.organization}")${c.isDisconnected ? " DISCONNECTED" : ""}${c.isLocked ? " LOCKED" : ""}` : "configured id not found for this key");
          }
          if (flag("channels") === "true") console.table(remote);
        } catch (e) {
          add("Buffer API key", false, e instanceof Error ? e.message : String(e));
        }
      }
      console.table(rows.map((r) => ({ check: r.check, status: r.ok ? "ok" : "BLOCKED", detail: r.detail })));
      const blocked = rows.filter((r) => !r.ok).length;
      console.log(blocked ? `${blocked} check(s) blocking a live publish` : "READY: every check passed");
      if (blocked) process.exit(2);
    } else if (sub === "sync") {
      // what actually happened to each scheduled post: sent? link? error?
      const cfg = bufferConfig();
      for (const i of queue.items.filter((i) => i.status === "scheduled" && i.remoteId)) {
        const p = await fetchPost(cfg, i.remoteId!);
        i.published = { status: p.status, sentAt: p.sentAt, externalLink: p.externalLink, error: p.error, checkedAt: new Date().toISOString() };
        console.log(`${i.videoId}: ${p.status}${p.sentAt ? ` at ${p.sentAt}` : ""}${p.externalLink ? ` ${p.externalLink}` : ""}${p.error ? ` ERROR: ${p.error}` : ""}`);
      }
      queue.save();
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
  } else if (cmd === "media") {
    // upload approved videos to R2 and record their public URLs on the queue
    if (argv[1] !== "upload") throw new Error("media upload [--id <videoId>] [--file <mp4>]");
    const cfg = mediaConfigFromEnv();
    if (flag("file")) {
      const r = await uploadVideo(flag("file")!, cfg, flag("prefix", "vts"));
      console.log(`${r.url}  (${r.bytes} bytes, public fetch: HTTP ${r.verification.status} ${r.verification.contentType})`);
      return;
    }
    const queue = new Queue(QUEUE_PATH);
    const todo = queue.items.filter((i) => i.status === "approved" && (!flag("id") || i.videoId === flag("id")));
    for (const i of todo) {
      const r = await uploadVideo(i.file, cfg, `vts/${i.batchId}`);
      i.mediaUrl = r.url;
      i.history.push({ at: new Date().toISOString(), event: `uploaded, publicly retrievable: ${r.url}` });
      queue.save();
      console.log(`${i.videoId} -> ${r.url}`);
    }
    console.log(`uploaded and verified ${todo.length} approved video(s)`);
  } else if (cmd === "audio") {
    const sub = argv[1];
    if (sub === "detect") {
      console.log(detectBeat(argv[2]));
    } else if (sub === "generate") {
      // new original track, optionally in the style of an existing (well-performing) one
      const id = flag("id");
      if (!id) throw new Error("audio generate --id <new-id> (--prompt \"...\" | --like <existing-id>) [--title ...]");
      const libs = PLATFORMS.map((pf) => [pf, loadLibrary(pf)] as const);
      let prompt = flag("prompt");
      const like = flag("like");
      if (like) {
        const src = libs.flatMap(([, l]) => l.sounds).find((x) => x.id === like);
        if (src?.generator?.type !== "elevenlabs-music") throw new Error(`${like} has no stored prompt to build on`);
        const n = libs[0][1].sounds.filter((x) => x.generator?.type === "elevenlabs-music" && x.generator.basedOn === like).length;
        prompt = variationPrompt(src.generator.prompt, n);
      }
      if (!prompt) throw new Error("give --prompt or --like");
      if (libs.some(([, l]) => l.sounds.some((x) => x.id === id))) throw new Error(`sound id ${id} already exists`);
      const rel = `assets/audio/tracks/${id}.mp3`;
      await generateTrack(`${prompt}, ${HOOK_FIRST}`, join(ROOT, rel));
      const beat = detectBeat(join(ROOT, rel));
      const start = flag("from", today())!;
      const until = new Date(Date.parse(start) + 40 * 86400000).toISOString().slice(0, 10);
      for (const [pf, lib] of libs) {
        (lib as AudioLibrary).sounds.push({
          id,
          title: flag("title", id)!,
          approvedPlatforms: [...PLATFORMS],
          link: null,
          file: rel,
          generator: { type: "elevenlabs-music", prompt, generatedAt: today(), ...(like ? { basedOn: like } : {}) },
          license: { status: "licensed", embedAllowed: true, proof: `ElevenLabs Music, generated ${today()}`, notes: "Original instrumental. Owner to confirm plan terms for commercial use." },
          bpm: beat.bpm,
          beatOffsetSec: beat.offsetSec,
          activeFrom: start,
          expiresAt: until,
        });
        writeFileSync(join(ROOT, "config", "audio", `${pf}.json`), JSON.stringify(lib, null, 2) + "\n");
      }
      console.log(`${id}: ${rel}, ${beat.bpm} BPM, active ${start} to ${until}, added to both libraries`);
    } else throw new Error("audio <generate|detect>");
  } else if (cmd === "analytics") {
    const sub = argv[1];
    const queue = new Queue(QUEUE_PATH);
    let rows = readLedger(LEDGER_PATH);
    if (sub === "export") {
      rows = syncFromQueue(rows, queue.items, { includeUnpublished: flag("all") === "true" });
      writeLedger(LEDGER_PATH, rows);
      console.log(`${rows.length} row(s) -> ${LEDGER_PATH}`);
    } else if (sub === "import") {
      if (!argv[2]) throw new Error("analytics import <file.csv>");
      rows = syncFromQueue(rows, queue.items, { includeUnpublished: flag("all") === "true" });
      const res = importMetrics(rows, parseCsv(readFileSync(argv[2], "utf8")));
      writeLedger(LEDGER_PATH, res.rows);
      console.log(`updated ${res.updated} row(s)${res.unmatched.length ? `; no match for: ${res.unmatched.join(", ")}` : ""}`);
    } else if (sub === "pull") {
      const cfg = bufferConfig();
      rows = syncFromQueue(rows, queue.items);
      let n = 0;
      for (const r of rows.filter((r) => r.post_id)) if (applyBufferMetrics(r, await fetchPost(cfg, r.post_id))) n++;
      writeLedger(LEDGER_PATH, rows);
      console.log(`updated ${n} row(s) from Buffer`);
    } else if (sub === "report") {
      for (const by of ["platform", "caption", "audio_id", "template_variant", "count_tier"] as const) {
        console.log(`\nby ${by}`);
        console.table(summarize(rows, by));
      }
    } else if (sub === "recommend") {
      // turn results into weights for the next batch; --write saves them
      const exp = loadExperiment();
      const caps = loadCaptions();
      const ch = loadChannels();
      const next: ExperimentConfig = { ...exp, weights: { youtube: {}, tiktok: {} } };
      for (const pf of PLATFORMS) {
        const options = {
          caption: caps[pf].captions,
          audio_id: loadLibrary(pf).sounds.map((x) => x.id),
          template_variant: ch[pf].variants?.length ? ch[pf].variants! : [Object.keys(TEMPLATES[pf])[0]],
          count_tier: (ch.countTiers ?? []).map((t) => t.id),
        };
        for (const by of DIMENSIONS) {
          const ranked = recommend(rows, pf, by, options[by], exp);
          console.log(`\n${pf} · ${by}  (score 1.00 = platform average; blank = fewer than ${exp.minPosts} posts with data)`);
          console.table(ranked.map((r) => ({ option: r.option, posts: r.posts, score: r.score ?? "", "share of next batch": `${(r.weight * 100).toFixed(0)}%` })));
          if (ranked.some((r) => r.score !== null) && ranked.length > 1) next.weights[pf][by] = Object.fromEntries(ranked.map((r) => [r.option, r.weight]));
        }
      }
      if (flag("write") === "true") {
        writeFileSync(join(ROOT, "config", "experiment.json"), JSON.stringify(next, null, 2) + "\n");
        console.log("\nsaved to config/experiment.json; the next `batch` will follow these shares");
      } else console.log("\n(preview only; add --write to apply to the next batch)");
    } else throw new Error("analytics <export|import|pull|report|recommend>");
  } else {
    console.log(`usage:
  npm run samples                          render the 6 approval samples into samples/
  npm run batch -- --start 2026-11-23 --days 14 [--platform youtube|tiktok] [--limit N]
  npm run qa -- <dir>                      technical checks on rendered MP4s
  npm run queue -- list
  npm run queue -- approve --batch <id> | --id <videoId>
  npm run queue -- publish [--live] [--id <videoId>]   dry run unless --live
  npm run queue -- validation [--in 20]    queue one validation post per platform
  npm run queue -- preflight [--batch id]  read-only readiness check
  npm run queue -- sync                    fetch what happened to scheduled posts
  npm run queue -- export                  upload-ready package of approved items
  npm run media -- upload [--id <videoId>] upload approved MP4s to R2, verify public URLs
  npm run analytics -- export|import <csv>|pull|report|recommend [--write]
  npm run audio -- generate --id <id> (--prompt "..." | --like <id>) | detect <file>`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
