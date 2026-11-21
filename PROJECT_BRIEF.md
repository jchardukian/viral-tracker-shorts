# Viral Tracker Shorts

Automated platform-native YouTube Shorts and TikTok growth-tracker videos.

## Product brief (November 21, 2026)

**Goal:** Test the simple tracker format seen on the reference channel "Im gonna be famous," with platform-specific presentation and minimal manual involvement. The user will supply the original screenshots and screen recording to the development agent; use them as the source of truth for layout, pacing, typography, and animation.

### Creative requirements
- YouTube version: recognizable YouTube-inspired channel/profile with channel name and animated subscriber number alongside it, dominant progress tracker, short captions and subscribe CTA.
- TikTok version: recognizable TikTok-inspired profile with username and animated follower number, progress tracker, short captions and follow CTA.
- Render 1080x1920 H.264/AAC MP4; account for platform UI safe areas; no watermarks copied from another creator.
- Aim to faithfully recreate the *mechanics*, not the original channel's protected branding/assets. Simulated numbers are an entertainment animation; avoid explicitly presenting them as verified live account data.
- Simple, polished, short-form videos; no animal races or unrelated concepts. First deliverable: three samples **per platform** for approval before mass generation.
- Target cadence: 2 videos/day/platform; optional batch 14 or 30 days, rotating a small caption set and number sequences without producing visually indistinguishable duplicates.

### Audio workflow: hard requirement
- Owner selects 2–3 candidate sounds for **each** platform, 1–2 times per month, by link and/or supplied licensed audio file.
- Separate YouTube and TikTok approved-audio configurations, rotation and per-video audio manifest.
- Programmatic mixing into fully automated uploads **only when the actual audio files are licensed for external embedding/upload**. A link to platform-native trending sound alone does not confer such rights or expose an accessible downloadable file.
- Export silent counterparts for native-audio workflows. Buffer cannot attach a native TikTok/YouTube music-library track automatically. Never claim this step is automatic without tested integration.
- Beat synchronization with configurable beat timestamps or optional local beat detection; don't block initial samples on perfect BPM detection.
- Track sound IDs/source, license/permission, file paths, approved platforms, and expiration.

### Workflow
- CLI script to generate deterministic batches from configuration; retain render metadata and manifests.
- Pluggable upload/scheduling pipeline (Buffer via tested API or export package if access is unavailable). Avoid inventing Buffer endpoints or integrations.
- Approval gate before posting; dry-run mode with no publishing.
- Store keys only in environment/secrets, never commit credentials or copyrighted songs.
- Persist queue/idempotency keys to prevent double-posts; logs/error handling.
- Basic tests for rendering, resolutions, safe areas, manifest, missing/unauthorized audio, duplicate scheduling.

### Initial scope
1. Inspect supplied reference screenshots and screen recording before designing.
2. Implement 2 templates, 3 sample MP4s per platform + still previews; use silent previews or authorized test music.
3. Present samples for user approval.
4. Only after approval, implement batch generation and working scheduler/publisher.
5. Later evaluate views, watch-through and follows/subs per 1,000 views. Monetization not guaranteed; repetitive-content eligibility is a consideration.

### Decisions already made
- One private repo for both platforms.
- Two videos daily on both TikTok and YouTube.
- Same core tracker mechanism; separate native-looking interfaces.
- No live account analytics required for visual counter.
- User picks a small pool of sounds periodically; no daily manual publication.
- Keep development low cost and avoid unnecessary complexity.

## Development

Set up tooling after reference inspection. Proposed stack: Remotion + TypeScript (or FFmpeg-based renderer if measurably simpler). Do not pre-commit to paid tools.

## Open blockers
- Creator-specific channel names/handles and native platform posting authorization.
- Reference media available to user; development agent must receive it separately.
- Approved audio files/rights for automated sound embedding.
