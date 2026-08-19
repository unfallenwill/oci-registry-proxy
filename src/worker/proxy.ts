/**
 * Pull-only OCI distribution proxy.
 *
 * Requests flow: method gate (pull-only) -> proxy auth gate -> registry group
 * resolution -> edge cache read -> member strategy (tag fallback / digest
 * race / hedged blobs) -> response wrap + cache fill.
 *
 * Push is not proxied: uploads and manifest PUTs are refused with 405.
 */

import type { Context } from "hono";
import { issueBearer, proxyChallenge, verifyBearer, verifyProxyToken } from "./auth";
import { cachePolicyFor, edgeCache, fillInBackground, readCached } from "./caching";
import { dockerizePath, isDigestRef, looksLikeRegistry, parseResourcePath, RegistryError, resolveGroup } from "./registry";
import { parseSettings, type ProxyEnv } from "./settings";
import { fetchHedged, fetchRace, fetchSequential, type Attempt } from "./strategy";
import { memberCredentials, requestUpstream } from "./upstream";

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
	authorization: true, // handled separately (proxy auth / credential relay)
};

/** Response headers that must not be forwarded to the client. */
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

export function ociError(status: number, code: string, message: string, detail?: unknown): Response {
	return Response.json(
		{ errors: [{ code, message, ...(detail !== undefined ? { detail } : {}) }] },
		{ status, headers: { "cache-control": "no-store" } },
	);
}

export function toOciError(e: unknown): Response {
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

function copyResponseHeaders(src: Headers): Headers {
	const out = new Headers();
	src.forEach((value, key) => {
		const k = key.toLowerCase();
		if (RES_DROP[k] !== true && !k.startsWith("cf-")) out.append(key, value);
	});
	return out;
}

/** Ping response body for a successful authenticated / open ping. */
const PING_OK = "{}";

export function registryProxy(opts: { fromPath: boolean }) {
	return async (c: AppContext): Promise<Response> => {
		const settings = parseSettings(c.env);
		const inUrl = new URL(c.req.url);
		const method = c.req.method.toUpperCase();
		const origin = inUrl.origin;

		// --- Pull-only: refuse every mutating method with a clear error. ---
		if (method !== "GET" && method !== "HEAD") {
			return ociError(
				405,
				"UNSUPPORTED",
				"this proxy is pull-only; pushing (blob uploads, manifest PUT/DELETE) is not supported",
			);
		}

		// --- Proxy auth gate (before any cache access). ---
		const token = settings.proxyToken;
		let relayAuthorization: string | null = null;
		if (settings.authMode !== "off") {
			const authorization = c.req.header("authorization") ?? null;
			const match = /^Bearer (.+)$/.exec(authorization ?? "");
			const check =
				match && match[1].startsWith("prx.")
					? await verifyBearer(match[1], token, Date.now())
					: { ok: false as const };
			if (!check.ok) {
				if (settings.authMode === "unconfigured") {
					return ociError(
						401,
						"UNAUTHORIZED",
						"authentication required, but no PROXY_TOKEN is configured; set the secret or disable auth with PROXY_AUTH=off",
					);
				}
				return new Response(
					JSON.stringify({ errors: [{ code: "UNAUTHORIZED", message: "authentication required" }] }),
					{
						status: 401,
						headers: {
							"www-authenticate": proxyChallenge(origin),
							"content-type": "application/json",
							"docker-distribution-api-version": "registry/2.0",
							"cache-control": "no-store",
						},
					},
				);
			}
			// Our bearer never travels upstream; upstream creds come from settings.
		} else {
			relayAuthorization = c.req.header("authorization") ?? null;
		}

		// --- Which registry is the client addressing? ---
		let raw: string | undefined;
		let apiPath = inUrl.pathname;
		if (opts.fromPath) {
			raw = c.req.param("registry").toLowerCase();
			apiPath = inUrl.pathname.slice(`/${raw}`.length) || "/";
		} else {
			const embedded = /^\/v2\/([^/]+)\//.exec(apiPath);
			if (embedded && looksLikeRegistry(embedded[1])) {
				raw = embedded[1].toLowerCase();
				apiPath = `/v2/${apiPath.slice(embedded[0].length)}`;
			}
		}

		let group;
		try {
			group = resolveGroup(raw, settings);
		} catch (e) {
			return toOciError(e);
		}

		// --- Ping: /v2 or /v2/ ---
		if (apiPath === "/v2" || apiPath === "/v2/") {
			if (settings.authMode === "token") {
				// The bearer already verified: docker login / client pings succeed here.
				return new Response(PING_OK, {
					status: 200,
					headers: {
						"content-type": "application/json",
						"docker-distribution-api-version": "registry/2.0",
						"cache-control": "no-store",
					},
				});
			}
			const res = await fetchSequential(group, pingAttempt(relayAuthorization, settings), {
				notFoundCode: "UNKNOWN",
			});
			if (!res.ok) return toOciError(res.error);
			return wrapUpstreamResponse(res.res, { authMode: settings.authMode, origin });
		}

		// --- Resource requests: manifests, blobs, tags, referrers ---
		const upstreamPath = dockerizePath(apiPath, group.isDockerFamily);
		const resource = parseResourcePath(upstreamPath);
		if (!resource) {
			return ociError(404, "NOT_FOUND", `unsupported distribution endpoint: ${inUrl.pathname}`);
		}

		const clientHasCredentials = relayAuthorization !== null;
		const cachePolicy = await cachePolicyFor(resource, {
			settings,
			group,
			clientCredentials: clientHasCredentials,
			range: c.req.header("range") !== undefined,
			origin,
			accept: c.req.header("accept") ?? null,
		});
		if (cachePolicy) {
			const hit = await readCached(edgeCache(), cachePolicy, method);
			if (hit) return hit;
		}

		const headers = forwardRequestHeaders(c.req.raw.headers);
		const scope = `repository:${resource.repo}:pull`;
		const attempt: Attempt = (member, signal) => {
			const creds = settings.authMode === "off" ? relayAuthorization : memberCredentials(member, settings, null);
			const basic = creds !== null && creds.startsWith("Basic ") ? creds : null;
			return requestUpstream(
				member,
				`${member.scheme}://${member.host}${upstreamPath}${inUrl.search}`,
				{ method, headers, signal },
				scope,
				basic,
				Date.now,
			);
		};

		let result;
		if (resource.kind === "manifests") {
			result = isDigestRef(resource.ref)
				? await fetchRace(group, attempt, { notFoundCode: "MANIFEST_UNKNOWN" })
				: await fetchSequential(group, attempt, { notFoundCode: "MANIFEST_UNKNOWN" });
		} else if (resource.kind === "blobs") {
			result = await fetchHedged(group, attempt, { notFoundCode: "BLOB_UNKNOWN" });
		} else {
			result = await fetchSequential(group, attempt, { notFoundCode: "NAME_UNKNOWN" });
		}
		if (!result.ok) return toOciError(result.error);

		const wrapped = wrapUpstreamResponse(result.res, { authMode: settings.authMode, origin });
		if (cachePolicy && method === "GET" && wrapped.status === 200 && wrapped.body) {
			return fillInBackground(edgeCache(), cachePolicy, wrapped, (p) =>
				c.executionCtx.waitUntil(p),
			);
		}
		return wrapped;
	};
}

/** A /v2/ ping against a member, server-side authenticated. */
function pingAttempt(relayAuthorization: string | null, settings: ReturnType<typeof parseSettings>): Attempt {
	return (member, signal) => {
		const basic =
			settings.authMode === "off" && relayAuthorization?.startsWith("Basic ")
				? relayAuthorization
				: memberCredentials(member, settings, null);
		return requestUpstream(
			member,
			`${member.scheme}://${member.host}/v2/`,
			{ method: "GET", headers: new Headers({ accept: "application/json" }), signal },
			"",
			basic,
			Date.now,
		);
	};
}

/** Copy upstream headers; in token mode, upstream 401 challenges point at our realm. */
function wrapUpstreamResponse(
	res: Response,
	opts: { authMode: "token" | "off" | "unconfigured"; origin: string },
): Response {
	const headers = copyResponseHeaders(res.headers);
	if (res.status === 401 && opts.authMode === "token" && headers.has("www-authenticate")) {
		headers.set("www-authenticate", proxyChallenge(opts.origin));
	}
	return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** Token endpoint behind the proxy's own auth challenge (docker login target). */
export async function authEndpoint(c: AppContext): Promise<Response> {
	const settings = parseSettings(c.env);
	if (settings.authMode === "off") {
		return ociError(404, "NOT_FOUND", "proxy authentication is disabled (PROXY_AUTH=off)");
	}
	if (settings.authMode === "unconfigured") {
		return ociError(
			503,
			"UNAVAILABLE",
			"no PROXY_TOKEN configured; set the secret or disable auth with PROXY_AUTH=off",
		);
	}
	const token = settings.proxyToken;
	const authorization = c.req.header("authorization") ?? null;
	if (!(await verifyProxyToken(authorization, token))) {
		return new Response(
			JSON.stringify({ errors: [{ code: "UNAUTHORIZED", message: "invalid proxy token" }] }),
			{
				status: 401,
				headers: {
					"www-authenticate": 'Basic realm="oci-registry-proxy"',
					"content-type": "application/json",
					"cache-control": "no-store",
				},
			},
		);
	}
	// Subject = username the client logged in with (any value is accepted).
	let sub = "user";
	if (authorization?.startsWith("Basic ")) {
		try {
			const decoded = atob(authorization.slice(6));
			sub = decoded.slice(0, decoded.indexOf(":")) || sub;
		} catch {
			// keep default
		}
	}
	const bearer = await issueBearer(token, sub, Date.now());
	return Response.json(
		{ token: bearer, access_token: bearer, expires_in: 3600 },
		{ headers: { "cache-control": "no-store" } },
	);
}

export function statusHandler(c: AppContext): Response {
	const settings = parseSettings(c.env);
	return Response.json(
		{
			service: "oci-registry-proxy",
			mode: "pull-only",
			defaultRegistry: settings.defaultRegistry,
			mirrorGroups: Object.fromEntries([...settings.groups].map(([k, v]) => [k, v])),
			allowedRegistries: settings.allowedRegistries,
			insecureRegistries: settings.insecureRegistries,
			authMode: settings.authMode,
			edgeCache: settings.blobCache,
			manifestTagTtlSeconds: settings.manifestTagTtl,
			upstreamCredentialsConfigured: [...settings.registryAuths.keys()],
		},
		{ headers: { "cache-control": "no-store" } },
	);
}
