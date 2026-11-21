# viral-tracker-shorts

Automated YouTube Shorts and TikTok growth time-lapse videos, modelled on the
reference recording in this repo: a rapid hard-cut run through a creator
dashboard, day by day from 0 to the current count, under one static caption
— rendered as 1080x1920 H.264/AAC MP4s from config, with a gated publishing queue.

See `PROJECT_BRIEF.md` for the product spec.

## What the reference does (measured from the MP4)

`ScreenRecording_11-20-2026 19-17-28_1.mp4`, sampled every 0.25 s and with
per-frame change detection on the subscriber number:

| Aspect | Reference | This renderer |
| --- | --- | --- |
| Length | 18.4 s | 12–18 s, snapped to whole bars of the sound |
| Structure | time-lapse of daily dashboard screenshots, hard cuts, no transitions | same |
| Cut rate | ~260 changes; about every 2 frames (~15/s), slowing over the last ~3 s | 2-frame cuts, 16-step slowing tail |
| Ending / loop | final dashboard held ~2 s, then restarts at 0 | 2 s hold starting on a beat, loops to 0 |
| Subscribers | 0 → 110,266; long flat stretches and sudden spikes | generated curve with the same shape, or your real history CSV |
| Views / watch time | 28-day figures that rise *and* fall (874 → 17.2M → 3.6M) | rolling 28-day window over daily views |
| Latest content card | changes every cut; sometimes expanded with ranking / views / average % viewed / likes / comments, sometimes a notice, sometimes collapsed with older videos below | same states, re-rolled every cut |
| Caption | one caption for the whole video, two lines, white with black outline, over the content card | same position and style |
| Other motion | none: no CTA button, no progress bar, no captions changing | none |

The YouTube template reproduces that dashboard layout with an original mark
and icons (no platform logos). The TikTok template is the same time-lapse as a
follower-analytics screen: tabs, total followers with a 7-day delta, key
metrics, a follower growth chart that draws itself as days cut past, and the
most recent post.

## Preview the samples

`samples/` holds the six approval samples (3 YouTube, 3 TikTok):

- `samples/contact-sheet.png` — all six at a glance
- `samples/<id>.mp4` — playable video (GitHub plays MP4s in the file view)
- `samples/<id>.png` — still, `samples/<id>.json` — render manifest
- `samples/qa-report.json` — technical check results

Regenerate them with `npm install && npm run samples` (needs Node 22+ and
`ffmpeg`/`ffprobe` on PATH; about 40 s on 4 cores). Renders are deterministic.

## Commands

```
npm run samples                                   # the 6 approval samples
npm run batch -- --start 2026-11-23 --days 14     # 2/day/platform -> out/batches/
npm run batch -- --start 2026-11-23 --days 1 --platform tiktok --limit 1
npm run qa -- <dir>                               # technical checks on MP4s
npm run queue -- list
npm run queue -- approve --batch 2026-11-23_14d   # explicit approval
npm run queue -- publish                          # DRY RUN (default)
npm run queue -- publish --live                   # schedule approved items in Buffer
npm run queue -- export                           # upload-ready folder + schedule.csv
npm test && npm run typecheck
```

A batch renders each video, a silent twin (`*.silent.mp4`) when music is
embedded, a still and a manifest, runs QA, then adds the videos to
`state/queue.json` as `pending_approval`. Re-running a batch never queues the
same slot twice.

## How it is built

| Path | What |
| --- | --- |
| `src/engine/` | canvas drawing helpers, odometer counter, ffmpeg encoder, ffprobe QA |
| `src/templates/youtube.ts`, `tiktok.ts` | the two platform-native layouts, each with declared safe areas |
| `src/spec.ts` | deterministic video spec: cut schedule, daily snapshots, caption |
| `src/history.ts` | simulated growth curve, or real history from CSV |
| `src/audio/` | per-platform sound library, licence gate, rotation, test-beat synth |
| `src/pipeline.ts` | sample + batch planning, manifests, queueing |
| `src/publish/` | queue (idempotency, approval, retries), Buffer adapter, scheduling |
| `config/` | channel names/numbers, captions, schedule, audio libraries, sample defs |

Rendering is plain `@napi-rs/canvas` → raw frames → `ffmpeg`. No browser, no
paid services, no AI video generation; a video takes 5–8 s to render.

### Configuration

- `config/channels.json` — channel/profile name, handle, avatar colours, and the
  growth story: `startDate` (count is 0), `asOf` + `currentCount` (where the
  count stands today), `dailyGrowth` (after `asOf`), optional `history` CSV,
  Buffer channel ids, on-screen disclosure.
- `config/captions.json` — on-screen captions, content-card titles, post titles
  and description per platform.
- `config/schedule.json` — timezone and the two daily slots per platform.
- `config/audio/youtube.json`, `config/audio/tiktok.json` — the sound rotation.

The names in `channels.json` are placeholders.

### Simulated versus real numbers

By default the curve is generated, and a small "simulated numbers" pill is
shown beside the count (and the post description says so). The reference
works because its numbers are the channel's own; to do the same, export your
daily figures to a CSV and point `history` at it:

```
date,count,views28,watch_hours28
2026-01-12,0,0,0
2026-01-13,6,874,0.4
```

With a history file the headline numbers are real. The content-card detail
rows are still generated, so only set `disclosure` to `null` if you are
comfortable with that.

## Music workflow

Once or twice a month, replace the `sounds` array in each platform's audio
file with 2–3 entries and set `activeFrom` / `expiresAt` to the rotation
window. Batches rotate through whatever is active on each video's date. Each
video's length is a whole number of bars of its sound and the final hold lands
on a beat (`bpm` + `beatOffsetSec`, or an explicit `beats` timestamp list).

```jsonc
{
  "id": "yt-2026-12-track-a",
  "title": "Track name",
  "approvedPlatforms": ["youtube"],
  "link": "https://…",                       // reference only, never downloaded
  "file": "assets/audio/licensed/track-a.mp3", // git-ignored
  "license": { "status": "licensed", "embedAllowed": true, "proof": "invoice / licence id" },
  "bpm": 124, "beatOffsetSec": 0.12,
  "activeFrom": "2026-12-01", "expiresAt": "2026-12-28"
}
```

What the system does with a sound:

| Sound entry | Result |
| --- | --- |
| `owned`/`licensed` + `embedAllowed: true` + file present | mixed into the MP4, fully automated |
| link only, `platform-native-only`, `unknown`, or `embedAllowed: false` | **never embedded**; video exported silent, still beat-synced to the configured BPM; link recorded in the manifest |
| embeddable but file missing | batch fails loudly |
| nothing active for the date | silent export |

**Limitation:** a YouTube or TikTok sound link gives neither the right nor a
way to download and embed that track, and Buffer's API has no field for
attaching a platform-native sound on either platform (checked against its
schema: `metadata.tiktok` is `title` + `isAiGenerated` only). A trending native
sound can only be attached by hand in the app. So fully hands-off posting with
music requires audio files licensed for embedding and third-party upload;
otherwise videos post silent.

The three sounds shipped per platform are original test beats generated by
`src/audio/synth.ts` so the samples have audio to sync to. They are
placeholders, not a music recommendation.

## Publishing

`src/publish/buffer.ts` uses Buffer's GraphQL API (`createPost`,
`mode: customScheduled`, `schedulingType: automatic`, video asset by URL,
YouTube `title` + `categoryId`). Field names and enums were verified against
Buffer's live schema on 2026-11-21.

Safety rules enforced in code and tests:

- nothing is sent unless the item was explicitly approved (`queue approve`)
- `queue publish` is a dry run unless `--live` is passed
- one post per platform/channel/time slot (idempotency key), state saved
  atomically before and after every attempt, scheduled items never re-sent
- transient errors (429/5xx) retry with exponential backoff; invalid input,
  auth and limit errors fail immediately and are logged on the item

### Deployment blockers

The Buffer adapter is unit-tested against mocked responses but has **not been
run against a live account**. To go live:

1. **Buffer API key** — create at publish.buffer.com/settings/api, set `BUFFER_API_KEY`.
2. **Buffer channel ids** — connect the YouTube and TikTok accounts in Buffer
   and put their ids in `config/channels.json` (`bufferChannelId`).
3. **Public media host** — Buffer has no upload endpoint; it fetches each MP4
   from a public HTTPS URL that must stay reachable until the post publishes.
   Upload batch output to a bucket/CDN and set `MEDIA_BASE_URL` to its prefix.
   The upload step itself is not built yet.
4. **Real channel names/handles** in `config/channels.json`.
5. **Licensed audio files**, if posts should carry music (see above).

Until then, `queue export` produces an upload-ready folder plus `schedule.csv`.

## Tests

`npm test` covers spec determinism, the 0-to-current time-lapse, cut pacing
against the reference, simulated and CSV history, safe
areas for both layouts, frame and MP4 output (resolution, codecs, fps, audio
present/silent), audio licence gating, rotation and expiry, missing files,
batch planning, DST-aware scheduling, duplicate prevention, the approval gate,
dry runs, retries, and the Buffer payload.

Fonts: Inter (SIL Open Font License), bundled in `assets/fonts/`.
