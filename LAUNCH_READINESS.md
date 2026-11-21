# Launch readiness — 14-day test

Status on 2026-11-21. Nothing has been scheduled or published.

## Verdict

| Area | Ready? | Notes |
| --- | --- | --- |
| Videos (56) | **Yes** | rendered, 112/112 technical checks pass (56 + silent twins), all with embedded audio |
| Experiment design | **Yes** | fixed in this revision, see below |
| R2 media hosting | **Yes** | verified live; both validation videos already hosted and publicly retrievable |
| Buffer publishing | **No** | code is ready and unit-tested; blocked on channels + API key; never run live |
| TikTok automatic publishing | **Supported** | by Buffer's docs and schema; unproven for this project until the validation post |

## Completed checks

- **Queue:** 56 experiment posts, all `pending_approval`; 2 validation posts, `pending_approval`. A dry-run publish sends nothing.
- **Balance bug found and fixed.** The previous queue put every TikTok `analytics` video at 12:11 and every `profile` video at 19:37, so variant and time of day could not be separated. Now each variant gets each time slot 7 times and each week 7 times, with 4–6 posts per caption and 4–5 per sound. A test enforces this.
- **Captions and sounds vs time:** every caption and every sound appears 4–5 times in each slot, on both platforms.
- **No silent posts:** publishing refuses any video without embedded audio (`publishSilent: false`).
- **R2:** upload through `npm run media -- upload`, then anonymous download: HTTP 200, `video/mp4`, byte-identical, H.264 + AAC intact.
- **Buffer schema:** `createPost`, `post`, `channels` field names and enums checked against the live schema.
- **Tests:** 28 pass. Typecheck clean.

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

## Owner-only actions

1. Create the Road to Viral YouTube channel and TikTok account.
2. In Buffer, raise the channel count from 9 to 11 and connect both new accounts.
3. Create a Buffer API key (publish.buffer.com/settings/api) and provide it as `BUFFER_API_KEY`.
4. Approve the two validation posts.
5. After validation: confirm the experiment start date (the plan's 2026-11-30 is a placeholder) and approve the batch.

The two channel ids can be read from Buffer once the channels are connected (`npm run queue -- preflight --channels` lists them) and go in `config/channels.json` as `bufferChannelId`.

## Commands for the validation posts

```bash
# environment (never committed)
export BUFFER_API_KEY=…
export CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=…
export R2_BUCKET=viral-tracker-shorts-media
export MEDIA_BASE_URL=https://pub-5b52fac80f8044f19cda75ecf9b5d076.r2.dev

npm run queue -- validation --in 20          # one post per platform, due in 20 minutes
npm run queue -- approve --batch validation  # the explicit approval
npm run media -- upload                      # host + verify (already hosted: no-op)
npm run queue -- preflight --channels        # must end with READY
npm run queue -- publish --live --id validation-youtube
npm run queue -- publish --live --id validation-tiktok
npm run queue -- sync                        # after the due time: sent? link? error?
```

`preflight` is read-only and lists every check still blocking. Today it reports five: approval, media recorded on the queue items, two channel ids, API key.

What the validation must answer: does Buffer accept the R2 URL, does audio survive on each platform, and does each post publish automatically.

## Commands for the experiment (after validation succeeds)

```bash
npm run batch -- --start <date> --days 14            # only if the start date changes
npm run queue -- approve --batch <date>_14d
npm run media -- upload
npm run queue -- preflight --batch <date>_14d
npm run queue -- publish --live
```
