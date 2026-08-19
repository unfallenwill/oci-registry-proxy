import { describe, expect, it } from "vitest";
import { buildSettings, type ProxyEnv } from "./settings";

const env = (over: Partial<ProxyEnv> = {}): ProxyEnv => ({ ...over });

describe("buildSettings", () => {
	it("applies defaults for an empty env", () => {
		const s = buildSettings(env());
		expect(s.defaultRegistry).toBe("docker.io");
		expect(s.groups.size).toBe(0);
		expect(s.allowedRegistries).toEqual([]);
		expect(s.insecureRegistries).toEqual([]);
		expect(s.authMode).toBe("unconfigured");
		expect(s.manifestTagTtl).toBe(120);
		expect(s.blobCache).toBe(true);
		expect(s.registryAuths.size).toBe(0);
	});

	it("parses MIRROR_GROUPS into ordered lowercase groups", () => {
		const s = buildSettings(
			env({ MIRROR_GROUPS: '{"Docker.io": ["docker.io", "docker.m.Daocloud.IO"], "ghcr.io": ["ghcr.io"]}' }),
		);
		expect(s.groups.get("docker.io")).toEqual(["docker.io", "docker.m.daocloud.io"]);
		expect(s.groups.get("ghcr.io")).toEqual(["ghcr.io"]);
	});

	it("drops invalid mirror-group entries but keeps valid ones", () => {
		const s = buildSettings(
			env({ MIRROR_GROUPS: '{"a.io": ["a.io", 5, null], "b.io": [], "c.io": "nope", "d.io": ["d.io"]}' }),
		);
		expect(s.groups.get("a.io")).toEqual(["a.io"]);
		expect(s.groups.has("b.io")).toBe(false);
		expect(s.groups.has("c.io")).toBe(false);
		expect(s.groups.get("d.io")).toEqual(["d.io"]);
	});

	it("tolerates malformed MIRROR_GROUPS JSON", () => {
		expect(buildSettings(env({ MIRROR_GROUPS: "{oops" })).groups.size).toBe(0);
		expect(buildSettings(env({ MIRROR_GROUPS: "[1,2]" })).groups.size).toBe(0);
	});

	it("derives the auth mode: token > off > unconfigured", () => {
		expect(buildSettings(env({ PROXY_TOKEN: "ptk_x" })).authMode).toBe("token");
		expect(buildSettings(env({ PROXY_AUTH: "off" })).authMode).toBe("off");
		expect(buildSettings(env({ PROXY_AUTH: "OFF" })).authMode).toBe("off");
		// An explicitly disabled proxy wins over a configured token.
		expect(buildSettings(env({ PROXY_AUTH: "off", PROXY_TOKEN: "ptk_x" })).authMode).toBe("off");
		// Anything else without a token is fail-closed.
		expect(buildSettings(env({ PROXY_AUTH: "on" })).authMode).toBe("unconfigured");
	});

	it("parses allowlists and insecure registries as lowercase lists", () => {
		const s = buildSettings(
			env({ ALLOWED_REGISTRIES: " GHCR.io , quay.io", INSECURE_REGISTRIES: "Localhost:5100, corp.lan" }),
		);
		expect(s.allowedRegistries).toEqual(["ghcr.io", "quay.io"]);
		expect(s.insecureRegistries).toEqual(["localhost:5100", "corp.lan"]);
	});

	it("parses per-member registry credentials and ignores malformed secrets", () => {
		const ok = buildSettings(env({ REGISTRY_AUTHS: '{"GHCR.io": "u:p", "empty": "", "n": 3}' }));
		expect(ok.registryAuths.get("ghcr.io")).toBe("u:p");
		expect(ok.registryAuths.size).toBe(1);
		expect(buildSettings(env({ REGISTRY_AUTHS: "not json" })).registryAuths.size).toBe(0);
	});

	it("clamps the tag TTL to a positive integer with a default", () => {
		expect(buildSettings(env({ MANIFEST_TAG_TTL: "300" })).manifestTagTtl).toBe(300);
		expect(buildSettings(env({ MANIFEST_TAG_TTL: "0" })).manifestTagTtl).toBe(120);
		expect(buildSettings(env({ MANIFEST_TAG_TTL: "abc" })).manifestTagTtl).toBe(120);
		expect(buildSettings(env({ MANIFEST_TAG_TTL: "12.9" })).manifestTagTtl).toBe(12);
	});

	it("disables the edge cache only on explicit 'false'", () => {
		expect(buildSettings(env({ BLOB_CACHE: "false" })).blobCache).toBe(false);
		expect(buildSettings(env({ BLOB_CACHE: "true" })).blobCache).toBe(true);
		expect(buildSettings(env({ BLOB_CACHE: undefined })).blobCache).toBe(true);
	});
});
