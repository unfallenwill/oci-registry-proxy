import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./index";
import { issueBearer } from "./auth";
import { resetHealth } from "./strategy";
import type { WorkerEnv } from "./proxy";

const PROXY_TOKEN = "ptk_integration";
const ORIGIN = "https://proxy.test";

/** In-memory edge cache with Workers-like clone semantics. */
class FakeEdgeCache {
	store = new Map<string, Response>();
	async match(key: Request): Promise<Response | undefined> {
		const hit = this.store.get(key.url);
		return hit ? hit.clone() : undefined;
	}
	async put(key: Request, response: Response): Promise<void> {
		this.store.set(key.url, response.clone());
	}
}

interface Harness {
	env: Record<string, string>;
	fetchMock: ReturnType<typeof vi.fn>;
	calls: Array<{ method: string; url: string; headers: Headers }>;
	cache: FakeEdgeCache;
	pending: Array<Promise<unknown>>;
	request: (path: string, init?: RequestInit) => Promise<Response>;
}

/**
 * Build a test harness: stubbed upstream fetch (handler routes by URL) and a
 * fake caches.default. Hono's app.request drives the worker without network.
 */
function harness(handler: (url: URL, init?: RequestInit) => Response | undefined, env: Record<string, string> = {}): Harness {
	const calls: Harness["calls"] = [];
	const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		calls.push({
			method: (init?.method as string) ?? "GET",
			url: String(url),
			headers: new Headers(init?.headers),
		});
		const res = handler(url, init);
		if (res === undefined) throw new Error(`unexpected upstream call: ${url}`);
		return res;
	});
	vi.stubGlobal("fetch", fetchMock);
	const cache = new FakeEdgeCache();
	vi.stubGlobal("caches", { default: cache });
	const pending: Array<Promise<unknown>> = [];
	const executionCtx = {
		waitUntil: (p: Promise<unknown>) => {
			pending.push(p);
		},
	} as unknown as ExecutionContext;
	return {
		env,
		fetchMock,
		calls,
		cache,
		pending,
		request: async (path: string, init: RequestInit = {}) =>
			await app.request(ORIGIN + path, init, { PROXY_TOKEN, ...env } as unknown as WorkerEnv, executionCtx),
	};
}

const json = (obj: unknown, status = 200) => Response.json(obj, { status });
const manifestBody = JSON.stringify({ schemaVersion: 2, config: {}, layers: [] });

beforeEach(() => {
	resetHealth();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("pull-only method gate", () => {
	it("rejects push methods with 405 on every route shape", async () => {
		const h = harness(() => new Response(null), { PROXY_AUTH: "off" });
		for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
			const res = await h.request("/v2/hello/blobs/uploads/", { method });
			expect(res.status).toBe(405);
			const body = (await res.json()) as { errors: Array<{ code: string; message: string }> };
			expect(body.errors[0].code).toBe("UNSUPPORTED");
			expect(body.errors[0].message).toContain("pull-only");
		}
		const putManifest = await h.request("/v2/hello/manifests/latest", { method: "PUT" });
		expect(putManifest.status).toBe(405);
	});
});

describe("proxy authentication", () => {
	it("fails closed when no PROXY_TOKEN is configured", async () => {
		const h = harness(() => json({}), { PROXY_TOKEN: "", PROXY_AUTH: "" });
		const res = await h.request("/v2/");
		expect(res.status).toBe(401);
		const body = (await res.json()) as { errors: Array<{ message: string }> };
		expect(body.errors[0].message).toContain("PROXY_TOKEN");
	});

	it("challenges unauthenticated clients with our own realm", async () => {
		const h = harness(() => json({}));
		const res = await h.request("/v2/");
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toContain('realm="https://proxy.test/-/auth"');
	});

	it("docker login flow: /-/auth exchanges the shared token for a bearer", async () => {
		const h = harness(() => json({}));
		const bad = await h.request("/-/auth", { headers: { authorization: `Basic ${btoa("user:wrong")}` } });
		expect(bad.status).toBe(401);

		const good = await h.request("/-/auth", { headers: { authorization: `Basic ${btoa("user:" + PROXY_TOKEN)}` } });
		expect(good.status).toBe(200);
		const tokenBody = (await good.json()) as { token: string; expires_in: number };
		expect(tokenBody.token.startsWith("prx.")).toBe(true);
		expect(tokenBody.expires_in).toBe(3600);

		const ping = await h.request("/v2/", { headers: { authorization: `Bearer ${tokenBody.token}` } });
		expect(ping.status).toBe(200);
		// Authenticated ping is answered by the proxy itself.
		expect(h.fetchMock).not.toHaveBeenCalled();
	});

	it("serves authenticated resource requests and never leaks our bearer upstream", async () => {
		const h = harness((url) =>
			url.pathname === "/v2/library/hello/manifests/latest" ? new Response(manifestBody, { headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" } }) : undefined,
		);
		const bearer = await issueBearer(PROXY_TOKEN, "user", Date.now());
		const res = await h.request("/v2/hello/manifests/latest", {
			headers: { authorization: `Bearer ${bearer}`, accept: "application/vnd.oci.image.manifest.v1+json" },
		});
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(manifestBody);
		expect(h.calls[0].headers.get("authorization")).toBeNull();
	});

	it("expired or forged bearers are rejected", async () => {
		const h = harness(() => json({}));
		const expired = await issueBearer(PROXY_TOKEN, "user", Date.now() - 2 * 3600 * 1000);
		const res = await h.request("/v2/hello/manifests/latest", {
			headers: { authorization: `Bearer ${expired}` },
		});
		expect(res.status).toBe(401);

		const forged = await issueBearer("other-secret", "user", Date.now());
		const res2 = await h.request("/v2/hello/manifests/latest", {
			headers: { authorization: `Bearer ${forged}` },
		});
		expect(res2.status).toBe(401);
	});

	it("open mode (PROXY_AUTH=off) relays client Basic credentials upstream", async () => {
		const h = harness(
			(_url, init) => {
				const auth = new Headers(init?.headers).get("authorization");
				return auth === "Basic dXNlcjpwYXNz"
					? new Response(manifestBody, { headers: { "content-type": "application/json" } })
					: json({ errors: [{ code: "UNAUTHORIZED" }] }, 401);
			},
			{ PROXY_AUTH: "off" },
		);
		const res = await h.request("/v2/hello/manifests/latest", {
			headers: { authorization: "Basic dXNlcjpwYXNz", accept: "application/json" },
		});
		expect(res.status).toBe(200);
		// Credential-bearing requests must bypass the shared edge cache.
		expect(h.cache.store.size).toBe(0);
	});
});

describe("open ping", () => {
	it("answers /v2/ from the first healthy member, server-side authenticated", async () => {
		const h = harness((url) => (url.pathname === "/v2/" ? json({}) : undefined), { PROXY_AUTH: "off" });
		const res = await h.request("/v2/");
		expect(res.status).toBe(200);
		expect(h.calls[0].url).toBe("https://registry-1.docker.io/v2/");
	});
});

describe("addressing and routing", () => {
	const bearerHeaders = async () => ({ authorization: `Bearer ${await issueBearer(PROXY_TOKEN, "u", Date.now())}` });

	it("embedded addressing routes /v2/{registry}/{repo}/... to that registry", async () => {
		const h = harness((url) =>
			url.pathname === "/v2/owner/repo/manifests/latest" ? new Response(manifestBody) : undefined,
		);
		const res = await h.request("/v2/ghcr.io/owner/repo/manifests/latest", { headers: await bearerHeaders() });
		expect(res.status).toBe(200);
		expect(h.calls[0].url).toBe("https://ghcr.io/v2/owner/repo/manifests/latest");
	});

	it("path-prefix addressing routes /{registry}/v2/...", async () => {
		const h = harness((url) => (url.pathname === "/v2/prom/prometheus/manifests/latest" ? new Response(manifestBody) : undefined));
		const res = await h.request("/quay.io/v2/prom/prometheus/manifests/latest", { headers: await bearerHeaders() });
		expect(res.status).toBe(200);
		expect(h.calls[0].url).toBe("https://quay.io/v2/prom/prometheus/manifests/latest");
	});

	it("applies the library/ namespace to single-segment docker.io repos", async () => {
		const h = harness((url) => (url.pathname === "/v2/library/nginx/manifests/latest" ? new Response(manifestBody) : undefined));
		const res = await h.request("/v2/nginx/manifests/latest", { headers: await bearerHeaders() });
		expect(res.status).toBe(200);
	});

	it("enforces ALLOWED_REGISTRIES (also for embedded addressing)", async () => {
		const h = harness(() => json({}), { ALLOWED_REGISTRIES: "ghcr.io" });
		const res = await h.request("/v2/quay.io/org/repo/manifests/latest", { headers: await bearerHeaders() });
		expect(res.status).toBe(403);
	});

	it("answers 404 for non-resource paths (catalog, uploads, junk)", async () => {
		const h = harness(() => json({}));
		for (const path of ["/v2/_catalog", "/v2/hello/blobs/uploads/abc123", "/v2/whatever/deeper/thing"]) {
			const res = await h.request(path, { method: "HEAD", headers: await bearerHeaders() });
			expect(res.status, path).toBe(404);
		}
	});

	it("uses plain http for insecure registries", async () => {
		const h = harness((url) => (url.pathname === "/v2/hello/manifests/latest" ? new Response(manifestBody) : undefined), {
			INSECURE_REGISTRIES: "mock.test",
			ALLOWED_REGISTRIES: "mock.test",
		});
		const res = await h.request("/mock.test/v2/hello/manifests/latest", { headers: await bearerHeaders() });
		expect(res.status).toBe(200);
		expect(h.calls[0].url.startsWith("http://mock.test/")).toBe(true);
	});
});

describe("mirror-group strategies", () => {
	const auth = async () => ({ authorization: `Bearer ${await issueBearer(PROXY_TOKEN, "u", Date.now())}` });

	it("tag manifests fall back in member order until one answers", async () => {
		const h = harness(
			(url) => {
				if (url.pathname !== "/v2/hello/manifests/latest") return undefined;
				return url.hostname === "mirror-a.test" ? json({ errors: [{ code: "MANIFEST_UNKNOWN" }] }, 404) : new Response(manifestBody);
			},
			{ MIRROR_GROUPS: '{"mock.test": ["mirror-a.test", "mirror-b.test"]}', ALLOWED_REGISTRIES: "mock.test" },
		);
		const res = await h.request("/mock.test/v2/hello/manifests/latest", { headers: await auth() });
		expect(res.status).toBe(200);
		expect(h.calls.map((c) => new URL(c.url).hostname)).toEqual(["mirror-a.test", "mirror-b.test"]);
	});

	it("digest manifests race: both members queried, first 200 wins", async () => {
		const h = harness(
			(url) => (url.pathname === "/v2/hello/manifests/sha256:aa" ? new Response(manifestBody) : undefined),
			{ MIRROR_GROUPS: '{"mock.test": ["mirror-a.test", "mirror-b.test"]}', ALLOWED_REGISTRIES: "mock.test" },
		);
		const res = await h.request("/mock.test/v2/hello/manifests/sha256:aa", { headers: await auth() });
		expect(res.status).toBe(200);
		expect(new Set(h.calls.map((c) => new URL(c.url).hostname))).toEqual(new Set(["mirror-a.test", "mirror-b.test"]));
	});

	it("all members missing a tag yields a spec-shaped 404", async () => {
		const h = harness(() => json({ errors: [{ code: "MANIFEST_UNKNOWN" }] }, 404), {
			MIRROR_GROUPS: '{"mock.test": ["mirror-a.test", "mirror-b.test"]}',
			ALLOWED_REGISTRIES: "mock.test",
		});
		const res = await h.request("/mock.test/v2/hello/manifests/latest", { headers: await auth() });
		expect(res.status).toBe(404);
		const body = (await res.json()) as { errors: Array<{ code: string }> };
		expect(body.errors[0].code).toBe("MANIFEST_UNKNOWN");
	});
});

describe("edge cache", () => {
	const auth = async () => ({ authorization: `Bearer ${await issueBearer(PROXY_TOKEN, "u", Date.now())}` });
	const blobPath = "/v2/library/hello/blobs/sha256:" + "ab".repeat(32);

	it("fills on first blob GET and serves the second from the cache", async () => {
		const h = harness((url) => (url.pathname === blobPath ? new Response("blob-bytes") : undefined));
		const first = await h.request(blobPath, { headers: await auth() });
		expect(await first.text()).toBe("blob-bytes");
		await Promise.all(h.pending); // background fill

		const second = await h.request(blobPath, { headers: await auth() });
		expect(second.status).toBe(200);
		expect(await second.text()).toBe("blob-bytes");
		expect(h.fetchMock).toHaveBeenCalledTimes(1); // no upstream call on repeat
	});

	it("answers HEAD from a cached GET entry", async () => {
		const h = harness((url) => (url.pathname === blobPath ? new Response("blob-bytes") : undefined));
		await h.request(blobPath, { headers: await auth() });
		await Promise.all(h.pending);
		const head = await h.request(blobPath, { method: "HEAD", headers: await auth() });
		expect(head.status).toBe(200);
		expect(head.body).toBeNull();
		expect(h.fetchMock).toHaveBeenCalledTimes(1);
	});

	it("bypasses the cache for range requests", async () => {
		const h = harness((url) => (url.pathname === blobPath ? new Response("slice", { status: 206 }) : undefined));
		await h.request(blobPath, { headers: { ...await auth(), range: "bytes=0-4" } });
		await h.request(blobPath, { headers: { ...await auth(), range: "bytes=0-4" } });
		expect(h.fetchMock).toHaveBeenCalledTimes(2);
	});

	it("tag manifests are cached with the short TTL; digest manifests immutable", async () => {
		const h = harness((url) =>
			url.pathname === "/v2/library/hello/manifests/latest" || url.pathname === "/v2/library/hello/manifests/sha256:cc"
				? new Response(manifestBody, { headers: { "content-type": "application/json" } })
				: undefined,
		);
		await h.request("/v2/library/hello/manifests/latest", { headers: await auth() });
		await h.request("/v2/library/hello/manifests/sha256:cc", { headers: await auth() });
		await Promise.all(h.pending);
		const ttls = [...h.cache.store.values()].map((r) => r.headers.get("cache-control"));
		expect(ttls).toContain("public, max-age=120");
		expect(ttls).toContain(`public, max-age=${30 * 24 * 60 * 60}`);
	});

	it("cached entries never leak past the auth gate", async () => {
		const h = harness((url) => (url.pathname === blobPath ? new Response("blob-bytes") : undefined));
		await h.request(blobPath, { headers: await auth() });
		await Promise.all(h.pending);
		// Unauthenticated request must not see the cached blob.
		const res = await h.request(blobPath);
		expect(res.status).toBe(401);
	});
});

describe("statusHandler", () => {
	it("reports the proxy configuration", async () => {
		const h = harness(() => json({}), {
			MIRROR_GROUPS: '{"docker.io": ["docker.io", "docker.m.daocloud.io"]}',
			PROXY_AUTH: "off",
		});
		const res = await h.request("/api/status");
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.mode).toBe("pull-only");
		expect(body.authMode).toBe("off");
		expect(body.mirrorGroups).toEqual({ "docker.io": ["docker.io", "docker.m.daocloud.io"] });
	});
});
