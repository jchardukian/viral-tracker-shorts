# viral-tracker-shorts

Automated YouTube Shorts and TikTok growth time-lapse videos, modelled on the
reference recording in this repo: a rapid hard-cut run through a creator
dashboard, day by day from 0 to the current count, under one static caption
— rendered as 1080x1920 H.264/AAC MP4s from config, with media hosting, a
gated publishing queue and an analytics ledger.

See `PROJECT_BRIEF.md` for the product spec.

## Status

| Area | State |
| --- | --- |
| Renderer, three templates, samples | done, tested |
| Audio rotation, licence gate, silent exports | done, tested |
| 14-day experiment (28 + 28) | planned and rendered locally, queued as **pending approval**, not scheduled |
| MP4 hosting on Cloudflare R2 | done, **verified live** (upload + public download) |
| Buffer scheduling | built against Buffer's live schema, unit-tested; **not yet run live** |
| Analytics ledger (export / import / Buffer pull / report) | done, tested; Buffer pull not yet run live |

What still needs the owner is in [`LAUNCH_READINESS.md`](LAUNCH_READINESS.md), with the exact commands for the validation posts.

## What the reference does (measured from the MP4)

`ScreenRecording_11-20-2026 19-17-28_1.mp4`, sampled every 0.25 s and with
per-frame change detection on the subscriber number:

| Aspect | Reference | This renderer |
| --- | --- | --- |
| Length | 18.4 s | 12–18 s, snapped to whole bars of the sound |
| Structure | time-lapse of daily dashboard screenshots, hard cuts, no transitions | same |
| Cut rate | ~260 changes; about every 2 frames (~15/s), slowing over the last ~3 s | 2-frame cuts, 16-step slowing tail |
| Ending / loop | final dashboard held ~2 s, then restarts at 0 | 2 s hold starting on a beat, loops to 0 |
| Subscribers | 0 → 110,266; long flat stretches and sudden spikes | generated curve with the same shape, or a real history CSV |
| Views / watch time | 28-day figures that rise *and* fall | rolling 28-day window over daily views |
| Latest content card | changes every cut; expanded, with a notice, or collapsed | same states, re-rolled every cut |
| Caption | one caption for the whole video, two lines, over the content card | same position; static for the whole video |
| Other motion | none | none |

## Templates

| Platform | Variant | What it is |
| --- | --- | --- |
| YouTube | `dashboard` | creator-dashboard layout from the recording: channel + total subscribers, 28-day cards, latest published content |
| TikTok | `analytics` | follower-analytics screen: total followers with 7-day change, key metrics, growth chart that draws itself, recent posts |
| TikTok | `profile` | simplified profile screen: profile name, avatar, one very large follower count, posts grid |

Original mark and icons; no platform logos. `variants` in
`config/channels.json` lists which variants a batch rotates through.

## Preview the samples

`samples/` holds nine approval samples:

- `samples/contact-sheet.png` — final frame of all nine
- `samples/tiktok-variants.png` — the two TikTok variants side by side, same data
- `samples/reference-comparison.png` — reference frame next to the YouTube template
- `samples/youtube-dashboard-{1,2,3}.mp4`, `samples/tiktok-analytics-{1,2,3}.mp4`,
  `samples/tiktok-profile-{1,2,3}.mp4` (GitHub plays MP4s in the file view)
- `samples/<id>.json` — render manifest, `samples/qa-report.json` — technical checks

Regenerate with `npm install && npm run samples` (Node 22+, `ffmpeg`/`ffprobe`
on PATH; about a minute). Renders are deterministic.

## Commands

```
npm run samples                                    # the 9 approval samples
npm run batch -- --start 2026-11-30 --days 14      # plan + render + queue (pending approval)
npm run batch -- --start 2026-11-30 --days 14 --plan-only
npm run qa -- <dir>                                # technical checks on MP4s
npm run queue -- list
npm run queue -- approve --batch 2026-11-30_14d    # or --id <videoId>
npm run media -- upload [--id <videoId>]           # host approved MP4s on R2, verify public URLs
npm run queue -- publish                           # DRY RUN (default)
npm run queue -- publish --live [--id <videoId>]   # schedule approved items in Buffer
npm run queue -- validation [--in 20]              # queue one validation post per platform
npm run queue -- preflight [--batch <id>]          # read-only readiness check
npm run queue -- sync                              # what happened to each scheduled post
npm run queue -- export                            # upload-ready folder + schedule.csv
npm run analytics -- export | import <csv> | pull | report | recommend [--write]
npm run audio -- generate --id <id> (--prompt "…" | --like <id>) | detect <file>
npm test && npm run typecheck
```

The order for going live is: `batch` → review → `queue approve` →
`media upload` → `queue publish --live` → `queue sync` → `analytics …`.
Every step before `publish --live` is safe to run; nothing reaches Buffer
without both an approval and `--live`.

## How it is built

| Path | What |
| --- | --- |
| `src/engine/` | canvas drawing helpers, ffmpeg encoder, ffprobe QA |
| `src/templates/` | `youtube.ts`, `tiktok.ts`, `tiktok-profile.ts`, each with declared safe areas |
| `src/spec.ts` | deterministic video spec: cut schedule, daily snapshots, caption, variant |
| `src/history.ts` | simulated growth curve, or real history from CSV |
| `src/audio/` | per-platform sound library, licence gate, track generation, beat detection |
| `src/experiment.ts` | results-based weights and the balanced batch design |
| `src/pipeline.ts` | sample + batch planning, rotation, manifests, queueing |
| `src/publish/` | queue (idempotency, approval, retries), R2 media hosting, Buffer adapter, scheduling |
| `src/analytics.ts` | experiment ledger: CSV export/import, Buffer metrics, comparison report |
| `config/` | channel names/numbers, captions, schedule, audio libraries, sample defs |
| `experiments/` | committed plan for each prepared experiment |

Rendering is plain `@napi-rs/canvas` → raw frames → `ffmpeg`. No browser, no
paid services, no AI video generation; a video takes 5–8 s to render.

### Configuration

- `config/channels.json` — brand name (`Oh My Trillion`), handle (unconfirmed,
  change freely), avatar colours, template `variants`, the growth story
  (`startDate`, `asOf` + `currentCount`, `dailyGrowth`, optional `history` CSV),
  Buffer channel ids, on-screen disclosure.
- `config/captions.json` — on-screen captions, content-card titles, post titles
  and description per platform.
- `config/schedule.json` — timezone and the two daily slots per platform.
- `config/audio/youtube.json`, `config/audio/tiktok.json` — the sound rotation.

### Simulated numbers

The growth curve is generated, so a small "simulated numbers" pill sits beside
the count and the post description says so. This is deliberate: the videos
must not present simulated growth as genuine account analytics. `history` in
`channels.json` can point at a CSV of real daily figures
(`date,count,views28,watch_hours28`) if that ever becomes the better story.

## The 14-day experiment

`experiments/2026-11-30_14d/plan.csv` is the committed plan: 28 YouTube Shorts
and 28 TikToks, two per day per platform, 2026-11-30 to 2026-12-13.

- **Captions:** five per platform, 5–6 posts each.
- **Sounds:** six tracks per platform, 4–5 posts each.
- **TikTok variant:** `analytics` and `profile`, 14 posts each.
- **Final count:** five sizes (`countTiers` in `config/channels.json`): about
  300, 10K, 100K, 1M and 1B, 5–6 posts each. Every video has its own growth
  curve and ends on its own non-round number.
- **Arrangement:** a seeded search orders the batch so no two factors move
  together. Every caption, sound and variant appears in both time slots and
  both weeks, captions and sounds are mixed rather than paired, and the same
  option is not posted back-to-back. Tests enforce this.
- **Past posts:** the earlier uploads shown inside a video are fixed for the
  whole video, newest first with counts stepping down to the oldest; only the
  headline numbers run.

With six sounds, five captions and five count sizes, each option gets only 4–6 posts. That is
enough to spot a clear winner or loser, not to rank close ones.

The start date is a placeholder. To move it, re-run `batch` with a new
`--start`; nothing has been scheduled. The rendered MP4s live in `out/`
(git-ignored) and the 56 queue entries are `pending_approval`.

## Improving over time

The loop is: post → collect numbers → shift the next batch towards what worked
→ add new ideas → repeat.

1. **Collect.** `analytics export`, fill in the platform numbers, `analytics import`.
2. **Read.** `analytics report` compares captions, sounds and variants.
3. **Decide.** `analytics recommend` scores each option against the platform
   average (views, viewed rate, watch %, followers per 1,000 views — whichever
   exist) and proposes each one's share of the next batch. `--write` saves
   those shares to `config/experiment.json`.
4. **Plan.** The next `batch` gives winners more posts. 30% of posts (`explore`)
   are always spread evenly, so weak options keep a small share and an early
   fluke cannot take over. Options with fewer than `minPosts` results count as
   average.
5. **Add new ideas.**
   - Captions: add lines to `config/captions.json`. A new caption is treated
     as average until it has results, so it gets tried immediately.
   - Sounds like a winner: `npm run audio -- generate --id trk-phonk-2 --like trk-phonk-cowbell`
     makes a new original track from the winner's stored prompt, detects its
     tempo and adds it to both libraries. `--prompt "..."` starts a new style.

Captions must stay consistent with the simulated-numbers disclosure: describe
the scenario ("POV: …", "Imagine …") rather than claim the growth is real.

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
  "approvedPlatforms": ["youtube"],              // embedded only on these
  "link": "https://…",                           // native sound, kept in metadata, never downloaded
  "file": "assets/audio/licensed/track-a.mp3",   // git-ignored
  "license": { "status": "licensed", "embedAllowed": true, "proof": "invoice / licence id" },
  "bpm": 124, "beatOffsetSec": 0.12,
  "activeFrom": "2026-12-01", "expiresAt": "2026-12-28"
}
```

| Sound entry | Result |
| --- | --- |
| `owned`/`licensed` + `embedAllowed: true` + file present + platform approved | mixed into the MP4, fully automated |
| link only, `platform-native-only`, `unknown`, or `embedAllowed: false` | **never embedded**; silent export; link kept in the manifest and `plan.csv` (`native_sound_link`) for optional manual tests |
| embeddable but file missing, or wrong platform | batch fails loudly |
| nothing active for the date | silent export |

**Limitation:** a YouTube or TikTok sound link gives neither the right nor a
way to download and embed that track, and Buffer's API has no field for
attaching a platform-native sound on either platform (`metadata.tiktok` is
`title` + `isAiGenerated` only). A native sound can only be attached by hand
in the app. Nothing here tries to work around that.

The tracks in `assets/audio/tracks/` are originals generated with ElevenLabs
Music for this project: six instrumentals and two songs with vocals (prompts stored in the audio config).
The owner should confirm the plan's terms for commercial use. Tempo comes from
local beat detection (`npm run audio -- detect <file>`).

## Media hosting (Cloudflare R2)

Buffer has no upload endpoint; it fetches each MP4 from a public HTTPS URL at
publish time. `npm run media -- upload` puts approved videos in an R2 bucket
through the Cloudflare API, then downloads each one back with no credentials
and checks status, content type and exact size before recording the URL on the
queue item. Keys include a content hash, so re-running is a no-op and a URL
never changes meaning.

Environment (never committed):

```
CLOUDFLARE_ACCOUNT_ID=…
CLOUDFLARE_API_TOKEN=…          # R2 object write on the bucket
R2_BUCKET=viral-tracker-shorts-media
MEDIA_BASE_URL=https://pub-….r2.dev
```

Verified on 2026-11-21 against the real account: bucket
`viral-tracker-shorts-media` created, public `r2.dev` URL enabled, one sample
uploaded via this command, downloaded anonymously byte-identical (HTTP 200,
`video/mp4`, H.264 + AAC intact, range requests answered with 206).

Cloudflare describes `r2.dev` URLs as rate-limited and meant for
non-production use. At four fetches a day that is fine; attach a custom domain
to the bucket and change `MEDIA_BASE_URL` if volume grows. Storage for 56
videos is about 100 MB, inside R2's free allowance.

## Publishing (Buffer)

`src/publish/buffer.ts` uses Buffer's GraphQL API: `createPost` with
`mode: customScheduled`, `schedulingType: automatic`, the video by URL, and
YouTube `title` + `categoryId`; `post` for status, platform link, error and
metrics. Field names and enums were checked against Buffer's live schema.

Safety rules enforced in code and tests:

- nothing is sent unless the item was explicitly approved (`queue approve`)
- `queue publish` is a dry run unless `--live` is passed
- an item cannot be published without a verified public media URL
- silent videos are refused while `publishSilent` is false
- `--max-scheduled N` caps how many posts wait in Buffer per platform (plan limits)
- one post per platform/channel/time slot (idempotency key), state saved
  atomically before and after every attempt, scheduled items never re-sent
- transient errors (429/5xx) retry with exponential backoff; invalid input,
  auth and limit errors fail immediately and are logged on the item

Environment: `BUFFER_API_KEY` (create at publish.buffer.com/settings/api).

## Analytics ledger

`data/analytics/posts.csv`, one row per post:

`platform, post_id, video_id, publish_date, caption, audio_id,
template_variant, views, viewed_rate, avg_watch_pct, followers_gained, shares,
post_url, source`

- `analytics export` — creates/refreshes rows from the queue (`--all` includes
  posts not yet published). Existing metrics are kept.
- `analytics import <csv>` — merges numbers typed in from YouTube Studio /
  TikTok Studio. Rows match on `platform` + `video_id` or on `post_id`; accepts
  `12,000` and `33.8%`; only metric columns and `post_url` are taken, so an
  import cannot rewrite which caption or sound a post used.
- `analytics pull` — fills views, shares and follows from Buffer where Buffer
  reports them.
- `analytics report` — compares captions, sounds and variants.

Buffer's metric types do not include a viewed-versus-swiped rate or average
percentage viewed. Those two columns have to come from the platform dashboards
through `analytics import`.

## Remaining blockers

1. **Destination channels.** The owner will add two paid channel slots to the
   current Buffer account and connect the new Road to Viral YouTube and TikTok
   accounts; their ids then go in `config/channels.json`.
2. **Buffer API key** for this repo's automation (`BUFFER_API_KEY`).
3. **Live validation, one post per platform.** Needs 1 and 2 plus explicit
   approval. Until it has run, these are unknown: whether Buffer accepts the R2
   URL, whether audio survives each platform's upload, and whether the posts
   publish automatically.
4. **Handle** `@roadtoviral` is unconfirmed on both platforms.
5. **Experiment start date** to be confirmed once 1–3 are done.

## Tests

`npm test` (32 tests) covers spec determinism, the 0-to-current time-lapse,
cut pacing against the reference, simulated and CSV history, safe areas for
all three templates, frame and MP4 output, audio licence gating, rotation and
expiry, batch planning, the experiment's crossed design, DST-aware scheduling,
duplicate prevention, the approval gate, dry runs, retries, single-item
publishing, the Buffer payload and post lookup, R2 upload and public
verification, and the analytics ledger.

Fonts: Inter (SIL Open Font License), bundled in `assets/fonts/`.
