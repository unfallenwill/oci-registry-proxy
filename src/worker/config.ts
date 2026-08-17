/**
 * Registry resolution, allowlist enforcement, upstream credentials, and
 * per-isolate caches for auth realms and tokens.
 */

/** Environment contract for the proxy (vars come from wrangler.json, secrets are optional). */
export interface ProxyEnv {
	DEFAULT_REGISTRY?: string;
	ALLOWED_REGISTRIES?: string;
	REWRITE_ALL_LOCATIONS?: string;
	INSECURE_REGISTRIES?: string;
	/** Secret JSON: { "registry.example.com": "user:password", ... } */
	REGISTRY_AUTHS?: string;
}

export interface Upstream {
	/** Logical registry key as addressed by clients, e.g. "docker.io" or "ghcr.io:8443". */
	key: string;
	/** Registry API host (with optional port) to fetch from. */
	host: string;
	scheme: "http" | "https";
	isDockerFamily: boolean;
}

export class RegistryError extends Error {
	constructor(
		public status: number,
		public code: string,
		message: string,
		public detail?: unknown,
	) {
		super(message);
		this.name = "RegistryError";
	}
}

const DOCKER_FAMILY: Record<string, true> = {
	"docker.io": true,
	"index.docker.io": true,
	"registry-1.docker.io": true,
	"registry.hub.docker.com": true,
};

const HOST_RE = /^[a-z0-9._-]+(:[0-9]{1,5})?$/;

const LOCAL_HOSTS: Record<string, true> = {
	localhost: true,
	"127.0.0.1": true,
	"0.0.0.0": true,
	"::1": true,
};

export const DEFAULT_REGISTRY = "docker.io";

const listCache = new Map<string, string[]>();

export function list(envValue: string | undefined): string[] {
	// Env vars are static per isolate, so memoizing by source string is safe.
	const source = envValue ?? "";
	let cached = listCache.get(source);
	if (!cached) {
		cached = source.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
		listCache.set(source, cached);
	}
	return cached;
}

export function relayEnabled(env: ProxyEnv): boolean {
	return env.REWRITE_ALL_LOCATIONS === "true";
}

/**
 * Does a path segment look like an upstream registry host (rather than a
 * repository name component)? Dots/colons distinguish registry hosts from
 * repo path segments in the "/v2/{registry}/{repo}/..." addressing that
 * docker/crane/containerd clients produce (ECR pull-through-cache convention).
 */
export function looksLikeRegistry(segment: string): boolean {
	return HOST_RE.test(segment) && (segment.includes(".") || segment.includes(":"));
}

/**
 * Resolve the registry a client asked for.
 * `raw` is the path-prefix segment ("/ghcr.io/v2/..."), or undefined for the
 * bare "/v2/..." routes, which use DEFAULT_REGISTRY.
 */
export function parseRegistry(
	raw: string | undefined,
	env: ProxyEnv,
	opts: { fromPath?: boolean } = {},
): Upstream {
	const defaultName = (env.DEFAULT_REGISTRY ?? DEFAULT_REGISTRY).toLowerCase();
	const name = (raw ?? defaultName).toLowerCase();
	if (!HOST_RE.test(name)) {
		throw new RegistryError(400, "NAME_INVALID", `invalid registry name: ${name}`);
	}

	const isDockerFamily = DOCKER_FAMILY[name] === true;
	const host = isDockerFamily ? "registry-1.docker.io" : name;
	const bareHost = host.split(":")[0];
	const scheme: "http" | "https" =
		LOCAL_HOSTS[bareHost] === true || list(env.INSECURE_REGISTRIES).includes(bareHost)
			? "http"
			: "https";

	if (opts.fromPath) {
		const allowed = list(env.ALLOWED_REGISTRIES);
		const isDefault = name === defaultName;
		if (allowed.length > 0 && !isDefault && !allowed.includes(name) && !allowed.includes(bareHost)) {
			throw new RegistryError(
				403,
				"DENIED",
				`registry ${name} is not in ALLOWED_REGISTRIES`,
			);
		}
	}

	return { key: isDockerFamily ? "docker.io" : name, host, scheme, isDockerFamily };
}

let parsedAuths: { source: string; map: Map<string, string> } | null = null;

/** Server-side credentials for an upstream, as a ready Authorization header value. */
export function upstreamBasicAuth(upstream: Upstream, env: ProxyEnv): string | null {
	const source = env.REGISTRY_AUTHS ?? "";
	if (!source) return null;
	if (!parsedAuths || parsedAuths.source !== source) {
		const map = new Map<string, string>();
		try {
			for (const [k, v] of Object.entries(JSON.parse(source) as Record<string, unknown>)) {
				if (typeof v === "string" && v.length > 0) map.set(k.toLowerCase(), `Basic ${btoa(v)}`);
			}
		} catch {
			// Malformed secret: behave as if unset.
			return null;
		}
		parsedAuths = { source, map };
	}
	return parsedAuths.map.get(upstream.key) ?? parsedAuths.map.get(upstream.host) ?? null;
}

export interface Challenge {
	scheme: string;
	params: Record<string, string>;
}

export function parseWwwAuthenticate(value: string): Challenge | null {
	const m = /^(\w+)\s+(.*)$/s.exec(value.trim());
	if (!m) return null;
	const params: Record<string, string> = {};
	const paramsRe = /([a-zA-Z0-9_-]+)=(?:"([^"]*)"|([^,\s]+))/g;
	let hit: RegExpExecArray | null;
	while ((hit = paramsRe.exec(m[2])) !== null) {
		params[hit[1].toLowerCase()] = hit[2] ?? hit[3] ?? "";
	}
	return { scheme: m[1].toLowerCase(), params };
}

export interface RealmInfo {
	realm: string;
	service?: string;
}

const BUILTIN_REALMS: Record<string, RealmInfo> = {
	"docker.io": { realm: "https://auth.docker.io/token", service: "registry.docker.io" },
	"ghcr.io": { realm: "https://ghcr.io/token", service: "ghcr.io" },
};

const realmCache = new Map<string, RealmInfo | null>();

function evictOldest<T>(map: Map<string, T>): void {
	const first = map.keys().next().value;
	if (first !== undefined) map.delete(first);
}

function rememberRealmInfo(upstream: Upstream, info: RealmInfo | null) {
	realmCache.set(upstream.key, info);
	if (realmCache.size > 128) evictOldest(realmCache);
}

/** Cache a realm learned from an upstream 401 so /token/{key} can use it. */
export function rememberRealm(upstream: Upstream, wwwAuthenticate: string) {
	const parsed = parseWwwAuthenticate(wwwAuthenticate);
	if (!parsed || parsed.scheme !== "bearer" || !parsed.params.realm) {
		if (parsed && parsed.scheme !== "bearer") rememberRealmInfo(upstream, null);
		return;
	}
	rememberRealmInfo(upstream, { realm: parsed.params.realm, service: parsed.params.service });
}

/**
 * Find the Bearer token endpoint for an upstream: builtin table, isolate
 * cache, then discovery via a /v2/ ping.
 */
export async function resolveRealm(upstream: Upstream): Promise<RealmInfo | null> {
	const builtin = BUILTIN_REALMS[upstream.key];
	if (builtin) return builtin;
	if (realmCache.has(upstream.key)) return realmCache.get(upstream.key) ?? null;

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
	rememberRealmInfo(upstream, info);
	return info;
}

// Token cache (keyed by registry + query + credentials, isolate-local)

interface TokenEntry {
	body: string;
	expiresAt: number;
}

const tokenCache = new Map<string, TokenEntry>();

export function cachedToken(key: string): TokenEntry | null {
	const hit = tokenCache.get(key);
	if (!hit) return null;
	if (Date.now() >= hit.expiresAt) {
		tokenCache.delete(key);
		return null;
	}
	return hit;
}

export function rememberToken(key: string, body: string) {
	let ttl = 300;
	try {
		const parsed = JSON.parse(body) as { expires_in?: unknown };
		if (typeof parsed.expires_in === "number" && parsed.expires_in > 0) {
			ttl = parsed.expires_in;
		}
	} catch {
		return;
	}
	const lifetime = Math.max(15, ttl - 45);
	tokenCache.set(key, { body, expiresAt: Date.now() + lifetime * 1000 });
	if (tokenCache.size > 256) evictOldest(tokenCache);
}
