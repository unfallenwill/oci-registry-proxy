import { describe, expect, it } from "vitest";
import { buildSettings, type ProxyEnv } from "./settings";
import { dockerizePath, isDigestRef, looksLikeRegistry, parseResourcePath, RegistryError, resolveGroup } from "./registry";

const settings = (over: Partial<ProxyEnv> = {}) => buildSettings({ ...over });

describe("looksLikeRegistry", () => {
	it("accepts hosts with dots or ports", () => {
		expect(looksLikeRegistry("ghcr.io")).toBe(true);
		expect(looksLikeRegistry("registry.lan:5000")).toBe(true);
	});

	it("rejects plain repo-name segments", () => {
		expect(looksLikeRegistry("nginx")).toBe(false);
		expect(looksLikeRegistry("my_app")).toBe(false);
		expect(looksLikeRegistry("bad host")).toBe(false);
	});
});

describe("resolveGroup", () => {
	it("returns a single-member group for unknown registries", () => {
		const group = resolveGroup("ghcr.io", settings());
		expect(group.key).toBe("ghcr.io");
		expect(group.isDockerFamily).toBe(false);
		expect(group.members).toEqual([{ key: "ghcr.io", host: "ghcr.io", scheme: "https" }]);
	});

	it("uses the default registry when raw is undefined (always allowed)", () => {
		const group = resolveGroup(undefined, settings({ ALLOWED_REGISTRIES: "ghcr.io" }));
		expect(group.key).toBe("docker.io");
		expect(group.members).toEqual([{ key: "docker.io", host: "registry-1.docker.io", scheme: "https" }]);
	});

	it("normalizes docker family aliases to the docker.io group key", () => {
		for (const alias of ["index.docker.io", "registry-1.docker.io", "registry.hub.docker.com"]) {
			expect(resolveGroup(alias, settings()).key).toBe("docker.io");
		}
	});

	it("resolves a mirror group in configured order", () => {
		const s = settings({ MIRROR_GROUPS: '{"docker.io": ["docker.io", "docker.m.daocloud.io"]}' });
		const group = resolveGroup("docker.io", s);
		expect(group.isDockerFamily).toBe(true);
		expect(group.members.map((m) => m.host)).toEqual(["registry-1.docker.io", "docker.m.daocloud.io"]);
	});

	it("maps docker family members onto registry-1.docker.io", () => {
		const group = resolveGroup("index.docker.io", settings({ MIRROR_GROUPS: '{"docker.io": ["index.docker.io"]}' }));
		expect(group.members[0].host).toBe("registry-1.docker.io");
	});

	it("uses http for localhost and insecure registries", () => {
		expect(resolveGroup("localhost:5100", settings()).members[0].scheme).toBe("http");
		expect(resolveGroup("127.0.0.1", settings()).members[0].scheme).toBe("http");
		expect(resolveGroup("corp.lan", settings({ INSECURE_REGISTRIES: "corp.lan" })).members[0].scheme).toBe("http");
		expect(resolveGroup("corp.lan", settings()).members[0].scheme).toBe("https");
	});

	it("enforces the allowlist for client-chosen registries (name or bare host)", () => {
		const s = settings({ ALLOWED_REGISTRIES: "ghcr.io, corp.lan" });
		expect(() => resolveGroup("quay.io", s)).toThrowError(RegistryError);
		expect(() => resolveGroup("quay.io:443", s)).toThrowError(RegistryError);
		expect(resolveGroup("ghcr.io", s).key).toBe("ghcr.io");
		expect(resolveGroup("corp.lan:5000", s).key).toBe("corp.lan:5000"); // bare-host allowlisted
		expect(() => resolveGroup("other.lan:5000", s)).toThrowError(RegistryError);
		// The default registry is exempt even when not listed.
		expect(resolveGroup("docker.io", s).key).toBe("docker.io");
	});

	it("rejects syntactically invalid registry names but accepts single-label hosts", () => {
		expect(() => resolveGroup("bad host", settings())).toThrowError(RegistryError);
		expect(() => resolveGroup("nginx:port", settings())).toThrowError(RegistryError);
		// A single-label host is syntactically valid (path-prefix routes are explicit about intent).
		expect(resolveGroup("nginx", settings()).members[0].host).toBe("nginx");
	});

	it("allowlist denials carry DENIED with status 403", () => {
		try {
			resolveGroup("quay.io", settings({ ALLOWED_REGISTRIES: "ghcr.io" }));
			expect.unreachable();
		} catch (e) {
			const err = e as RegistryError;
			expect(err.status).toBe(403);
			expect(err.code).toBe("DENIED");
		}
	});
});

describe("dockerizePath", () => {
	it("rewrites single-segment repos into the library namespace for docker family", () => {
		expect(dockerizePath("/v2/nginx/manifests/latest", true)).toBe("/v2/library/nginx/manifests/latest");
		expect(dockerizePath("/v2/nginx/blobs/sha256:ab", true)).toBe("/v2/library/nginx/blobs/sha256:ab");
	});

	it("leaves namespaced and non-docker paths untouched", () => {
		expect(dockerizePath("/v2/library/nginx/manifests/latest", true)).toBe("/v2/library/nginx/manifests/latest");
		expect(dockerizePath("/v2/owner/app/manifests/v1", true)).toBe("/v2/owner/app/manifests/v1");
		// Single-segment repos are official images on Docker Hub: "owner" means library/owner too.
		expect(dockerizePath("/v2/owner/manifests/v1", true)).toBe("/v2/library/owner/manifests/v1");
		expect(dockerizePath("/v2/owner/app/manifests/v1", false)).toBe("/v2/owner/app/manifests/v1");
	});
});

describe("parseResourcePath", () => {
	it("parses manifests by tag and digest", () => {
		expect(parseResourcePath("/v2/owner/app/manifests/latest")).toEqual({
			repo: "owner/app",
			kind: "manifests",
			ref: "latest",
		});
		expect(parseResourcePath("/v2/app/manifests/sha256:ab12")).toEqual({
			repo: "app",
			kind: "manifests",
			ref: "sha256:ab12",
		});
	});

	it("parses blobs, tags list and referrers", () => {
		expect(parseResourcePath("/v2/a/b/blobs/sha256:00")).toEqual({ repo: "a/b", kind: "blobs", ref: "sha256:00" });
		expect(parseResourcePath("/v2/a/tags/list")).toEqual({ repo: "a", kind: "tags", ref: "list" });
		expect(parseResourcePath("/v2/a/referrers/sha256:00")).toEqual({
			repo: "a",
			kind: "referrers",
			ref: "sha256:00",
		});
	});

	it("returns null for non-resource paths", () => {
		expect(parseResourcePath("/v2/")).toBeNull();
		expect(parseResourcePath("/v2/app/manifests")).toBeNull(); // missing ref
		expect(parseResourcePath("/v2/app/unknownkind/x")).toBeNull();
		expect(parseResourcePath("/other/v2/app/manifests/x")).toBeNull();
	});
});

describe("isDigestRef", () => {
	it("recognizes digest-shaped references", () => {
		expect(isDigestRef("sha256:" + "a".repeat(64))).toBe(true);
		expect(isDigestRef("sha512:" + "Q".repeat(64))).toBe(true);
	});

	it("rejects tags", () => {
		expect(isDigestRef("latest")).toBe(false);
		expect(isDigestRef("v1.0")).toBe(false);
		expect(isDigestRef("sha256")).toBe(false);
	});
});
