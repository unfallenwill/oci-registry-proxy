import { afterEach, describe, expect, it, vi } from "vitest";
import type { Upstream } from "./registry";
import { buildSettings, type ProxyEnv } from "./settings";
import {
	fetchUpstreamToken,
	memberCredentials,
	parseWwwAuthenticate,
	rememberRealm,
	requestUpstream,
	resolveRealm,
	serializeChallenge,
} from "./upstream";

const member = (host: string, key = host): Upstream => ({ key, host, scheme: "https" });

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("parseWwwAuthenticate", () => {
	it("parses bearer challenges with quoted params", () => {
		const parsed = parseWwwAuthenticate('Bearer realm="https://auth.example/token",service="registry"');
		expect(parsed).toEqual({
			scheme: "bearer",
			params: { realm: "https://auth.example/token", service: "registry" },
		});
	});

	it("handles unquoted params and other schemes", () => {
		expect(parseWwwAuthenticate("Basic realm=x")).toEqual({ scheme: "basic", params: { realm: "x" } });
	});

	it("returns null for junk and empty params for a bare scheme", () => {
		expect(parseWwwAuthenticate("")).toBeNull();
		expect(parseWwwAuthenticate("no-scheme-params")).toBeNull();
		expect(parseWwwAuthenticate("Basic")).toEqual({ scheme: "basic", params: {} });
	});
});

describe("serializeChallenge", () => {
	it("round-trips through parse", () => {
		const value = serializeChallenge("Bearer", { realm: "https://x/token", service: "x" });
		expect(value).toBe('Bearer realm="https://x/token", service="x"');
		expect(parseWwwAuthenticate(value)?.params.realm).toBe("https://x/token");
	});
});

describe("resolveRealm", () => {
	it("returns builtin realms for docker family hosts without network", async () => {
		expect(await resolveRealm(member("registry-1.docker.io", "docker.io"))).toEqual({
			realm: "https://auth.docker.io/token",
			service: "registry.docker.io",
		});
	});

	it("discovers realms from a 401 ping and caches them", async () => {
		const upstream = member("reg.example");
		const fetchMock = vi.fn(async () =>
			new Response("{}", {
				status: 401,
				headers: { "www-authenticate": 'Bearer realm="https://reg.example/token",service="reg"' },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const realm = await resolveRealm(upstream);
		expect(realm).toEqual({ realm: "https://reg.example/token", service: "reg" });
		// Second call is served from the cache.
		await resolveRealm(upstream);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("remembers realms learned from response headers", async () => {
		const upstream = member("learn.example");
		rememberRealm(upstream, 'Bearer realm="https://learn/token"');
		expect(await resolveRealm(upstream)).toEqual({ realm: "https://learn/token" });
	});

	it("returns null when a non-bearer scheme is remembered or discovery fails", async () => {
		const basic = member("basic.example");
		rememberRealm(basic, 'Basic realm="x"');
		expect(await resolveRealm(basic)).toBeNull();

		vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("down"))));
		expect(await resolveRealm(member("down.example"))).toBeNull();
	});
});

describe("fetchUpstreamToken", () => {
	const now = () => 1_000_000;

	it("fetches a token with service+scope and caches it", async () => {
		const upstream = member("tok.example");
		rememberRealm(upstream, 'Bearer realm="https://tok.example/auth",service="svc"');
		const fetchMock = vi.fn(async (_input: RequestInfo | URL) => {
			const url = new URL(String(_input));
			expect(url.searchParams.get("service")).toBe("svc");
			expect(url.searchParams.get("scope")).toBe("repository:a/b:pull");
			return Response.json({ token: "t-1", expires_in: 300 });
		});
		vi.stubGlobal("fetch", fetchMock);

		expect(await fetchUpstreamToken(upstream, "repository:a/b:pull", null, now)).toBe("t-1");
		expect(await fetchUpstreamToken(upstream, "repository:a/b:pull", null, now)).toBe("t-1");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("sends configured basic credentials to the token endpoint", async () => {
		const upstream = member("priv.example");
		rememberRealm(upstream, 'Bearer realm="https://priv.example/auth"');
		const fetchMock = vi.fn(async (_input, init?: RequestInit) => {
			expect(new Headers(init?.headers).get("authorization")).toBe("Basic dTpw");
			return Response.json({ access_token: "t-2" });
		});
		vi.stubGlobal("fetch", fetchMock);
		expect(await fetchUpstreamToken(upstream, "", "Basic dTpw", now)).toBe("t-2");
	});

	it("returns null without a realm or on failure", async () => {
		expect(await fetchUpstreamToken(member("nowhere.example"), "", null, now)).toBeNull();

		const upstream = member("broken.example");
		rememberRealm(upstream, 'Bearer realm="https://broken.example/auth"');
		vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
		expect(await fetchUpstreamToken(upstream, "", null, now)).toBeNull();

		vi.stubGlobal("fetch", vi.fn(async () => Response.json({ no_token: true })));
		const upstream2 = member("shape.example");
		rememberRealm(upstream2, 'Bearer realm="https://shape.example/auth"');
		expect(await fetchUpstreamToken(upstream2, "", null, now)).toBeNull();
	});
});

describe("memberCredentials", () => {
	it("prefers configured credentials by member key, then host", () => {
		const upstream = member("registry-1.docker.io", "docker.io");
		const s = buildSettings({ REGISTRY_AUTHS: '{"docker.io": "dk:p", "registry-1.docker.io": "h:p"}' } as ProxyEnv);
		// key lookup hits first
		expect(memberCredentials(upstream, s, null)).toBe(`Basic ${btoa("dk:p")}`);
	});

	it("falls back to the client's Basic authorization", () => {
		const s = buildSettings({});
		expect(memberCredentials(member("x.io"), s, "Basic Y2xpZW50")).toBe("Basic Y2xpZW50");
		// Non-basic client auth is not relayed (we cannot mint upstream bearer tokens from it).
		expect(memberCredentials(member("x.io"), s, "Bearer something")).toBeNull();
		expect(memberCredentials(member("x.io"), s, null)).toBeNull();
	});
});

describe("requestUpstream", () => {
	const now = () => 0;

	it("passes a 200 straight through", async () => {
		const fetchMock = vi.fn(async () => new Response("data"));
		vi.stubGlobal("fetch", fetchMock);
		const res = await requestUpstream(
			member("ok.example"),
			"https://ok.example/v2/x/manifests/latest",
			{ method: "GET", headers: new Headers() },
			"repository:x:pull",
			null,
			now,
		);
		expect(res.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("completes the bearer flow on 401 and retries once", async () => {
		const upstream = member("auth.example");
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response("{}", {
					status: 401,
					headers: { "www-authenticate": 'Bearer realm="https://auth.example/token",service="s"' },
				}),
			)
			.mockResolvedValueOnce(Response.json({ token: "tok" }))
			.mockResolvedValueOnce(new Response("manifest-body"));
		vi.stubGlobal("fetch", fetchMock);

		const res = await requestUpstream(
			upstream,
			"https://auth.example/v2/x/manifests/latest",
			{ method: "GET", headers: new Headers() },
			"repository:x:pull",
			null,
			now,
		);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("manifest-body");
		const retry = fetchMock.mock.calls[2][1] as RequestInit;
		expect(new Headers(retry.headers).get("authorization")).toBe("Bearer tok");
	});

	it("keeps the 401 when no token can be obtained", async () => {
		const upstream = member("deny.example");
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response("{}", {
					status: 401,
					headers: { "www-authenticate": 'Bearer realm="https://deny.example/token"' },
				}),
			)
			.mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));
		vi.stubGlobal("fetch", fetchMock);

		const res = await requestUpstream(
			upstream,
			"https://deny.example/v2/x/manifests/latest",
			{ method: "GET", headers: new Headers() },
			"repository:x:pull",
			null,
			now,
		);
		expect(res.status).toBe(401);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("converts network failures into synthetic 502 responses", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("connection reset"))));
		const res = await requestUpstream(
			member("down.example"),
			"https://down.example/v2/",
			{ method: "GET", headers: new Headers() },
			"",
			null,
			now,
		);
		expect(res.status).toBe(502);
	});
});
