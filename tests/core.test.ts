import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { activeSounds, AudioError, type AudioLibrary, loadLibrary, pickSound, resolveAudio, type Sound } from "../src/audio/library.ts";
import { probe, renderFrame, renderVideo } from "../src/engine/encode.ts";
import { applyBufferMetrics, COLUMNS, importMetrics, parseCsv, readLedger, summarize, syncFromQueue, writeLedger } from "../src/analytics.ts";
import { detectBeat } from "../src/audio/beat.ts";
import { generateTrack, variationPrompt } from "../src/audio/generate.ts";
import { synthBeat } from "../src/audio/synth.ts";
import { rng } from "../src/engine/util.ts";
import { apportion, design, recommend } from "../src/experiment.ts";
import { enqueueBatch, type Manifest, planBatch, planCsv, planSamples } from "../src/pipeline.ts";
import { BufferPublisher, buildCreatePostInput, fetchPost } from "../src/publish/buffer.ts";
import { mediaConfigFromEnv, mediaKey, publicUrl, uploadVideo, verifyPublicUrl } from "../src/publish/media.ts";
import { DryRunPublisher, PermanentError, type Publisher, publishQueue, Queue, type QueueItem, slotKey } from "../src/publish/queue.ts";
import { zonedIso } from "../src/publish/schedule.ts";
import { buildSpec, loadCaptions, loadChannels, TEMPLATES } from "../src/spec.ts";
import { simulateHistory } from "../src/history.ts";
import { PLATFORMS, rectInSafe, snapshotIndex } from "../src/templates/types.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "vts-"));
const sound = (over: Partial<Sound> = {}): Sound => ({
  id: "s1",
  title: "s1",
  approvedPlatforms: ["youtube"],
  link: null,
  file: "assets/audio/generated/test-s1.wav",
  generator: { type: "synth", seed: 1, seconds: 8 },
  license: { status: "owned", embedAllowed: true, proof: "test" },
  bpm: 120,
  beatOffsetSec: 0,
  activeFrom: "2026-11-01",
  expiresAt: "2026-11-30",
  ...over,
});
const silent = () => resolveAudio(null, "youtube");
const spec = (id = "t1", platform: "youtube" | "tiktok" = "youtube", targetSec = 16) =>
  buildSpec({ id, platform, channel: loadChannels()[platform], caption: "Use this sound to get more subscribers", contentTitles: ["a", "b"], audio: silent(), date: "2026-11-21", targetSec });

// ---------- spec / time-lapse ---------------------------------------------------

test("specs are deterministic and vary by id", () => {
  assert.deepEqual(spec("a"), spec("a"));
  assert.notDeepEqual(spec("a").snapshots, spec("b").snapshots);
});

test("time-lapse runs from zero to the configured count and never goes down", () => {
  for (const platform of PLATFORMS) {
    const s = spec("mono", platform);
    assert.equal(s.snapshots[0].count, 0);
    assert.equal(s.endCount, loadChannels()[platform].currentCount);
    for (let i = 1; i < s.snapshots.length; i++) assert.ok(s.snapshots[i].count >= s.snapshots[i - 1].count);
    // 28-day views are a rolling window, so they must fall at some point as well as rise
    assert.ok(s.snapshots.some((x, i) => i > 0 && x.views28 < s.snapshots[i - 1].views28));
  }
});

test("pacing matches the reference: ~15 hard cuts/s, slowing tail, ~2 s final hold on a beat", () => {
  const s = spec("pace", "youtube", 18);
  assert.equal(s.cuts.length, s.snapshots.length);
  assert.equal(s.cuts[0], 0);
  const lens = s.cuts.slice(1).map((c, i) => c - s.cuts[i]);
  assert.ok(lens.every((l) => l >= 2));
  assert.ok(lens.filter((l) => l === 2).length / lens.length > 0.8, "most cuts last 2 frames");
  const tail = lens.slice(-16);
  for (let i = 1; i < tail.length; i++) assert.ok(tail[i] >= tail[i - 1], "tail only slows down");
  const hold = (s.frames - s.holdFrame) / s.fps;
  assert.ok(hold >= 1.5 && hold <= 2.6, `hold ${hold}`);
  assert.ok(s.beats.some((b) => Math.round(b * s.fps) === s.holdFrame));
  assert.equal(snapshotIndex(s, s.frames - 1), s.snapshots.length - 1);
  assert.equal(snapshotIndex(s, 0), 0);
  assert.ok(s.cuts.length > 200, `${s.cuts.length} cuts in 18 s`);
});

test("simulated history hits the configured count on asOf and keeps growing after it", () => {
  const cfg = loadChannels().youtube;
  const h = simulateHistory(cfg, "2026-12-05");
  assert.equal(h[0].count, 0);
  assert.equal(h.find((p) => p.date === cfg.asOf)!.count, cfg.currentCount);
  assert.ok(h[h.length - 1].count > cfg.currentCount);
  assert.equal(h[h.length - 1].date, "2026-12-05");
});

test("a real history CSV replaces the simulated curve", () => {
  const dir = tmp();
  const rows = ["date,count,views28,watch_hours28", ...Array.from({ length: 40 }, (_, i) => `2026-10-${String(1 + (i % 31)).padStart(2, "0")},${i * 10},${i * 1000},${i * 2}`).slice(0, 31)];
  writeFileSync(join(dir, "h.csv"), rows.join("\n"));
  const s = buildSpec({ id: "h", platform: "youtube", channel: { ...loadChannels().youtube, history: join(dir, "h.csv") }, caption: "c", contentTitles: ["a"], audio: silent(), date: "2026-10-31" });
  assert.equal(s.dataSource, "history");
  assert.equal(s.endCount, 300);
  assert.equal(spec().dataSource, "simulated");
});

test("explicit beat timestamps override the bpm grid", () => {
  const beats = Array.from({ length: 24 }, (_, i) => +(0.1 + i * 0.55).toFixed(2));
  const s = buildSpec({ id: "b", platform: "tiktok", channel: loadChannels().tiktok, caption: "c", contentTitles: ["a"], audio: { ...silent(), beats }, date: "2026-11-21" });
  assert.deepEqual(s.beats, beats);
});

test("headline numbers and caption are inside the platform safe area and clear of the action rail", () => {
  for (const platform of PLATFORMS) {
    for (const [variant, tpl] of Object.entries(TEMPLATES[platform]))
      for (const [name, r] of Object.entries(tpl.layout)) assert.ok(rectInSafe(r, tpl.safe), `${platform}.${variant}.${name}`);
  }
});

test("the two platforms use different layouts", () => {
  assert.notDeepEqual(Object.keys(TEMPLATES.youtube.dashboard.layout), Object.keys(TEMPLATES.tiktok.analytics.layout));
  assert.notDeepEqual(TEMPLATES.tiktok.analytics.layout, TEMPLATES.tiktok.profile.layout);
});

// ---------- rendering ---------------------------------------------------------

test("frames render at 1080x1920 and are not blank", () => {
  for (const [platform, variant] of [["youtube", "dashboard"], ["tiktok", "analytics"], ["tiktok", "profile"]] as const) {
    const c = renderFrame({ ...spec("f", platform), variant }, 3);
    assert.deepEqual([c.width, c.height], [1080, 1920]);
    const d = c.data();
    let lit = 0;
    for (let i = 0; i < d.length; i += 4 * 997) if (d[i] + d[i + 1] + d[i + 2] > 300) lit++;
    assert.ok(lit > 50, `${platform} frame looks blank`);
  }
});

test("encoded video is 1080x1920 H.264/yuv420p 30fps with AAC; embedded has sound, silent is silent", async () => {
  const dir = tmp();
  const base = buildSpec({ id: "enc", platform: "youtube", channel: loadChannels().youtube, caption: "a", contentTitles: ["a"], audio: resolveAudio(sound(), "youtube"), date: "2026-11-21", targetSec: 6 });
  await renderVideo(base, join(dir, "a.mp4"));
  await renderVideo(base, join(dir, "s.mp4"), { forceSilent: true });
  const a = probe(join(dir, "a.mp4"));
  const s = probe(join(dir, "s.mp4"));
  for (const p of [a, s]) {
    assert.deepEqual([p.width, p.height, p.vcodec, p.pixFmt, p.fps, p.acodec], [1080, 1920, "h264", "yuv420p", 30, "aac"]);
    assert.ok(Math.abs(p.durationSec - base.durationSec) < 0.15);
  }
  assert.ok(a.meanVolumeDb! > -40);
  assert.ok(s.meanVolumeDb! < -80);
});

// ---------- audio library -----------------------------------------------------

test("shipped audio libraries are separate per platform and valid", () => {
  for (const platform of PLATFORMS) {
    const lib = loadLibrary(platform);
    assert.equal(lib.platform, platform);
    assert.ok(lib.sounds.every((s) => s.approvedPlatforms.includes(platform)));
  }
});

test("rotation cycles the active pool; expired and other-platform sounds are excluded", () => {
  const lib: AudioLibrary = {
    platform: "youtube",
    sounds: [sound({ id: "a" }), sound({ id: "b" }), sound({ id: "old", expiresAt: "2026-11-05" }), sound({ id: "tt", approvedPlatforms: ["tiktok"] })],
  };
  assert.deepEqual(activeSounds(lib, "2026-11-10").map((s) => s.id), ["a", "b"]);
  assert.deepEqual([0, 1, 2, 3].map((i) => pickSound(lib, "2026-11-10", i)!.id), ["a", "b", "a", "b"]);
  assert.equal(pickSound(lib, "2027-01-01", 0), null);
  assert.equal(resolveAudio(null, "youtube").mode, "silent");
});

test("a sound link alone never gets embedded", () => {
  const a = resolveAudio(sound({ link: "https://example.com/sound/1", file: null, generator: undefined, license: { status: "platform-native-only", embedAllowed: false, proof: null } }), "youtube");
  assert.equal(a.mode, "silent");
  assert.equal(a.file, null);
  // a file on disk is still not embedded without an embed licence
  assert.equal(resolveAudio(sound({ license: { status: "unknown", embedAllowed: true, proof: null } }), "youtube").mode, "silent");
  assert.equal(resolveAudio(sound({ license: { status: "licensed", embedAllowed: false, proof: "x" } }), "youtube").mode, "silent");
});

test("missing licensed file and wrong-platform sound are hard errors", () => {
  assert.throws(() => resolveAudio(sound({ file: "assets/audio/licensed/nope.mp3", generator: undefined }), "youtube"), AudioError);
  assert.throws(() => resolveAudio(sound(), "tiktok"), AudioError);
});

// ---------- batch planning ----------------------------------------------------

test("batch plan: 2/day/platform, unique ids and slots, varied final counts, no adjacent look-alikes", () => {
  const plan = planBatch("2026-11-23", 14);
  assert.equal(plan.length, 14 * 2 * 2);
  assert.equal(new Set(plan.map((p) => p.spec.id)).size, plan.length);
  assert.equal(new Set(plan.map((p) => `${p.spec.platform}|${p.dueAt}`)).size, plan.length);
  for (const platform of PLATFORMS) {
    const ps = plan.filter((p) => p.spec.platform === platform);
    assert.equal(ps.length, 28);
    for (let i = 1; i < ps.length; i++) {
      const sig = (p: (typeof ps)[number]) => `${p.spec.caption}#${p.spec.audio.soundId}#${p.spec.variant}#${p.spec.countTier}`;
      assert.notEqual(sig(ps[i]), sig(ps[i - 1]));
    }
    // every video ends on its own number, from the hundreds up to over a billion
    const ends = ps.map((p) => p.spec.endCount);
    assert.ok(new Set(ends).size >= ends.length - 3, "final counts are almost all different");
    assert.ok(Math.min(...ends) < 500 && Math.max(...ends) > 1e9);
    for (const p of ps) {
      const tier = loadChannels().countTiers!.find((t) => t.id === p.spec.countTier)!;
      assert.ok(p.spec.endCount >= tier.base && p.spec.endCount <= tier.base * 1.61 && p.spec.snapshots[0].count === 0);
    }
  }
  assert.deepEqual(planBatch("2026-11-23", 2), planBatch("2026-11-23", 2));
});

test("sample plan: 3 YouTube, and both TikTok variants x 3", () => {
  const s = planSamples("2026-11-21");
  assert.deepEqual(PLATFORMS.map((p) => s.filter((x) => x.spec.platform === p).length), [3, 6]);
  assert.deepEqual([...new Set(s.map((x) => x.spec.variant))], ["dashboard", "analytics", "profile"]);
});

test("schedule times carry the right UTC offset across DST", () => {
  assert.equal(zonedIso("2026-11-22", "18:23", "America/Chicago"), "2026-11-22T18:23:00-06:00");
  assert.equal(zonedIso("2026-07-04", "11:07", "America/Chicago"), "2026-07-04T11:07:00-05:00");
});

// ---------- queue / publishing ------------------------------------------------

const FUTURE = "2099-01-01T12:00:00-06:00";
function item(dir: string, id: string, dueAt = FUTURE) {
  const file = join(dir, `${id}.mp4`);
  writeFileSync(file, "x");
  return { key: slotKey("youtube", "ch", dueAt), videoId: id, batchId: "b1", platform: "youtube" as const, file, audioMode: "silent" as const, caption: "cap", audioId: "s1", variant: "dashboard", countTier: "1M", title: "t", text: "x", dueAt };
}
const livePublisher = (fn: (i: QueueItem) => Promise<{ remoteId: string }>): Publisher => ({ name: "fake", live: true, publish: fn });
const fast = { sleep: async () => {}, baseDelayMs: 1 };

test("duplicate slots and duplicate videos are rejected; queue survives reload", () => {
  const dir = tmp();
  const q = new Queue(join(dir, "q.json"));
  assert.equal(q.enqueue(item(dir, "v1")), true);
  assert.equal(q.enqueue(item(dir, "v2")), false); // same slot
  assert.equal(q.enqueue(item(dir, "v1", "2099-01-02T12:00:00-06:00")), false); // same video
  q.save();
  assert.equal(new Queue(join(dir, "q.json")).items.length, 1);
});

test("approval gate: unapproved items are never sent to a live publisher", async () => {
  const dir = tmp();
  const q = new Queue(join(dir, "q.json"));
  q.enqueue(item(dir, "v1"));
  let calls = 0;
  const pub = livePublisher(async () => ({ remoteId: `r${++calls}` }));
  assert.equal((await publishQueue(q, pub, fast)).sent, 0);
  assert.equal(calls, 0);
  assert.equal(q.approve((i) => i.batchId === "b1"), 1);
  assert.equal((await publishQueue(q, pub, fast)).sent, 1);
  assert.equal(q.items[0].status, "scheduled");
  // second run must not double-post
  await publishQueue(q, pub, fast);
  await publishQueue(new Queue(join(dir, "q.json")), pub, fast);
  assert.equal(calls, 1);
});

test("dry run sends nothing and changes no state", async () => {
  const dir = tmp();
  const q = new Queue(join(dir, "q.json"));
  q.enqueue(item(dir, "v1"));
  q.approve(() => true);
  const dry = new DryRunPublisher();
  assert.equal((await publishQueue(q, dry, fast)).sent, 1);
  assert.equal(q.items[0].status, "approved");
  assert.equal(q.items[0].attempts, 0);
  assert.equal(q.items[0].remoteId, null);
});

test("transient errors retry with backoff; permanent errors fail fast; past slots are skipped", async () => {
  const dir = tmp();
  const q = new Queue(join(dir, "q.json"));
  q.enqueue(item(dir, "v1"));
  q.enqueue(item(dir, "v2", "2099-01-02T12:00:00-06:00"));
  q.enqueue(item(dir, "v3", "2020-01-01T12:00:00-06:00"));
  q.approve(() => true);
  const delays: number[] = [];
  let n = 0;
  const pub = livePublisher(async (i) => {
    if (i.videoId === "v2") throw new PermanentError("bad input");
    if (++n < 3) throw new Error("HTTP 503");
    return { remoteId: "ok" };
  });
  const sum = await publishQueue(q, pub, { baseDelayMs: 100, sleep: async (ms) => void delays.push(ms) });
  assert.deepEqual(delays, [100, 200]);
  assert.deepEqual(q.items.map((i) => [i.status, i.attempts]), [["scheduled", 3], ["failed", 1], ["approved", 0]]);
  assert.deepEqual(sum, { sent: 1, failed: 1, skipped: 1 });
});

test("enqueueBatch is idempotent", () => {
  const dir = tmp();
  const q = new Queue(join(dir, "q.json"));
  const m = planBatch("2026-11-23", 1).map((p) => ({ id: p.spec.id, platform: p.spec.platform, variant: p.spec.variant, countTier: p.spec.countTier, caption: p.spec.caption, file: join(dir, `${p.spec.id}.mp4`), audio: p.spec.audio, title: p.title, text: p.text, dueAt: p.dueAt }) as Manifest);
  assert.equal(enqueueBatch(q, "b", m), 4);
  assert.equal(enqueueBatch(new Queue(join(dir, "q.json")), "b", m), 0);
  assert.ok(existsSync(join(dir, "q.json")));
});

test("Buffer payload matches the verified createPost schema", async () => {
  const dir = tmp();
  const q = new Queue(join(dir, "q.json"));
  q.enqueue(item(dir, "v1"));
  const it = q.items[0];
  const cfg = { apiKey: "k", channelIds: { youtube: "a".repeat(24), tiktok: null }, youtubeCategoryId: "24" };
  assert.throws(() => buildCreatePostInput(it, cfg), PermanentError, "no media URL yet");
  it.mediaUrl = "https://media.example.com/vts/v1-abc.mp4";
  const input = buildCreatePostInput(it, cfg);
  assert.equal(input.mode, "customScheduled");
  assert.equal(input.schedulingType, "automatic");
  assert.equal(input.dueAt, "2099-01-01T18:00:00.000Z");
  assert.deepEqual(input.assets, [{ video: { url: it.mediaUrl } }]);
  assert.deepEqual(Object.keys(input.metadata), ["youtube"]);
  assert.throws(() => buildCreatePostInput({ ...it, platform: "tiktok" }, cfg), PermanentError);

  const respond = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  const ok = new BufferPublisher({ ...cfg, fetchImpl: respond(200, { data: { createPost: { __typename: "PostActionSuccess", post: { id: "p1" } } } }) });
  assert.deepEqual(await ok.publish(it), { remoteId: "p1" });
  const invalid = new BufferPublisher({ ...cfg, fetchImpl: respond(200, { data: { createPost: { __typename: "InvalidInputError", message: "nope" } } }) });
  await assert.rejects(invalid.publish(it), PermanentError);
  const limited = new BufferPublisher({ ...cfg, fetchImpl: respond(429, {}) });
  await assert.rejects(limited.publish(it), (e: Error) => !(e instanceof PermanentError));
  const post = await fetchPost({ ...cfg, fetchImpl: respond(200, { data: { post: { id: "p1", status: "sent", sentAt: "2099-01-01T18:00:05Z", externalLink: "https://x/y", error: null, metrics: [{ type: "views", name: "Views", value: 1200, unit: null }] } } }) }, "p1");
  assert.deepEqual([post.status, post.externalLink, post.metrics[0].value], ["sent", "https://x/y", 1200]);
});

test("publishQueue filter sends only the selected item", async () => {
  const dir = tmp();
  const q = new Queue(join(dir, "q.json"));
  q.enqueue(item(dir, "v1"));
  q.enqueue(item(dir, "v2", "2099-01-02T12:00:00-06:00"));
  q.approve(() => true);
  const sent: string[] = [];
  await publishQueue(q, livePublisher(async (i) => (sent.push(i.videoId), { remoteId: "r" })), { ...fast, filter: (i) => i.videoId === "v2" });
  assert.deepEqual(sent, ["v2"]);
  assert.deepEqual(q.items.map((i) => i.status), ["approved", "scheduled"]);
});

// ---------- experiment design ---------------------------------------------------

test("14-day experiment: 28 posts per platform, every pair of factors balanced, nothing confounded", () => {
  const plan = planBatch("2026-11-30", 14);
  for (const platform of PLATFORMS) {
    const ps = plan.filter((p) => p.spec.platform === platform);
    assert.equal(ps.length, 28);
    const count = (f: (p: (typeof ps)[number]) => string) => ps.reduce((m, p) => m.set(f(p), (m.get(f(p)) ?? 0) + 1), new Map<string, number>());
    const spread = (m: Map<string, number>) => Math.max(...m.values()) - Math.min(...m.values());
    const slot = (p: (typeof ps)[number]) => p.dueAt!.slice(11, 16);
    const week = (p: (typeof ps)[number]) => (p.dueAt! < "2026-12-07" ? "1" : "2");
    const nCap = loadCaptions()[platform].captions.length;
    const nSnd = loadLibrary(platform).sounds.length;
    const caps = count((p) => p.spec.caption);
    const snds = count((p) => p.spec.audio.soundId!);
    assert.deepEqual([caps.size, snds.size], [nCap, nSnd], "every caption and every sound is used");
    assert.ok(spread(caps) <= 1 && spread(snds) <= 1, "even shares");
    assert.ok(count((p) => `${p.spec.caption}|${p.spec.audio.soundId}`).size >= 24, "captions and sounds are mixed, not paired");
    // nothing is tied to a time of day or a week
    assert.ok(spread(count((p) => p.spec.countTier!)) <= 1 && count((p) => p.spec.countTier!).size === 5, "five count sizes, even shares");
    for (const f of [(p: (typeof ps)[number]) => p.spec.caption, (p: (typeof ps)[number]) => p.spec.audio.soundId!, (p: (typeof ps)[number]) => p.spec.variant, (p: (typeof ps)[number]) => p.spec.countTier!]) {
      const byTime = count((p) => `${f(p)}|${slot(p)}`);
      const byWeek = count((p) => `${f(p)}|${week(p)}`);
      assert.equal(byTime.size, count(f).size * 2, "every option appears in both time slots");
      assert.equal(byWeek.size, count(f).size * 2, "every option appears in both weeks");
      assert.ok(spread(byTime) <= 2 && spread(byWeek) <= 2);
    }
    if (platform === "tiktok") {
      assert.ok([...count((p) => `${p.spec.variant}|${slot(p)}`).values()].every((n) => n === 7));
      assert.equal(count((p) => `${p.spec.variant}|${p.spec.audio.soundId}`).size, nSnd * 2, "each variant runs with every sound");
      assert.equal(count((p) => `${p.spec.variant}|${p.spec.caption}`).size, nCap * 2, "each variant runs with every caption");
    }
    assert.ok(ps.every((p) => p.spec.audio.mode === "embedded"));
  }
  const csv = planCsv(plan).trim().split("\n");
  assert.equal(csv.length, 57);
  assert.ok(csv[0].includes("template_variant,count_tier,duration_sec,final_count"));
});

test("results tilt the next batch towards winners but keep exploring", () => {
  const caps = loadCaptions().youtube.captions;
  const mk = (caption: string, views: number, followers: number, i: number) =>
    ({ platform: "youtube", post_id: "", video_id: `${caption}-${i}`, publish_date: "2026-12-01", caption, audio_id: "a", template_variant: "dashboard", count_tier: "1M", final_count: "", views: String(views), viewed_rate: "", avg_watch_pct: "", followers_gained: String(followers), shares: "", post_url: "", source: "manual" }) as const;
  const rows = [0, 1, 2].flatMap((i) => [mk(caps[0], 9000, 30, i), mk(caps[1], 1000, 1, i)]);
  const ranked = recommend([...rows], "youtube", "caption", caps, { explore: 0.3, minPosts: 3 });
  const w = Object.fromEntries(ranked.map((r) => [r.option, r.weight]));
  assert.equal(ranked[0].option, caps[0]);
  assert.ok(w[caps[0]] > w[caps[2]] && w[caps[2]] > w[caps[1]], "winner > untested > loser");
  assert.ok(w[caps[1]] >= 0.3 / caps.length, "even the weakest option keeps its exploration share");
  assert.ok(Math.abs(ranked.reduce((a, r) => a + r.weight, 0) - 1) < 0.01);
  assert.equal(ranked.find((r) => r.option === caps[2])!.score, null, "no data yet");

  const counts = apportion(caps, w, 28);
  assert.equal(counts.reduce((a, b) => a + b, 0), 28);
  assert.ok(counts[0] > counts[2] && counts[2] > counts[1] && counts[1] >= 1);
  assert.deepEqual(apportion(["a", "b", "c"], undefined, 28).sort((x, y) => x - y), [9, 9, 10]);

  const exp = { explore: 0.3, minPosts: 3, weights: { youtube: { caption: w }, tiktok: {} } };
  const plan = planBatch("2026-12-14", 14, ["youtube"], exp);
  const used = plan.reduce((m, p) => m.set(p.spec.caption, (m.get(p.spec.caption) ?? 0) + 1), new Map<string, number>());
  assert.deepEqual(caps.map((c) => used.get(c)), counts);
  assert.deepEqual(plan, planBatch("2026-12-14", 14, ["youtube"], exp), "deterministic");
});

test("design keeps weighted factors independent of time slot", () => {
  const a = design(28, 2, [[14, 7, 7], [10, 9, 9]], rng(7));
  const slot0 = a[0].filter((v, k) => v === 0 && k % 2 === 0).length;
  assert.ok(slot0 >= 6 && slot0 <= 8, `option with 14 posts has ${slot0} in the first slot`);
  assert.deepEqual([0, 1, 2].map((i) => a[0].filter((v) => v === i).length), [14, 7, 7]);
});

test("beat detection finds the tempo of a known beat", () => {
  const dir = tmp();
  for (const bpm of [104, 128]) {
    writeFileSync(join(dir, `${bpm}.wav`), synthBeat({ bpm, seconds: 12, seed: bpm }));
    assert.ok(Math.abs(detectBeat(join(dir, `${bpm}.wav`)).bpm - bpm) <= 1);
  }
});

test("track generation stores audio and builds variations from a stored prompt", async () => {
  const dir = tmp();
  let body: any;
  const fake = (async (_u: string, init: RequestInit) => ((body = JSON.parse(init.body as string)), new Response(new Uint8Array([1, 2, 3]), { status: 200 }))) as unknown as typeof fetch;
  assert.equal(await generateTrack("funk groove", join(dir, "a", "t.mp3"), { apiKey: "k", fetchImpl: fake, seconds: 20 }), 3);
  assert.deepEqual([body.prompt, body.music_length_ms], ["funk groove", 20000]);
  assert.notEqual(variationPrompt("x", 0), variationPrompt("x", 1));
  assert.ok(variationPrompt("x", 0).startsWith("x. Variation:"));
  await assert.rejects(generateTrack("p", join(dir, "b.mp3"), { apiKey: "k", fetchImpl: (async () => new Response("no", { status: 429 })) as unknown as typeof fetch }), /429/);
});

test("publish guards: silent videos refused, scheduler backlog capped per platform", async () => {
  const dir = tmp();
  const q = new Queue(join(dir, "q.json"));
  for (let d = 1; d <= 4; d++) q.enqueue({ ...item(dir, `v${d}`, `2099-01-0${d}T12:00:00-06:00`), audioMode: d === 4 ? "silent" : "embedded" });
  q.approve(() => true);
  const pub = livePublisher(async (i) => ({ remoteId: `r-${i.videoId}` }));
  await publishQueue(q, pub, { ...fast, requireAudio: true, maxScheduled: 2 });
  assert.deepEqual(q.items.map((i) => i.status), ["scheduled", "scheduled", "approved", "approved"]);
  // once earlier posts have gone out, the next ones are released
  await publishQueue(q, pub, { ...fast, requireAudio: true, maxScheduled: 2, now: () => new Date("2099-01-02T20:00:00Z") });
  assert.deepEqual(q.items.map((i) => i.status), ["scheduled", "scheduled", "scheduled", "failed"]);
  assert.match(q.items[3].lastError!, /silent/);
});

// ---------- media hosting ---------------------------------------------------------

test("media: content-addressed keys, upload then public verification, failures surface", async () => {
  const dir = tmp();
  const file = join(dir, "clip one.mp4");
  writeFileSync(file, "fake-mp4-bytes");
  const key = mediaKey(file, "vts/b1");
  assert.match(key, /^vts\/b1\/clip one-[0-9a-f]{12}\.mp4$/);
  assert.equal(publicUrl({ publicBaseUrl: "https://pub.example.dev/" }, key), `https://pub.example.dev/vts/b1/clip%20one-${key.slice(-16)}`);

  const store = new Map<string, Buffer>();
  const calls: string[] = [];
  const fake = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${new URL(url).host}`);
    if (init?.method === "PUT") {
      assert.equal((init.headers as Record<string, string>).Authorization, "Bearer tok");
      store.set(decodeURIComponent(new URL(url).pathname.split("/objects/")[1]), init.body as Buffer);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    const body = store.get(decodeURIComponent(new URL(url).pathname.slice(1)));
    return body ? new Response(new Uint8Array(body), { status: 200, headers: { "content-type": "video/mp4" } }) : new Response("no", { status: 404 });
  }) as unknown as typeof fetch;
  const cfg = { accountId: "acc", apiToken: "tok", bucket: "b", publicBaseUrl: "https://pub.example.dev", fetchImpl: fake };
  const r = await uploadVideo(file, cfg, "vts/b1");
  assert.ok(r.verification.ok);
  assert.deepEqual(calls, ["GET pub.example.dev", "PUT api.cloudflare.com", "GET pub.example.dev"]);
  await uploadVideo(file, cfg, "vts/b1"); // already hosted: no second upload
  assert.equal(calls.filter((c) => c.startsWith("PUT")).length, 1);

  const v = await verifyPublicUrl("https://pub.example.dev/vts/b1/missing.mp4", 5, fake);
  assert.deepEqual([v.ok, v.problem], [false, "HTTP 404"]);
  assert.throws(() => mediaConfigFromEnv({}), /CLOUDFLARE_ACCOUNT_ID/);
});

// ---------- analytics ledger --------------------------------------------------------

test("analytics: export from queue, import metrics, per-1k-view comparison", () => {
  const dir = tmp();
  const q = new Queue(join(dir, "q.json"));
  q.enqueue({ ...item(dir, "v1"), caption: "Imagine waking up to this", audioId: "a1" });
  q.enqueue({ ...item(dir, "v2", "2099-01-02T12:00:00-06:00"), caption: "POV: Your channel finally takes off", audioId: "a1" });
  q.items[0].status = "scheduled";
  q.items[0].remoteId = "post1";
  assert.equal(syncFromQueue([], q.items).length, 1, "only published posts by default");
  let rows = syncFromQueue([], q.items, { includeUnpublished: true });
  assert.deepEqual(Object.keys(rows[0]), [...COLUMNS]);
  assert.deepEqual([rows[0].post_id, rows[0].publish_date, rows[0].caption, rows[0].audio_id, rows[0].template_variant, rows[0].count_tier], ["post1", "2099-01-01", "Imagine waking up to this", "a1", "dashboard", "1M"]);

  const csv = "platform,video_id,views,viewed_rate,avg_watch_pct,followers_gained,shares,caption\nyoutube,v1,\"12,000\",33.8%,92.5,24,6,HACKED\nyoutube,v2,4000,,61,2,1,\nyoutube,nope,1,,,,,\n";
  const res = importMetrics(rows, parseCsv(csv));
  assert.deepEqual([res.updated, res.unmatched], [2, ["nope"]]);
  assert.deepEqual([rows[0].views, rows[0].viewed_rate, rows[0].caption, rows[0].source], ["12000", "33.8", "Imagine waking up to this", "manual"]);
  assert.throws(() => importMetrics(rows, [{ platform: "youtube", video_id: "v1", views: "lots" }]), /views/);

  writeLedger(join(dir, "posts.csv"), rows);
  rows = readLedger(join(dir, "posts.csv"));
  assert.equal(rows.length, 2);
  // re-syncing from the queue must not wipe imported metrics
  assert.equal(syncFromQueue(rows, q.items, { includeUnpublished: true }).find((r) => r.video_id === "v1")!.views, "12000");

  const g = summarize(rows, "caption");
  const a = g.find((x) => x.key.includes("Imagine"))!;
  assert.deepEqual([a.posts, a.views, a.followersPer1kViews, a.sharesPer1kViews, a.avgWatchPct], [1, 12000, 2, 0.5, 92.5]);

  const row = rows.find((r) => r.video_id === "v2")!;
  row.source = "";
  assert.ok(applyBufferMetrics(row, { id: "p", status: "sent", sentAt: null, externalLink: "https://x/2", error: null, metrics: [{ type: "views", name: "Views", value: 5000, unit: null }, { type: "shares", name: "Shares", value: 3, unit: null }] }));
  assert.deepEqual([row.views, row.shares, row.post_url, row.source], ["5000", "3", "https://x/2", "buffer"]);
});
