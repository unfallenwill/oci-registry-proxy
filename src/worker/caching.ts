/**
 * Edge cache policy and helpers.
 *
 * Two invariants:
 *  - Cache keys are namespaced by the mirror GROUP (not the member that
 *    happened to answer): a blob mirrored on B must be a hit when the next
 *    request is routed at A.
 *  - Nothing fetched with credentials is cached: entries are shared by every
 *    client of the proxy, so private upstream content must never enter it.
 *
 * The Cache API object is injected so unit tests can substitute an in-memory
 * implementation; the runtime uses caches.default.
 */

import type { RegistryGroup, ResourcePath } from "./registry";
import { isDigestRef } from "./registry";
import type { Settings } from "./settings";
import { sha256 } from "./util";

/** Digest-addressed content is immutable: 30 days only bounds bookkeeping. */
export const IMMUTABLE_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Minimal cache interface (subset of the Workers Cache API). */
export interface EdgeCache {
	match(key: Request): Promise<Response | undefined>;
	put(key: Request, response: Response): Promise<void>;
}

export function edgeCache(): EdgeCache {
	return caches.default;
}

/** Stable short fingerprint of the Accept header set (manifests vary by it). */
export async function acceptFingerprint(accept: string | null): Promise<string> {
	if (!accept) return "none";
	const normalized = accept
		.split(",")
		.map((part) => part.trim().toLowerCase())
		.sort()
		.join(",");
	const digest = await sha256(normalized);
	return Array.from(digest.slice(0, 8))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export interface CachePolicy {
	/** Cache-API request key for lookups and fills. */
	key: Request;
	ttlSeconds: number;
}

export interface CacheContext {
	settings: Settings;
	group: RegistryGroup;
	/** Client presented Basic credentials that were relayed upstream. */
	clientCredentials: boolean;
	/** The client asked for a byte range (cached entries are full-body 200s). */
	range: boolean;
	/** Origin URL of the incoming request (keys must be same-origin). */
	origin: string;
	/** Accept header value (manifests only). */
	accept: string | null;
}

/**
 * Cache policy for a resource request, or null when the response must not be
 * cached: listing endpoints (mutable), ranged requests (would answer 200-full),
 * or anything fetched under credentials (shared cache would leak it).
 */
export async function cachePolicyFor(resource: ResourcePath, ctx: CacheContext): Promise<CachePolicy | null> {
	if (!ctx.settings.blobCache) return null;
	if (ctx.range) return null;
	if (ctx.clientCredentials) return null;
	if (ctx.group.members.some((m) => ctx.settings.registryAuths.has(m.key) || ctx.settings.registryAuths.has(m.host))) {
		return null;
	}

	if (resource.kind === "blobs") {
		const url = new URL(`/-/cache/${ctx.group.key}/v2/${resource.repo}/blobs/${resource.ref}`, ctx.origin);
		return { key: new Request(url, { method: "GET" }), ttlSeconds: IMMUTABLE_TTL_SECONDS };
	}
	if (resource.kind === "manifests") {
		const fingerprint = await acceptFingerprint(ctx.accept);
		const url = new URL(
			`/-/cache/${ctx.group.key}/v2/${resource.repo}/manifests/${resource.ref}?a=${fingerprint}`,
			ctx.origin,
		);
		const ttlSeconds = isDigestRef(resource.ref) ? IMMUTABLE_TTL_SECONDS : ctx.settings.manifestTagTtl;
		return { key: new Request(url, { method: "GET" }), ttlSeconds };
	}
	// tags/referrers listings change as upstreams change: never cached.
	return null;
}

/** Serve a cached entry; HEAD requests get the headers without a body. */
export async function readCached(cache: EdgeCache, policy: CachePolicy, method: string): Promise<Response | null> {
	const hit = await cache.match(policy.key);
	if (!hit) return null;
	if (method === "HEAD") {
		hit.body?.cancel();
		return new Response(null, { status: hit.status, headers: hit.headers });
	}
	return hit;
}

/**
 * Fill the cache while streaming the same bytes to the client. The response
 * is tee'd; the cache branch is written in the background via waitUntil.
 * Failures (e.g. objects over the edge-cache size limit) degrade silently.
 */
export function fillInBackground(
	cache: EdgeCache,
	policy: CachePolicy,
	res: Response,
	waitUntil: (promise: Promise<unknown>) => void,
): Response {
	const [toClient, toCache] = res.body!.tee();
	const headers = new Headers(res.headers);
	headers.delete("set-cookie");
	headers.delete("vary");
	headers.set("cache-control", `public, max-age=${policy.ttlSeconds}`);
	waitUntil(
		cache.put(policy.key, new Response(toCache, { status: 200, headers })).catch(() => {}),
	);
	return new Response(toClient, { status: res.status, statusText: res.statusText, headers: res.headers });
}
