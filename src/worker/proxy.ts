/**
 * Transparent OCI Distribution proxy: forwards /v2 API calls to an upstream
 * registry, rewriting only what a proxy must rewrite (auth challenge realm,
 * upload Location URLs) while streaming request and response bodies.
 */

import type { Context } from "hono";
import {
	blobCacheEnabled,
	cachedToken,
	DEFAULT_REGISTRY,
	list,
	looksLikeRegistry,
	parseRegistry,
	parseWwwAuthenticate,
	relayEnabled,
	rememberRealm,
	rememberToken,
	resolveRealm,
	upstreamBasicAuth,
	RegistryError,
	type ProxyEnv,
	type Upstream,
} from "./config";
export type WorkerEnv = Env & ProxyEnv;
type AppContext = Context<{ Bindings: WorkerEnv }>;

/** Hop-by-hop and edge-injected request headers that must not reach the upstream. */
const REQ_DROP: Record<string, true> = {
	host: true,
	connection: true,
	"keep-alive": true,
	"proxy-authenticate": true,
	"proxy-authorization": true,
	te: true,
	trailer: true,
	"transfer-encoding": true,
	upgrade: true,
	expect: true,
	"content-length": true,
	cookie: true,
	"cdn-loop": true,
	"true-client-ip": true,
};

/** Response headers that must not be forwarded to the registry client. */
const RES_DROP: Record<string, true> = {
	connection: true,
	"keep-alive": true,
	"proxy-authenticate": true,
	"proxy-authorization": true,
	te: true,
	trailer: true,
	"transfer-encoding": true,
	upgrade: true,
	"alt-svc": true,
	"strict-transport-security": true,
	"report-to": true,
	"report-endpoint": true,
	nel: true,
};

/** Blob fetch ("/v2/{name}/blobs/{digest}"): digest-addressed content is immutable. */
const BLOB_PATH_RE = /^\/v2\/.+\/blobs\/[a-z0-9]+(?:[.+_-][a-z0-9]+)*:[a-zA-Z0-9=_-]+$/;

/** Cached-blob edge TTL; digests never change, so this only bounds entry freshness bookkeeping. */
const BLOB_CACHE_SECONDS = 30 * 24 * 60 * 60;

function ociError(status: number, code: string, message: string, detail?: unknown): Response {
	return Response.json(
		{ errors: [{ code, message, ...(detail !== undefined ? { detail } : {}) }] },
		{ status, headers: { "cache-control": "no-store" } },
	);
}

function toRegistryError(e: unknown): Response {
	if (e instanceof RegistryError) {
		return ociError(e.status, e.code, e.message, e.detail);
	}
	return ociError(500, "UNKNOWN", String(e));
}

/**
 * Copy client headers for the upstream request. accept-encoding is pinned to
 * identity when the client sent none, so a decompressing fetch can never
 * desynchronize content-encoding/content-length on the passthrough body.
 */
function forwardRequestHeaders(src: Headers): Headers {
	const out = new Headers();
	let sawAcceptEncoding = false;
	src.forEach((value, key) => {
		const k = key.toLowerCase();
		if (REQ_DROP[k] === true || k.startsWith("cf-") || k.startsWith("x-forwarded-")) return;
		if (k === "accept-encoding") sawAcceptEncoding = true;
		out.append(key, value);
	});
	if (!sawAcceptEncoding) out.set("accept-encoding", "identity");
	return out;
}

/**
 * Docker Hub semantics: an official-image style single-segment repository
 * ("nginx") lives under the "library" namespace.
 */
function dockerizePath(path: string): string {
	return path.replace(
		/^\/v2\/([^/_][^/]*)\/(manifests|blobs|tags|referrers)(?=\/|$)/,
		"/v2/library/$1/$2",
	);
}

function serializeChallenge(params: Record<string, string>): string {
	return `Bearer ${Object.entries(params)
		.map(([k, v]) => `${k}="${v}"`)
		.join(", ")}`;
}

interface RewriteCtx {
	upstream: Upstream;
	/** Client-visible base that upstream Locations are rewritten into ("" = proxy root). */
	locationBase: string;
	origin: string;
	relay: boolean;
}

function normalizeHostPort(host: string, scheme: string): string {
	const [hostname, port] = host.split(":");
	if (!port) return hostname;
	if ((scheme === "https" && port === "443") || (scheme === "http" && port === "80")) {
		return hostname;
	}
	return `${hostname}:${port}`;
}

/** Rewrite an upstream upload/redirect Location to point back through the proxy. */
function rewriteLocation(location: string, ctx: RewriteCtx): string {
	let url: URL;
	try {
		url = new URL(location, `${ctx.upstream.scheme}://${ctx.upstream.host}`);
	} catch {
		return location;
	}
	if (normalizeHostPort(url.host, url.protocol.slice(0, -1)) === normalizeHostPort(ctx.upstream.host, ctx.upstream.scheme)) {
		return `${ctx.origin}${ctx.locationBase}${url.pathname}${url.search}`;
	}
	if (ctx.relay) {
		const encoded = btoa(location).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
		return `${ctx.origin}/-/up/${encoded}`;
	}
	return location;
}

/** Point the Bearer challenge realm at our /token relay so auth flows through the proxy too. */
function rewriteChallenge(wwwAuthenticate: string, origin: string, registryKey: string): string {
	const parsed = parseWwwAuthenticate(wwwAuthenticate);
	if (!parsed || parsed.scheme !== "bearer" || !parsed.params.realm) return wwwAuthenticate;
	return serializeChallenge({ ...parsed.params, realm: `${origin}/token/${registryKey}` });
}

function copyResponseHeaders(src: Headers): Headers {
	const out = new Headers();
	src.forEach((value, key) => {
		const k = key.toLowerCase();
		if (RES_DROP[k] !== true && !k.startsWith("cf-")) out.append(key, value);
	});
	return out;
}

function wrapUpstreamResponse(res: Response, ctx: RewriteCtx): Response {
	const headers = copyResponseHeaders(res.headers);
	const location = headers.get("location");
	if (location) headers.set("location", rewriteLocation(location, ctx));
	if (res.status === 401) {
		const challenge = headers.get("www-authenticate");
		if (challenge) {
			headers.set("www-authenticate", rewriteChallenge(challenge, ctx.origin, ctx.upstream.key));
		}
	}
	return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * Generic /v2 proxy. GET/HEAD follow upstream redirects (blob CDNs stream
 * through the worker); mutating methods use manual redirects so upload
 * Locations can be rewritten before the client sees them.
 */
export function registryProxy(opts: { fromPath: boolean }) {
	return async (c: AppContext): Promise<Response> => {
		const env = c.env;
		const inUrl = new URL(c.req.url);
		let raw: string | undefined;
		let locationBase = "";
		let apiPath = inUrl.pathname;

		if (opts.fromPath) {
			raw = c.req.param("registry");
			locationBase = `/${raw}`;
			apiPath = inUrl.pathname.slice(locationBase.length);
		}
		if (!apiPath.startsWith("/v2/")) {
			return ociError(404, "NOT_FOUND", `not an OCI distribution path: ${inUrl.pathname}`);
		}

		// docker/crane/containerd address the proxy host itself as the registry,
		// so the upstream appears as the first repo-path segment
		// ("/v2/ghcr.io/owner/repo/..."). Peel it off (ECR pull-through-cache
		// convention); segments without dots/colons stay repo names under the
		// default registry.
		if (!opts.fromPath) {
			const embedded = /^\/v2\/([^/]+)\//.exec(apiPath);
			if (embedded && looksLikeRegistry(embedded[1])) {
				raw = embedded[1];
				locationBase = `/v2/${raw}`;
				apiPath = `/v2/${apiPath.slice(embedded[0].length)}`;
			}
		}

		let upstream: Upstream;
		try {
			upstream = parseRegistry(raw, env, { fromPath: raw !== undefined });
		} catch (e) {
			return toRegistryError(e);
		}
		const unavailable = (e: unknown) =>
			ociError(502, "UNAVAILABLE", `failed to reach upstream ${upstream.host}: ${String(e)}`);

		const upstreamPath = upstream.isDockerFamily ? dockerizePath(apiPath) : apiPath;
		const target = `${upstream.scheme}://${upstream.host}${upstreamPath}${inUrl.search}`;

		const method = c.req.method.toUpperCase();
		const mutating = method !== "GET" && method !== "HEAD";
		const headers = forwardRequestHeaders(c.req.raw.headers);
		const injectedAuth = upstreamBasicAuth(upstream, env);
		if (!headers.has("authorization") && injectedAuth) {
			headers.set("authorization", injectedAuth);
		}
		// The bare anonymous /v2/ ping must not commit to the default registry's
		// auth realm: under embedded addressing the real registry only appears
		// later in the resource path, and clients like go-containerregistry
		// install their bearer transport from the ping challenge (a terminal
		// 403/401 follows if the realm was wrong). Instead, rewrite the default
		// registry's Bearer realm to the wildcard relay /token/-, which resolves
		// the actual upstream from the scope ("repository:ghcr.io/owner/repo:pull").
		// Pings carrying credentials (or injected upstream creds) are validated
		// upstream as-is; authless upstreams keep their 200.
		if (raw === undefined && (apiPath === "/v2/" || apiPath === "/v2") && !mutating && !headers.has("authorization")) {
			let ping: Response;
			try {
				ping = await fetch(`${upstream.scheme}://${upstream.host}/v2/`, {
					headers: { accept: "application/json" },
					redirect: "follow",
				});
			} catch (e) {
				return unavailable(e);
			}
			const challenge = ping.headers.get("www-authenticate");
			const parsed = challenge === null ? null : parseWwwAuthenticate(challenge);
			if (ping.status === 401 && parsed?.scheme === "bearer") {
				ping.body?.cancel();
				return new Response(
					JSON.stringify({ errors: [{ code: "UNAUTHORIZED", message: "authentication required" }] }),
					{
						status: 401,
						headers: {
							"www-authenticate": serializeChallenge({
								...parsed.params,
								realm: `${inUrl.origin}/token/-`,
							}),
							"content-type": "application/json",
							"docker-distribution-api-version": "registry/2.0",
							"cache-control": "no-store",
						},
					},
				);
			}
			return wrapUpstreamResponse(ping, {
				upstream,
				locationBase,
				origin: inUrl.origin,
				relay: relayEnabled(env),
			});
		}

		// Blob edge cache (Cloudflare Cache API). Blob digests are immutable, so
		// a hit is valid forever. Entries are keyed by registry + canonical repo
		// path + digest (not by client auth, which would fragment the cache) and
		// are served to every client of this proxy — so the cache is only used
		// for registries without configured upstream credentials: content pulled
		// through REGISTRY_AUTHS must never become publicly retrievable. Range
		// requests bypass it (a stored entry would answer 200-full, not 206).
		let cacheKey: Request | null = null;
		if (
			blobCacheEnabled(env) &&
			injectedAuth === null &&
			(method === "GET" || method === "HEAD") &&
			!c.req.header("range") &&
			BLOB_PATH_RE.test(upstreamPath)
		) {
			cacheKey = new Request(new URL(`/-/cache/${upstream.key}${upstreamPath}`, inUrl.origin), {
				method: "GET",
			});
			const hit = await caches.default.match(cacheKey);
			if (hit) {
				if (method === "HEAD") {
					hit.body?.cancel();
					return new Response(null, { status: hit.status, headers: hit.headers });
				}
				return hit;
			}
		}

		const send = () =>
			fetch(target, {
				method,
				headers,
				body: mutating ? c.req.raw.body : undefined,
				redirect: mutating ? "manual" : "follow",
			});

		let res: Response;
		try {
			res = await send();
		} catch (e) {
			// Bodyless GET/HEAD is idempotent; one retry absorbs transient edge
			// network drops (blob CDN redirects are flaky from local dev).
			if (mutating) {
				return unavailable(e);
			}
			try {
				res = await send();
			} catch (e2) {
				return unavailable(e2);
			}
		}

		// Fill the blob cache while streaming the same bytes to the client. The
		// put() promise runs detached via waitUntil; failures (e.g. objects over
		// the 512 MB edge-cache limit) degrade to an uncached response.
		if (cacheKey !== null && method === "GET" && res.status === 200 && res.body) {
			const [toClient, toCache] = res.body.tee();
			const cacheHeaders = copyResponseHeaders(res.headers);
			cacheHeaders.delete("set-cookie");
			cacheHeaders.delete("vary");
			cacheHeaders.set("cache-control", `public, max-age=${BLOB_CACHE_SECONDS}`);
			c.executionCtx.waitUntil(
				caches.default
					.put(cacheKey, new Response(toCache, { status: 200, headers: cacheHeaders }))
					.catch(() => {}),
			);
			res = new Response(toClient, { status: res.status, statusText: res.statusText, headers: res.headers });
		}

		if (res.status === 401) {
			const challenge = res.headers.get("www-authenticate");
			if (challenge) rememberRealm(upstream, challenge);
		}
		return wrapUpstreamResponse(res, {
			upstream,
			locationBase,
			origin: inUrl.origin,
			relay: relayEnabled(env),
		});
	};
}

/**
 * Token relay backing the rewritten challenge realm. Forwards the client's
 * query (service/scope/account...) and credentials (or configured upstream
 * credentials) to the real realm, with an isolate-local token cache.
 */
export async function tokenRelay(c: AppContext): Promise<Response> {
	const env = c.env;
	const inUrl = new URL(c.req.url);
	const scopes = inUrl.searchParams.getAll("scope");
	let upstream: Upstream;
	try {
		if (c.req.param("registry") === "-") {
			// Wildcard realm from the bare ping: the real registry rides in the
			// scope's repository path ("repository:ghcr.io/owner/repo:pull").
			let candidate: string | undefined;
			for (const value of scopes) {
				for (const entry of value.split(" ")) {
					const parts = entry.split(":");
					if (parts[0] === "repository" && looksLikeRegistry(parts[1].split("/")[0])) {
						candidate = parts[1].split("/")[0];
						break;
					}
				}
				if (candidate !== undefined) break;
			}
			upstream = parseRegistry(candidate, env, { fromPath: candidate !== undefined });
		} else {
			upstream = parseRegistry(c.req.param("registry"), env, { fromPath: true });
		}
	} catch (e) {
		return toRegistryError(e);
	}

	let realm;
	try {
		realm = await resolveRealm(upstream);
	} catch (e) {
		return ociError(502, "UNAVAILABLE", `failed to discover token endpoint for ${upstream.key}: ${String(e)}`);
	}
	if (!realm) {
		return ociError(404, "DENIED", `no bearer token endpoint known for ${upstream.key}`);
	}


	// Clients under embedded addressing ("/v2/{registry}/{repo}/...") compute
	// scopes from their full view of the path, e.g.
	// repository:ghcr.io/owner/repo:pull. The upstream expects the repo
	// without the registry prefix, so strip it from every scope entry.
	if (scopes.length > 0 && upstream.key !== "docker.io") {
		const rewritten = scopes.map((value) =>
			value
				.split(" ")
				.map((entry) => {
					const parts = entry.split(":");
					const repoIndex = parts[0] === "repository" ? 1 : -1;
					if (repoIndex >= 0 && parts[repoIndex].startsWith(`${upstream.key}/`)) {
						parts[repoIndex] = parts[repoIndex].slice(upstream.key.length + 1);
					}
					return parts.join(":");
				})
				.join(" "),
		);
		if (rewritten.join(" ") !== scopes.join(" ")) {
			inUrl.searchParams.delete("scope");
			for (const s of rewritten) inUrl.searchParams.append("scope", s);
		}
	}

	const auth = c.req.header("authorization") ?? upstreamBasicAuth(upstream, env);
	const cacheKey = `${upstream.key}|${[...inUrl.searchParams].sort().map(([k, v]) => `${k}=${v}`).join("&")}|${auth ?? ""}`;
	const hit = cachedToken(cacheKey);
	if (hit) {
		return new Response(hit.body, {
			status: 200,
			headers: { "content-type": "application/json", "cache-control": "no-store" },
		});
	}

	const separator = realm.realm.includes("?") ? "&" : "?";
	const headers: HeadersInit = { accept: "application/json" };
	if (auth) (headers as Record<string, string>).authorization = auth;

	let res: Response;
	try {
		res = await fetch(`${realm.realm}${separator}${inUrl.search.slice(1)}`, {
			headers,
			redirect: "follow",
		});
	} catch (e) {
		return ociError(502, "UNAVAILABLE", `failed to reach token endpoint ${realm.realm}: ${String(e)}`);
	}

	if (res.status === 200) {
		const body = await res.text();
		rememberToken(cacheKey, body);
		return new Response(body, {
			status: 200,
			headers: {
				"content-type": res.headers.get("content-type") ?? "application/json",
				"cache-control": "no-store",
			},
		});
	}

	const out = new Headers();
	for (const key of ["content-type", "www-authenticate", "retry-after"]) {
		const value = res.headers.get(key);
		if (value) out.set(key, value);
	}
	out.set("cache-control", "no-store");
	return new Response(res.body, { status: res.status, headers: out });
}

/**
 * Relay for absolute upstream URLs (e.g. presigned upload endpoints) when
 * REWRITE_ALL_LOCATIONS forces every hop through the proxy. Disabled unless
 * explicitly enabled.
 */
export async function upstreamRelay(c: AppContext): Promise<Response> {
	if (!relayEnabled(c.env)) {
		return ociError(404, "NOT_FOUND", "upstream relay is disabled (set REWRITE_ALL_LOCATIONS=true to enable)");
	}
	let target: string;
	try {
		target = atob(c.req.param("url").replace(/-/g, "+").replace(/_/g, "/"));
	} catch {
		return ociError(400, "NAME_INVALID", "malformed relay target");
	}
	if (!/^https?:\/\//i.test(target)) {
		return ociError(400, "NAME_INVALID", "relay target must be an absolute http(s) URL");
	}

	const method = c.req.method.toUpperCase();
	const mutating = method !== "GET" && method !== "HEAD";
	let res: Response;
	try {
		res = await fetch(target, {
			method,
			headers: forwardRequestHeaders(c.req.raw.headers),
			body: mutating ? c.req.raw.body : undefined,
			redirect: mutating ? "manual" : "follow",
		});
	} catch (e) {
		return ociError(502, "UNAVAILABLE", `relay failed: ${String(e)}`);
	}

	const headers = copyResponseHeaders(res.headers);
	return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export async function statusHandler(c: AppContext): Promise<Response> {
	const env = c.env;
	return Response.json(
		{
			service: "oci-registry-proxy",
			defaultRegistry: env.DEFAULT_REGISTRY ?? DEFAULT_REGISTRY,
			allowedRegistries: list(env.ALLOWED_REGISTRIES),
			rewriteAllLocations: relayEnabled(env),
			upstreamCredentialsConfigured: Boolean(env.REGISTRY_AUTHS),
			insecureRegistries: list(env.INSECURE_REGISTRIES),
			blobCache: blobCacheEnabled(env),
		},
		{ headers: { "cache-control": "no-store" } },
	);
}
