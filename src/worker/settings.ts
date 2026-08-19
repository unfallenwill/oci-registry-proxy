/**
 * Environment contract and parsing into a typed, per-isolate memoized
 * `Settings` object. All configuration tolerance lives here: malformed values
 * degrade to defaults instead of failing requests.
 */

/** Environment contract for the proxy (vars from wrangler.json, secrets optional). */
export interface ProxyEnv {
	DEFAULT_REGISTRY?: string;
	ALLOWED_REGISTRIES?: string;
	INSECURE_REGISTRIES?: string;
	/** JSON mirror groups: { "docker.io": ["docker.io", "docker.m.daocloud.io"] }. Members are tried in order. */
	MIRROR_GROUPS?: string;
	/** Secret JSON of per-member upstream credentials: { "ghcr.io": "user:pat" }. */
	REGISTRY_AUTHS?: string;
	/** Secret shared token clients authenticate with (docker login). */
	PROXY_TOKEN?: string;
	/** "off" disables proxy authentication entirely (local development). */
	PROXY_AUTH?: string;
	/** Seconds a tag-addressed manifest may be served from the edge cache. Default 120. */
	MANIFEST_TAG_TTL?: string;
	/** "false" disables the edge cache. */
	BLOB_CACHE?: string;
}

/** How the proxy authenticates its own clients. */
export type AuthMode =
	/** PROXY_TOKEN is set: clients must exchange it for a signed bearer. */
	| "token"
	/** PROXY_AUTH=off: open proxy (local development / trusted networks). */
	| "off"
	/** No token configured and not explicitly disabled: refuse to serve (fail closed). */
	| "unconfigured";

export interface Settings {
	defaultRegistry: string;
	/** Logical registry name -> ordered member host list. Unlisted registries form single-member groups. */
	groups: Map<string, string[]>;
	allowedRegistries: string[];
	insecureRegistries: string[];
	authMode: AuthMode;
	/** Shared client secret (empty when unset). */
	proxyToken: string;
	manifestTagTtl: number;
	blobCache: boolean;
	/** Member host (lowercased) -> "user:password" for upstream basic auth. */
	registryAuths: Map<string, string>;
}

const DEFAULT_REGISTRY = "docker.io";
const DEFAULT_TAG_TTL = 120;

function splitList(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
}

function parseGroups(value: string | undefined): Map<string, string[]> {
	const groups = new Map<string, string[]>();
	if (!value) return groups;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return groups;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return groups;
	for (const [key, members] of Object.entries(parsed as Record<string, unknown>)) {
		if (!Array.isArray(members)) continue;
		const valid = members.filter((m): m is string => typeof m === "string" && m.trim().length > 0);
		if (valid.length > 0) groups.set(key.toLowerCase(), valid.map((m) => m.trim().toLowerCase()));
	}
	return groups;
}

function parseAuths(value: string | undefined): Map<string, string> {
	const auths = new Map<string, string>();
	if (!value) return auths;
	try {
		for (const [host, creds] of Object.entries(JSON.parse(value) as Record<string, unknown>)) {
			if (typeof creds === "string" && creds.length > 0) auths.set(host.toLowerCase(), creds);
		}
	} catch {
		// Malformed secret: behave as if unset.
	}
	return auths;
}

function parseAuthMode(env: ProxyEnv): AuthMode {
	if (env.PROXY_AUTH?.trim().toLowerCase() === "off") return "off";
	if (env.PROXY_TOKEN && env.PROXY_TOKEN.length > 0) return "token";
	return "unconfigured";
}

function parseTagTtl(value: string | undefined): number {
	const seconds = Number(value);
	return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : DEFAULT_TAG_TTL;
}

/** Build Settings from env, tolerating malformed values. Exposed for tests. */
export function buildSettings(env: ProxyEnv): Settings {
	return {
		defaultRegistry: (env.DEFAULT_REGISTRY ?? DEFAULT_REGISTRY).toLowerCase(),
		groups: parseGroups(env.MIRROR_GROUPS),
		allowedRegistries: splitList(env.ALLOWED_REGISTRIES),
		insecureRegistries: splitList(env.INSECURE_REGISTRIES),
		authMode: parseAuthMode(env),
		proxyToken: env.PROXY_TOKEN ?? "",
		manifestTagTtl: parseTagTtl(env.MANIFEST_TAG_TTL),
		blobCache: env.BLOB_CACHE !== "false",
		registryAuths: parseAuths(env.REGISTRY_AUTHS),
	};
}

// Env objects are stable per isolate; memoize so hot paths do not re-parse.
const settingsCache = new WeakMap<object, Settings>();

export function parseSettings(env: ProxyEnv): Settings {
	const hit = settingsCache.get(env);
	if (hit) return hit;
	const settings = buildSettings(env);
	settingsCache.set(env, settings);
	return settings;
}
