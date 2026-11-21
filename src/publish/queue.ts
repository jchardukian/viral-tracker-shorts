import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sha256 } from "../engine/util.ts";
import type { Platform } from "../templates/types.ts";

export type QueueStatus = "pending_approval" | "approved" | "scheduled" | "failed";

export interface QueueItem {
  /** idempotency key: one post per platform + channel + time slot, ever */
  key: string;
  videoId: string;
  batchId: string;
  platform: Platform;
  /** file to upload: embedded-audio MP4 when licensed, otherwise the silent MP4 */
  file: string;
  audioMode: "embedded" | "silent";
  /** experiment dimensions, carried through to the analytics ledger */
  caption: string;
  audioId: string | null;
  variant: string;
  /** public HTTPS URL of the uploaded MP4; set by `media upload`, required to publish */
  mediaUrl: string | null;
  /** filled by `queue sync` once the platform has the post */
  published?: { status: string; sentAt: string | null; externalLink: string | null; error: string | null; checkedAt: string };
  title: string;
  text: string;
  /** ISO 8601 with UTC offset */
  dueAt: string;
  status: QueueStatus;
  attempts: number;
  remoteId: string | null;
  lastError: string | null;
  history: { at: string; event: string }[];
}

export interface PublishResult {
  remoteId: string;
}

export interface Publisher {
  name: string;
  /** true if calling publish() creates a real scheduled post */
  live: boolean;
  publish(item: QueueItem): Promise<PublishResult>;
}

/** Thrown for errors that will not succeed on retry (bad input, auth, limits). */
export class PermanentError extends Error {}

export const slotKey = (platform: Platform, channelRef: string, dueAt: string) =>
  sha256(`${platform}|${channelRef}|${new Date(dueAt).toISOString()}`).slice(0, 24);

export class Queue {
  items: QueueItem[] = [];
  constructor(public path: string) {
    if (existsSync(path)) this.items = JSON.parse(readFileSync(path, "utf8")).items;
  }

  save() {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, items: this.items }, null, 2));
    renameSync(tmp, this.path); // atomic: a crash never leaves a half-written queue
  }

  /** Adds an item unless its slot or video is already queued. Returns false for duplicates. */
  enqueue(item: Omit<QueueItem, "status" | "attempts" | "remoteId" | "lastError" | "history" | "mediaUrl" | "published">, now = new Date()): boolean {
    if (this.items.some((i) => i.key === item.key || (i.videoId === item.videoId && i.platform === item.platform))) return false;
    this.items.push({
      ...item,
      mediaUrl: null,
      status: "pending_approval",
      attempts: 0,
      remoteId: null,
      lastError: null,
      history: [{ at: now.toISOString(), event: "queued (pending approval)" }],
    });
    return true;
  }

  /** Explicit human approval. Nothing is ever published without passing through here. */
  approve(filter: (i: QueueItem) => boolean, now = new Date()): number {
    let n = 0;
    for (const i of this.items) {
      if (i.status === "pending_approval" && filter(i)) {
        i.status = "approved";
        i.history.push({ at: now.toISOString(), event: "approved" });
        n++;
      }
    }
    return n;
  }
}

export interface PublishOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  log?: (line: string) => void;
  /** restrict this run to matching items (e.g. a single validation post) */
  filter?: (item: QueueItem) => boolean;
}

/**
 * Sends every approved, not-yet-scheduled item to the publisher.
 *  - pending_approval items are never touched (approval gate)
 *  - scheduled items are never re-sent (duplicate prevention)
 *  - transient failures retry with exponential backoff; the queue is saved
 *    after every state change so a crash cannot cause a double post
 *  - non-live publishers (dry run) leave item state untouched
 */
export async function publishQueue(queue: Queue, publisher: Publisher, opts: PublishOptions = {}) {
  const maxAttempts = opts.maxAttempts ?? 4;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const summary = { sent: 0, failed: 0, skipped: 0 };
  for (const item of queue.items) {
    if (opts.filter && !opts.filter(item)) continue;
    if (item.status !== "approved" && !(item.status === "failed" && item.attempts < maxAttempts)) {
      summary.skipped++;
      continue;
    }
    if (item.status === "failed" && !publisher.live) {
      summary.skipped++;
      continue;
    }
    if (new Date(item.dueAt) <= now()) {
      log(`skip ${item.videoId}: slot ${item.dueAt} is in the past`);
      summary.skipped++;
      continue;
    }
    for (;;) {
      try {
        if (publisher.live) {
          item.attempts++;
          item.history.push({ at: now().toISOString(), event: `attempt ${item.attempts} via ${publisher.name}` });
          queue.save();
        }
        const res = await publisher.publish(item);
        if (publisher.live) {
          item.status = "scheduled";
          item.remoteId = res.remoteId;
          item.lastError = null;
          item.history.push({ at: now().toISOString(), event: `scheduled as ${res.remoteId}` });
          queue.save();
        }
        log(`${publisher.live ? "scheduled" : "dry-run ok"} ${item.videoId} -> ${item.dueAt} (${res.remoteId})`);
        summary.sent++;
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        item.lastError = msg;
        const permanent = e instanceof PermanentError;
        if (publisher.live) {
          item.history.push({ at: now().toISOString(), event: `error: ${msg}` });
          if (permanent || item.attempts >= maxAttempts) item.status = "failed";
          queue.save();
        }
        if (permanent || item.attempts >= maxAttempts || !publisher.live) {
          log(`FAILED ${item.videoId}: ${msg}`);
          summary.failed++;
          break;
        }
        const delay = (opts.baseDelayMs ?? 2000) * Math.pow(2, item.attempts - 1);
        log(`retry ${item.videoId} in ${delay}ms: ${msg}`);
        await sleep(delay);
      }
    }
  }
  return summary;
}

/** Validates and logs what would be sent. Never contacts any service. */
export class DryRunPublisher implements Publisher {
  name = "dry-run";
  live = false;
  calls: QueueItem[] = [];
  async publish(item: QueueItem): Promise<PublishResult> {
    if (!existsSync(item.file)) throw new PermanentError(`file missing: ${item.file}`);
    this.calls.push(item);
    return { remoteId: `dry-run:${item.key}` };
  }
}
