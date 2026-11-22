# Launch readiness — 14-day test

Status on 2026-11-21. Nothing has been scheduled or published.

## Status: live

Updated 2026-11-21 (evening, US Central).

| Area | State |
| --- | --- |
| Validation posts | **Both published automatically** at the scheduled time |
| R2 media hosting | **Working**; Buffer fetched the hosted files |
| Buffer publishing through this repo's code | **Working live**; all 56 batch posts scheduled with it |
| 14-day batch | **Scheduled**: 28 YouTube + 28 TikTok, 2026-11-22 to 2026-12-05 |
| Weekly review + top-up | **Scheduled** every Sunday 4:47 PM Central (`npm run autopilot`) |

### Validation results

| | YouTube | TikTok |
| --- | --- | --- |
| Scheduled for | 2026-11-21 18:35 CT | 2026-11-21 18:35 CT |
| Published | 18:35:03 CT, automatically | 18:36:43 CT, automatically |
| Link | https://www.youtube.com/watch?v=N0OGH4KB1kw | https://tiktok.com/@oh.my.trillion/video/7710787833107139854 |
| Buffer fetched the R2 file | yes | yes |
| Classified by Buffer as | Short | video post |
| Audio survived the upload | yes, confirmed by the owner | yes, confirmed by the owner |

The two validation posts went through the Buffer connector; the 56 batch posts
went through `src/publish/buffer.ts` with the API key.

### Standing decisions

- Fully automatic: new batches are scheduled without manual approval (`autoPublish` in `config/experiment.json`). Owner's decision, 2026-11-21.
- Weekly review every Sunday: record results, shift the next batch towards what worked, add at most one similar track and one similar caption when there is a clear winner.
- Two paid Buffer channel slots were added for these accounts.

### Still manual

- Stayed-vs-swiped rate and average percentage viewed are not available through Buffer. The owner sends screenshots from YouTube Studio / TikTok Studio; they are imported into `data/analytics/posts.csv`.

## Completed checks

- **Queue:** 56 experiment posts, all `pending_approval`; 2 validation posts, `pending_approval`. A dry-run publish sends nothing.
- **Balanced design.** Six sounds, five captions and two TikTok variants are arranged by a seeded search so nothing is tied to a time of day or a week: every option appears in both time slots and both weeks, and TikTok variants are 7/7 per slot. Tests enforce this.
- **No silent posts:** publishing refuses any video without embedded audio (`publishSilent: false`).
- **R2:** upload through `npm run media -- upload`, then anonymous download: HTTP 200, `video/mp4`, byte-identical, H.264 + AAC intact.
- **Buffer schema:** `createPost`, `post`, `channels` field names and enums checked against the live schema.
- **Tests:** 32 pass. Typecheck clean.
- **Channels:** Oh My Trillion (YouTube) and @oh.my.trillion (TikTok) are connected in Buffer and their ids are in config. The TikTok channel is set to automatic posting.

## Buffer channels: decision

**Owner decision (2026-11-21): add two paid channel slots to the current Buffer account.**

- Cost per Buffer's pricing page: about $6 per channel per month on Essentials monthly for channels up to 10, about $4 for the 11th. Going from 9 to 11 channels is roughly $10 a month.
- On a paid plan all 28 posts per platform can be scheduled at once (queue limit 5,000), so `--max-scheduled` is not needed.
- YouTube Shorts through Buffer: 100 per channel per day with a verified Buffer email, 5 without. Either covers 2 a day.
- The rejected alternative was a second Buffer account on the Free plan (no cost, but 10 queued posts per channel and exactly 2 Shorts a day).

## TikTok automatic publishing

- Buffer documents automatic (direct) publishing of TikTok videos for personal and business accounts; reminders are the fallback. An existing TikTok channel on this Buffer account is set to automatic, not reminders.
- Videos publish **publicly** by default; Buffer's API has no TikTok privacy field.
- No sound can be attached through Buffer on either platform.
- Buffer's help page links high-volume posting through the API or automation tools with more zero-view posts on TikTok. Worth watching in the first days.

## Useful commands

```bash
npm run queue -- list                 # every post and its state
npm run queue -- sync                 # what happened to each scheduled post
npm run autopilot                     # the weekly job, on demand
npm run analytics -- import <csv>     # add numbers from the platform dashboards
npm run analytics -- report           # compare captions, sounds, variants, count sizes
```

To pause automatic scheduling, set `autoPublish` to `false` in `config/experiment.json`.
