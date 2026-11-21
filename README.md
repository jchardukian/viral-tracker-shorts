# viral-tracker-shorts

Automated YouTube Shorts and TikTok growth-tracker videos: an animated
subscriber/follower counter, a progress tracker, short captions, a
subscribe/follow CTA and beat-synced motion — rendered as 1080x1920 H.264/AAC
MP4s from config, with a gated publishing queue.

See `PROJECT_BRIEF.md` for the product spec.

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
| `src/spec.ts` | deterministic video spec: beat grid, counter steps, captions, CTA tap |
| `src/audio/` | per-platform sound library, licence gate, rotation, test-beat synth |
| `src/pipeline.ts` | sample + batch planning, manifests, queueing |
| `src/publish/` | queue (idempotency, approval, retries), Buffer adapter, scheduling |
| `config/` | channel names/numbers, captions, schedule, audio libraries, sample defs |

Rendering is plain `@napi-rs/canvas` → raw frames → `ffmpeg`. No browser, no
paid services, no AI video generation; a video takes ~5 s to render.

### Configuration

- `config/channels.json` — channel/profile name, handle, avatar colours, goal,
  starting count, growth per video, Buffer channel ids, on-screen disclosure.
- `config/captions.json` — caption sets, post titles and description per platform.
- `config/schedule.json` — timezone and the two daily slots per platform.
- `config/audio/youtube.json`, `config/audio/tiktok.json` — the sound rotation.

The names in `channels.json` (`Road to 100K`, `@roadto10k`) are placeholders.

The counter is a simulated animation. A small on-screen note
(`disclosure` in `channels.json`) and the post description say so; set
`disclosure` to `null` to hide the on-screen note.

## Music workflow

Once or twice a month, replace the `sounds` array in each platform's audio
file with 2–3 entries and set `activeFrom` / `expiresAt` to the rotation
window. Batches rotate through whatever is active on each video's date, and
animation is synced to each sound's `bpm` + `beatOffsetSec` (or an explicit
`beats` timestamp list).

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

`npm test` covers spec determinism, monotonic counters, beat alignment, safe
areas for both layouts, frame and MP4 output (resolution, codecs, fps, audio
present/silent), audio licence gating, rotation and expiry, missing files,
batch planning, DST-aware scheduling, duplicate prevention, the approval gate,
dry runs, retries, and the Buffer payload.

Fonts: Inter (SIL Open Font License), bundled in `assets/fonts/`.
