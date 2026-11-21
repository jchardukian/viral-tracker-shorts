import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { activeSounds, AudioError, type AudioLibrary, loadLibrary, pickSound, resolveAudio, type Sound } from "../src/audio/library.ts";
import { probe, renderFrame, renderVideo } from "../src/engine/encode.ts";
import { enqueueBatch, type Manifest, planBatch, planSamples } from "../src/pipeline.ts";
import { BufferPublisher, buildCreatePostInput } from "../src/publish/buffer.ts";
import { DryRunPublisher, PermanentError, type Publisher, publishQueue, Queue, type QueueItem, slotKey } from "../src/publish/queue.ts";
import { zonedIso } from "../src/publish/schedule.ts";
import { buildSpec, loadChannels, TEMPLATES } from "../src/spec.ts";
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
    const tpl = TEMPLATES[platform];
    for (const [name, r] of Object.entries(tpl.layout)) assert.ok(rectInSafe(r, tpl.safe), `${platform}.${name}`);
  }
});

test("the two platforms use different layouts", () => {
  assert.notDeepEqual(Object.keys(TEMPLATES.youtube.layout), Object.keys(TEMPLATES.tiktok.layout));
});

// ---------- rendering ---------------------------------------------------------

test("frames render at 1080x1920 and are not blank", () => {
  for (const platform of PLATFORMS) {
    const c = renderFrame(spec("f", platform), 3);
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

test("batch plan: 2/day/platform, unique ids and slots, final count grows daily, no adjacent look-alikes", () => {
  const plan = planBatch("2026-11-23", 14);
  assert.equal(plan.length, 14 * 2 * 2);
  assert.equal(new Set(plan.map((p) => p.spec.id)).size, plan.length);
  assert.equal(new Set(plan.map((p) => `${p.spec.platform}|${p.dueAt}`)).size, plan.length);
  for (const platform of PLATFORMS) {
    const ps = plan.filter((p) => p.spec.platform === platform);
    assert.equal(ps.length, 28);
    for (let i = 1; i < ps.length; i++) {
      assert.ok(ps[i].spec.endCount >= ps[i - 1].spec.endCount);
      if (i % 2 === 0) assert.ok(ps[i].spec.endCount > ps[i - 1].spec.endCount, "next day ends higher");
      const sig = (p: (typeof ps)[number]) => `${p.spec.caption}#${p.spec.audio.soundId}`;
      assert.notEqual(sig(ps[i]), sig(ps[i - 1]));
    }
  }
  assert.deepEqual(planBatch("2026-11-23", 2), planBatch("2026-11-23", 2));
});

test("sample plan is three per platform", () => {
  const s = planSamples("2026-11-21");
  assert.deepEqual(PLATFORMS.map((p) => s.filter((x) => x.spec.platform === p).length), [3, 3]);
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
  return { key: slotKey("youtube", "ch", dueAt), videoId: id, batchId: "b1", platform: "youtube" as const, file, audioMode: "silent" as const, title: "t", text: "x", dueAt };
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
  const m = planBatch("2026-11-23", 1).map((p) => ({ id: p.spec.id, platform: p.spec.platform, file: join(dir, `${p.spec.id}.mp4`), audio: p.spec.audio, title: p.title, text: p.text, dueAt: p.dueAt }) as Manifest);
  assert.equal(enqueueBatch(q, "b", m), 4);
  assert.equal(enqueueBatch(new Queue(join(dir, "q.json")), "b", m), 0);
  assert.ok(existsSync(join(dir, "q.json")));
});

test("Buffer payload matches the verified createPost schema", async () => {
  const dir = tmp();
  const q = new Queue(join(dir, "q.json"));
  q.enqueue(item(dir, "v1"));
  const it = q.items[0];
  const cfg = { apiKey: "k", mediaBaseUrl: "https://media.example.com/vts/", channelIds: { youtube: "a".repeat(24), tiktok: null }, youtubeCategoryId: "24" };
  const input = buildCreatePostInput(it, cfg);
  assert.equal(input.mode, "customScheduled");
  assert.equal(input.schedulingType, "automatic");
  assert.equal(input.dueAt, "2099-01-01T18:00:00.000Z");
  assert.deepEqual(input.assets, [{ video: { url: "https://media.example.com/vts/v1.mp4" } }]);
  assert.deepEqual(Object.keys(input.metadata), ["youtube"]);
  assert.throws(() => buildCreatePostInput({ ...it, platform: "tiktok" }, cfg), PermanentError);
  assert.throws(() => buildCreatePostInput(it, { ...cfg, mediaBaseUrl: "/local/path" }), PermanentError);

  const respond = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  const ok = new BufferPublisher({ ...cfg, fetchImpl: respond(200, { data: { createPost: { __typename: "PostActionSuccess", post: { id: "p1" } } } }) });
  assert.deepEqual(await ok.publish(it), { remoteId: "p1" });
  const invalid = new BufferPublisher({ ...cfg, fetchImpl: respond(200, { data: { createPost: { __typename: "InvalidInputError", message: "nope" } } }) });
  await assert.rejects(invalid.publish(it), PermanentError);
  const limited = new BufferPublisher({ ...cfg, fetchImpl: respond(429, {}) });
  await assert.rejects(limited.publish(it), (e: Error) => !(e instanceof PermanentError));
});
