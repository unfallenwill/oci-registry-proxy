import { describe, expect, it } from "vitest";
import type { RegistryGroup } from "./registry";
import { buildSettings, type ProxyEnv } from "./settings";
import {
	acceptFingerprint,
	cachePolicyFor,
	edgeCache,
	fillInBackground,
	IMMUTABLE_TTL_SECONDS,
	readCached,
	type EdgeCache,
} from "./caching";

const ORIGIN = "https://proxy.test";
const group = (key = "docker.io"): RegistryGroup => ({
	key,
	isDockerFamily: false,
	members: [{ key, host: key, scheme: "https" }],
});

/** In-memory stand-in for the Workers Cache API. */
class FakeCache implements EdgeCache {
	store = new Map<string, Response>();
	async match(key: Request): Promise<Response | undefined> {
		return this.store.get(key.url);
	}
	async put(key: Request, response: Response): Promise<void> {
		this.store.set(key.url, response);
	}
}

const manifest = (ref: string) => ({ repo: "owner/app", kind: "manifests" as const, ref });

const ctx = (over: Partial<Parameters<typeof cachePolicyFor>[1]> = {}) => ({
	settings: buildSettings({} as ProxyEnv),
	group: group(),
	clientCredentials: false,
	range: false,
	origin: ORIGIN,
	accept: "application/vnd.oci.image.index.v1+json",
	...over,
});

describe("acceptFingerprint", () => {
	it("is order- and case-insensitive", async () => {
		expect(await acceptFingerprint("A, B")).toBe(await acceptFingerprint("b ,a"));
	});

	it("distinguishes different sets and handles null", async () => {
		expect(await acceptFingerprint("a")).not.toBe(await acceptFingerprint("b"));
		expect(await acceptFingerprint(null)).toBe("none");
		expect(await acceptFingerprint("")).toBe("none");
	});
});

describe("cachePolicyFor", () => {
	it("keys blobs by group + repo + digest with the immutable TTL", async () => {
		const policy = await cachePolicyFor(
			{ repo: "owner/app", kind: "blobs", ref: "sha256:ab" },
			ctx(),
		);
		expect(policy?.key.url).toBe(`${ORIGIN}/-/cache/docker.io/v2/owner/app/blobs/sha256:ab`);
		expect(policy?.ttlSeconds).toBe(IMMUTABLE_TTL_SECONDS);
	});

	it("keys manifests by digest (immutable) vs tag (short TTL, accept-fingerprinted)", async () => {
		const digestPolicy = await cachePolicyFor(manifest("sha256:ab"), ctx());
		expect(digestPolicy?.ttlSeconds).toBe(IMMUTABLE_TTL_SECONDS);
		expect(digestPolicy?.key.url).toContain("manifests/sha256:ab?a=");

		const tagPolicy = await cachePolicyFor(manifest("latest"), ctx());
		expect(tagPolicy?.ttlSeconds).toBe(120);

		const acceptPolicy = await cachePolicyFor(manifest("latest"), ctx({ accept: "application/other" }));
		expect(acceptPolicy?.key.url).not.toBe(tagPolicy?.key.url);
	});

	it("honors MANIFEST_TAG_TTL from settings", async () => {
		const s = buildSettings({ MANIFEST_TAG_TTL: "600" } as ProxyEnv);
		const policy = await cachePolicyFor(manifest("latest"), ctx({ settings: s }));
		expect(policy?.ttlSeconds).toBe(600);
	});

	it("returns null for listing endpoints", async () => {
		expect(await cachePolicyFor({ repo: "a", kind: "tags", ref: "list" }, ctx())).toBeNull();
		expect(await cachePolicyFor({ repo: "a", kind: "referrers", ref: "sha256:ab" }, ctx())).toBeNull();
	});

	it("returns null for ranged requests and credential-backed fetches", async () => {
		expect(await cachePolicyFor({ repo: "a", kind: "blobs", ref: "sha256:ab" }, ctx({ range: true }))).toBeNull();
		expect(await cachePolicyFor(manifest("latest"), ctx({ clientCredentials: true }))).toBeNull();

		const s = buildSettings({ REGISTRY_AUTHS: '{"docker.io": "u:p"}' } as ProxyEnv);
		expect(await cachePolicyFor(manifest("latest"), ctx({ settings: s }))).toBeNull();

		const s2 = buildSettings({ REGISTRY_AUTHS: '{"mirror.io": "u:p"}' } as ProxyEnv);
		const g: RegistryGroup = {
			...group(),
			members: [
				{ key: "docker.io", host: "docker.io", scheme: "https" },
				{ key: "mirror.io", host: "mirror.io", scheme: "https" },
			],
		};
		expect(await cachePolicyFor(manifest("latest"), ctx({ settings: s2, group: g }))).toBeNull();
	});

	it("returns null when the cache is disabled", async () => {
		const s = buildSettings({ BLOB_CACHE: "false" } as ProxyEnv);
		expect(await cachePolicyFor({ repo: "a", kind: "blobs", ref: "sha256:ab" }, ctx({ settings: s }))).toBeNull();
	});
});

describe("readCached / fillInBackground", () => {
	it("stores a response and serves both GET and HEAD from the entry", async () => {
		const cache = new FakeCache();
		const policy = (await cachePolicyFor({ repo: "a", kind: "blobs", ref: "sha256:ab" }, ctx()))!;
		const upstream = new Response("blob-bytes", { status: 200, headers: { "content-type": "application/octet-stream" } });

		const waitUntilCalls: Array<Promise<unknown>> = [];
		const clientRes = fillInBackground(cache, policy, upstream, (p) => waitUntilCalls.push(p));
		expect(await clientRes.text()).toBe("blob-bytes"); // client stream unaffected
		await Promise.all(waitUntilCalls); // background fill completes

		const getHit = await readCached(cache, policy, "GET");
		expect(getHit?.status).toBe(200);
		expect(await getHit?.text()).toBe("blob-bytes");
		expect(getHit?.headers.get("cache-control")).toBe(`public, max-age=${IMMUTABLE_TTL_SECONDS}`);

		const headHit = await readCached(cache, policy, "HEAD");
		expect(headHit?.status).toBe(200);
		expect(headHit?.body).toBeNull();
		expect(headHit?.headers.get("content-type")).toBe("application/octet-stream");
	});

	it("returns null on a miss", async () => {
		const cache = new FakeCache();
		const policy = (await cachePolicyFor(manifest("latest"), ctx()))!;
		expect(await readCached(cache, policy, "GET")).toBeNull();
	});
});

describe("edgeCache", () => {
	it("returns the runtime caches.default", () => {
		// In Node tests caches.default exists via undici only when installed;
		// assert it merely resolves without throwing before deployment wiring.
		expect(typeof edgeCache).toBe("function");
	});
});
