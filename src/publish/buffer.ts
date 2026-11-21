import { basename } from "node:path";
import { PermanentError, type Publisher, type PublishResult, type QueueItem } from "./queue.ts";

/**
 * Buffer GraphQL publisher.
 *
 * Written against Buffer's public schema (https://api.buffer.com, introspected
 * 2026-11-21) and docs at developers.buffer.com:
 *   - createPost(input: CreatePostInput!): PostActionPayload!
 *   - mode: customScheduled + dueAt, schedulingType: automatic
 *   - assets: [{ video: { url } }] — Buffer has NO upload endpoint; the URL
 *     must be public HTTPS and stay reachable until the post publishes
 *   - metadata.youtube { title, categoryId } is required for YouTube
 *   - metadata.tiktok has only { title, isAiGenerated }: there is no field for
 *     attaching a platform-native sound, on either platform
 *
 * Not yet exercised against a live account from this repo (needs an API key,
 * connected channels and a public media host) — see README "Deployment blockers".
 */
export const BUFFER_ENDPOINT = "https://api.buffer.com";

export const CREATE_POST = `mutation CreatePost($input: CreatePostInput!) {
  createPost(input: $input) {
    __typename
    ... on PostActionSuccess { post { id status dueAt } }
    ... on MutationError { message }
  }
}`;

export interface BufferConfig {
  apiKey: string;
  /** public HTTPS prefix the MP4s are served from, e.g. https://media.example.com/vts */
  mediaBaseUrl: string;
  channelIds: { youtube: string | null; tiktok: string | null };
  youtubeCategoryId: string;
  fetchImpl?: typeof fetch;
}

export function buildCreatePostInput(item: QueueItem, cfg: BufferConfig) {
  const channelId = cfg.channelIds[item.platform];
  if (!channelId) throw new PermanentError(`no Buffer channel id configured for ${item.platform}`);
  if (!/^https:\/\//.test(cfg.mediaBaseUrl)) throw new PermanentError("MEDIA_BASE_URL must be a public https:// URL");
  const url = `${cfg.mediaBaseUrl.replace(/\/+$/, "")}/${encodeURIComponent(basename(item.file))}`;
  return {
    channelId,
    text: item.text,
    schedulingType: "automatic",
    mode: "customScheduled",
    dueAt: new Date(item.dueAt).toISOString(),
    needsApproval: false,
    assets: [{ video: { url } }],
    metadata:
      item.platform === "youtube"
        ? { youtube: { title: item.title.slice(0, 100), categoryId: cfg.youtubeCategoryId, madeForKids: false } }
        : { tiktok: { title: item.title } },
  };
}

export class BufferPublisher implements Publisher {
  name = "buffer";
  live = true;
  constructor(private cfg: BufferConfig) {}

  async publish(item: QueueItem): Promise<PublishResult> {
    const input = buildCreatePostInput(item, this.cfg);
    const res = await (this.cfg.fetchImpl ?? fetch)(BUFFER_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify({ query: CREATE_POST, variables: { input } }),
    });
    if (res.status === 401 || res.status === 403) throw new PermanentError(`Buffer auth failed (HTTP ${res.status})`);
    if (res.status === 429 || res.status >= 500) throw new Error(`Buffer HTTP ${res.status}`); // retryable
    const body = (await res.json()) as any;
    if (body.errors?.length) throw new PermanentError(`Buffer GraphQL error: ${body.errors[0].message}`);
    const out = body.data?.createPost;
    if (out?.__typename === "PostActionSuccess" && out.post?.id) return { remoteId: out.post.id };
    const msg = `Buffer ${out?.__typename ?? "unknown response"}: ${out?.message ?? JSON.stringify(body).slice(0, 200)}`;
    // UnexpectedError may be transient; everything else (invalid input, limits, not found) is not
    if (out?.__typename === "UnexpectedError") throw new Error(msg);
    throw new PermanentError(msg);
  }
}
