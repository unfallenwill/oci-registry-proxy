/**
 * Upstream-side authentication: WWW-Authenticate challenge parsing, bearer
 * realm discovery with an isolate-local cache, token acquisition with cache,
 * and the credential resolution for a member fetch.
 *
 * All upstream auth is handled server-side: the proxy either injects
 * configured credentials (REGISTRY_AUTHS), relays the client's Basic
 * credentials (open mode), or proceeds anonymously. Clients never talk to
 * upstream token endpoints directly.
 */

import type { Upstream } from "./registry";
import type { Settings } from "./settings";
import { LruMap } from "./util";

export interface Challenge {
	scheme: string;
	params: Record<string, string>;
}

/** Parse a WWW-Authenticate header value into scheme + params. */
export function parseWwwAuthenticate(value: string): Challenge | null {
	const m = /^(\w+)(?:\s+(.*))?$/s.exec(value.trim());
	if (!m) return null;
	const params: Record<string, string> = {};
	const paramsRe = /([a-zA-Z0-9_-]+)=(?:"([^"]*)"|([^,\s]+))/g;
	let hit: RegExpExecArray | null;
	while ((hit = paramsRe.exec(m[2])) !== null) {
		params[hit[1].toLowerCase()] = hit[2] ?? hit[3] ?? "";
	}
	return { scheme: m[1].toLowerCase(), params };
}

/** Serialize scheme + params back into a WWW-Authenticate header value. */
export function serializeChallenge(scheme: string, params: Record<string, string>): string {
	return `${scheme} ${Object.entries(params)
		.map(([k, v]) => `${k}="${v}"`)
		.join(", ")}`;
}

export interface RealmInfo {
	realm: string;
	service?: string;
}

const BUILTIN_REALMS: Record<string, RealmInfo> = {
	"docker.io": { realm: "https://auth.docker.io/token", service: "registry.docker.io" },
	"ghcr.io": { realm: "https://ghcr.io/token", service: "ghcr.io" },
};

const realmCache = new LruMap<string, RealmInfo | null>(128);

/** Cache a realm learned from an upstream 401 so later requests skip discovery. */
export function rememberRealm(upstream: Upstream, wwwAuthenticate: string): void {
	const parsed = parseWwwAuthenticate(wwwAuthenticate);
	if (!parsed || parsed.scheme !== "bearer" || !parsed.params.realm) {
		if (parsed && parsed.scheme !== "bearer") realmCache.set(upstream.host, null);
		return;
	}
	realmCache.set(upstream.host, { realm: parsed.params.realm, service: parsed.params.service });
}

/** Drop a cached realm (e.g. it stopped answering); exposed for tests. */
export function forgetRealm(upstream: Upstream): void {
	realmCache.delete(upstream.host);
}

/** Find the bearer token endpoint for an upstream: builtin table, isolate cache, then a /v2/ ping. */
export async function resolveRealm(upstream: Upstream): Promise<RealmInfo | null> {
	const builtin = BUILTIN_REALMS[upstream.key] ?? BUILTIN_REALMS[upstream.host];
	if (builtin) return builtin;
	if (realmCache.has(upstream.host)) return realmCache.get(upstream.host) ?? null;

	let info: RealmInfo | null = null;
	try {
		const res = await fetch(`${upstream.scheme}://${upstream.host}/v2/`, {
			redirect: "follow",
			headers: { accept: "application/json" },
		});
		res.body?.cancel();
		const challenge = res.headers.get("www-authenticate");
		if (challenge) {
			const parsed = parseWwwAuthenticate(challenge);
			if (parsed?.scheme === "bearer" && parsed.params.realm) {
				info = { realm: parsed.params.realm, service: parsed.params.service };
			}
		}
	} catch {
		// Discovery failure: report no realm rather than failing hard.
	}
	realmCache.set(upstream.host, info);
	return info;
}

interface TokenEntry {
	token: string;
	expiresAt: number;
}

const tokenCache = new LruMap<string, TokenEntry>(256);

/** Test hook: clear all cached upstream tokens. */
export function clearTokenCache(): void {
	tokenCache.clear();
}

/**
 * Fetch a bearer token for `scope` from the member's realm, using basic
 * credentials when provided. Results (including failures) are cached briefly
 * to keep hot pull paths free of token-endpoint round trips.
 */
export async function fetchUpstreamToken(
	upstream: Upstream,
	scope: string,
	basicAuth: string | null,
	now: () => number,
): Promise<string | null> {
	const realm = await resolveRealm(upstream);
	if (!realm) return null;

	const cacheKey = `${upstream.host}|${realm.realm}|${scope}|${basicAuth ?? ""}`;
	const hit = tokenCache.get(cacheKey);
	if (hit) {
		if (now() < hit.expiresAt) return hit.token;
		tokenCache.delete(cacheKey);
	}

	const url = new URL(realm.realm);
	if (realm.service) url.searchParams.set("service", realm.service);
	if (scope) url.searchParams.set("scope", scope);
	const headers: Record<string, string> = { accept: "application/json" };
	if (basicAuth) headers.authorization = basicAuth;

	let res: Response;
	try {
		res = await fetch(url, { headers, redirect: "follow" });
	} catch {
		return null;
	}
	if (res.status !== 200) {
		res.body?.cancel();
		return null;
	}
	let token: string | null = null;
	let ttl = 300;
	try {
		const body = (await res.json()) as { token?: unknown; access_token?: unknown; expires_in?: unknown };
		if (typeof body.token === "string") token = body.token;
		else if (typeof body.access_token === "string") token = body.access_token;
		if (typeof body.expires_in === "number" && body.expires_in > 0) ttl = body.expires_in;
	} catch {
		return null;
	}
	if (token === null) return null;
	// Refresh slightly before actual expiry.
	tokenCache.set(cacheKey, { token, expiresAt: now() + Math.max(15, ttl - 45) * 1000 });
	return token;
}

/** Credentials to present to a member: configured upstream auth wins, then relayed client Basic. */
export function memberCredentials(
	upstream: Upstream,
	settings: Settings,
	clientAuthorization: string | null,
): string | null {
	const configured = settings.registryAuths.get(upstream.key) ?? settings.registryAuths.get(upstream.host);
	if (configured) return `Basic ${btoa(configured)}`;
	if (clientAuthorization?.startsWith("Basic ")) return clientAuthorization;
	return null;
}

/**
 * Fetch a resource from a member, transparently completing a bearer auth
 * flow: on a 401 Bearer challenge, obtain a token for the resource scope and
 * retry once. Returns the final response (whatever its status).
 */
export async function requestUpstream(
	upstream: Upstream,
	url: string,
	init: RequestInit & { headers: Headers },
	scope: string,
	basicAuth: string | null,
	now: () => number,
): Promise<Response> {
	const send = (authorization: string | null) => {
		const headers = new Headers(init.headers);
		if (authorization) headers.set("authorization", authorization);
		else headers.delete("authorization");
		return fetch(url, { ...init, headers, redirect: "follow" });
	};

	let res: Response;
	try {
		res = await send(basicAuth);
	} catch (e) {
		// Network-level failure surfaces as a synthetic 502 for the strategy layer.
		return new Response(null, { status: 502, headers: { "x-proxy-error": String(e) } });
	}

	if (res.status === 401) {
		const challenge = res.headers.get("www-authenticate");
		if (challenge) {
			const parsed = parseWwwAuthenticate(challenge);
			if (parsed?.scheme === "bearer") {
				rememberRealm(upstream, challenge);
				const token = await fetchUpstreamToken(upstream, scope, basicAuth, now);
				if (token !== null) {
					res.body?.cancel();
					try {
						return await send(`Bearer ${token}`);
					} catch (e) {
						return new Response(null, { status: 502, headers: { "x-proxy-error": String(e) } });
					}
				}
			}
		}
	}
	return res;
}
