/**
 * Registry model: logical mirror groups resolved into ordered upstream
 * candidates, plus parsing of OCI distribution resource paths.
 */

import type { Settings } from "./settings";

/** Structured OCI error carrying the HTTP status and spec error code. */
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

/** One concrete registry endpoint a request can be sent to. */
export interface Upstream {
	/** Member host as configured ("docker.io", "docker.m.daocloud.io:5000"). */
	key: string;
	/** Host (with optional port) to connect to. */
	host: string;
	scheme: "http" | "https";
}

/** A logical registry ("docker.io") and its ordered member candidates. */
export interface RegistryGroup {
	key: string;
	isDockerFamily: boolean;
	members: Upstream[];
}

/** Hosts that all mean Docker Hub. */
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

/** Does a path segment look like a registry host (has dots/colons) rather than a repo name? */
export function looksLikeRegistry(segment: string): boolean {
	return HOST_RE.test(segment) && (segment.includes(".") || segment.includes(":"));
}

function canonicalKey(name: string): string {
	return DOCKER_FAMILY[name] === true ? "docker.io" : name;
}

function toUpstream(member: string, insecure: string[]): Upstream {
	const host = DOCKER_FAMILY[member] === true ? "registry-1.docker.io" : member;
	const scheme: "http" | "https" =
		LOCAL_HOSTS[host.split(":")[0]] === true || insecure.includes(host.split(":")[0])
			? "http"
			: "https";
	return { key: member, host, scheme };
}

/**
 * Resolve the registry a client asked for into a mirror group. `raw` is the
 * client-chosen registry (path prefix or embedded first path segment);
 * undefined means the default registry. Client-chosen registries are subject
 * to the allowlist; the default registry never is.
 */
export function resolveGroup(raw: string | undefined, settings: Settings): RegistryGroup {
	const name = canonicalKey((raw ?? settings.defaultRegistry).toLowerCase());
	if (!HOST_RE.test(name)) {
		throw new RegistryError(400, "NAME_INVALID", `invalid registry name: ${name}`);
	}
	if (raw !== undefined && settings.allowedRegistries.length > 0) {
		const bare = name.split(":")[0];
		const isDefault = name === settings.defaultRegistry;
		if (!isDefault && !settings.allowedRegistries.includes(name) && !settings.allowedRegistries.includes(bare)) {
			throw new RegistryError(403, "DENIED", `registry ${name} is not in ALLOWED_REGISTRIES`);
		}
	}
	const memberNames = settings.groups.get(name) ?? [name];
	return {
		key: name,
		isDockerFamily: DOCKER_FAMILY[name] === true,
		members: memberNames.map((member) => toUpstream(member, settings.insecureRegistries)),
	};
}

/**
 * Docker Hub semantics: official-image style single-segment repositories
 * ("nginx") live under the "library" namespace. Applies to every member of a
 * docker.io group (mirrors of Docker Hub follow the same convention).
 */
export function dockerizePath(path: string, dockerFamily: boolean): string {
	if (!dockerFamily) return path;
	return path.replace(
		/^\/v2\/([^/_][^/]*)\/(manifests|blobs|tags|referrers)(?=\/|$)/,
		"/v2/library/$1/$2",
	);
}

export type ResourceKind = "manifests" | "blobs" | "tags" | "referrers";

export interface ResourcePath {
	repo: string;
	kind: ResourceKind;
	/** Reference: tag or digest for manifests, digest for blobs/referrers, "list" for tags. */
	ref: string;
}

const RESOURCE_RE = /^\/v2\/(.+)\/(manifests|blobs|tags|referrers)(?:\/([^/]+))?$/;

/** Parse "/v2/{name}/{kind}/{ref}" into its parts; null if not a resource path. */
export function parseResourcePath(apiPath: string): ResourcePath | null {
	const m = RESOURCE_RE.exec(apiPath) as RegExpExecArray | null;
	if (!m) return null;
	const repo = m[1];
	const kind = m[2] as ResourceKind;
	const ref = m[3];
	if (repo.length === 0 || repo.startsWith("/") || repo.endsWith("/")) return null;
	if ((kind === "manifests" || kind === "blobs") && ref === undefined) return null;
	return { repo, kind, ref: ref ?? "" };
}

const DIGEST_RE = /^[a-z0-9]+(?:[.+_-][a-z0-9]+)*:[a-zA-Z0-9=_-]+$/;

/** Distinguishes digest references ("sha256:abc...") from tags ("latest", "v1"). */
export function isDigestRef(ref: string): boolean {
	return DIGEST_RE.test(ref);
}
