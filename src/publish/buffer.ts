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
 * Not yet exercised against a live account from this repo (needs an API key
 * and the destination channel ids) — see README "Deployment blockers".
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
  channelIds: { youtube: string | null; tiktok: string | null };
  youtubeCategoryId: string;
  fetchImpl?: typeof fetch;
}

export function buildCreatePostInput(item: QueueItem, cfg: BufferConfig) {
  const channelId = cfg.channelIds[item.platform];
  if (!channelId) throw new PermanentError(`no Buffer channel id configured for ${item.platform}`);
  // set by `media upload` after the file was verified publicly retrievable
  if (!item.mediaUrl || !/^https:\/\//.test(item.mediaUrl)) throw new PermanentError(`${item.videoId} has no public media URL; run "media upload" first`);
  const url = item.mediaUrl;
  return {
    channelId,
    // TikTok has no separate title for videos: the caption carries the title line and hashtags
    text: item.platform === "tiktok" ? `${item.title} · ${item.text}` : item.text,
    schedulingType: "automatic",
    mode: "customScheduled",
    dueAt: new Date(item.dueAt).toISOString(),
    needsApproval: false,
    assets: [{ video: { url } }],
    metadata:
      item.platform === "youtube"
        ? { youtube: { title: item.title.slice(0, 100), categoryId: cfg.youtubeCategoryId, madeForKids: false } }
        : { tiktok: { isAiGenerated: false } },
  };
}

export const GET_POST = `query Post($id: PostId!) {
  post(input: { id: $id }) {
    id status sentAt dueAt externalLink
    error { message }
    metrics { type name value unit }
  }
}`;

export interface RemotePost {
  id: string;
  status: string;
  sentAt: string | null;
  externalLink: string | null;
  error: string | null;
  metrics: { type: string; name: string; value: number | null; unit: string | null }[];
}

async function gql(cfg: BufferConfig, query: string, variables: unknown): Promise<any> {
  const res = await (cfg.fetchImpl ?? fetch)(BUFFER_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401 || res.status === 403) throw new PermanentError(`Buffer auth failed (HTTP ${res.status})`);
  if (res.status === 429 || res.status >= 500) throw new Error(`Buffer HTTP ${res.status}`); // retryable
  const body = (await res.json()) as any;
  if (body.errors?.length) throw new PermanentError(`Buffer GraphQL error: ${body.errors[0].message}`);
  return body.data;
}

/** Current state of a post in Buffer: whether it was sent, the platform link, any error, metrics. */
export async function fetchPost(cfg: BufferConfig, id: string): Promise<RemotePost> {
  const p = (await gql(cfg, GET_POST, { id })).post;
  if (!p) throw new PermanentError(`Buffer post ${id} not found`);
  return { id: p.id, status: p.status, sentAt: p.sentAt ?? null, externalLink: p.externalLink ?? null, error: p.error?.message ?? null, metrics: p.metrics ?? [] };
}

export interface RemoteChannel {
  id: string;
  name: string;
  service: string;
  organization: string;
  isDisconnected: boolean;
  isLocked: boolean;
}

/** Every channel the API key can see, across all of the account's organizations. */
export async function listChannels(cfg: BufferConfig): Promise<RemoteChannel[]> {
  const orgs = (await gql(cfg, "query { account { organizations { id name } } }", {})).account.organizations as { id: string; name: string }[];
  const out: RemoteChannel[] = [];
  for (const o of orgs) {
    const d = await gql(cfg, "query Channels($org: OrganizationId!) { channels(input: { organizationId: $org }) { id name displayName service isDisconnected isLocked } }", { org: o.id });
    for (const c of d.channels) out.push({ id: c.id, name: c.displayName ?? c.name, service: c.service, organization: o.name, isDisconnected: !!c.isDisconnected, isLocked: !!c.isLocked });
  }
  return out;
}

export class BufferPublisher implements Publisher {
  name = "buffer";
  live = true;
  constructor(private cfg: BufferConfig) {}

  async publish(item: QueueItem): Promise<PublishResult> {
    const input = buildCreatePostInput(item, this.cfg);
    const out = (await gql(this.cfg, CREATE_POST, { input })).createPost;
    if (out?.__typename === "PostActionSuccess" && out.post?.id) return { remoteId: out.post.id };
    const msg = `Buffer ${out?.__typename ?? "unknown response"}: ${out?.message ?? "no message"}`;
    // UnexpectedError may be transient; everything else (invalid input, limits, not found) is not
    if (out?.__typename === "UnexpectedError") throw new Error(msg);
    throw new PermanentError(msg);
  }
}
