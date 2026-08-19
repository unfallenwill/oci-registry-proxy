import { describe, expect, it } from "vitest";
import { BEARER_TTL_SECONDS, issueBearer, proxyChallenge, verifyBearer, verifyProxyToken } from "./auth";

const SECRET = "ptk_secret_token";
const now = () => 1_700_000_000_000;

describe("issueBearer / verifyBearer", () => {
	it("round-trips a valid bearer", async () => {
		const token = await issueBearer(SECRET, "alice", now());
		expect(token.startsWith("prx.")).toBe(true);
		const check = await verifyBearer(token, SECRET, now() + 1000);
		expect(check).toEqual({ ok: true, sub: "alice" });
	});

	it("rejects expired bearers", async () => {
		const token = await issueBearer(SECRET, "alice", now());
		const check = await verifyBearer(token, SECRET, now() + (BEARER_TTL_SECONDS + 1) * 1000);
		expect(check.ok).toBe(false);
	});

	it("rejects bearers signed with a different token (rotation invalidates)", async () => {
		const token = await issueBearer(SECRET, "alice", now());
		expect((await verifyBearer(token, "ptk_other", now())).ok).toBe(false);
	});

	it("rejects tampered payloads and signatures", async () => {
		const token = await issueBearer(SECRET, "alice", now());
		const [prefix, payload, signature] = token.split(".");

		// Flip a payload character.
		const tamperedPayload = payload.startsWith("A") ? `B${payload.slice(1)}` : `A${payload.slice(1)}`;
		expect((await verifyBearer(`${prefix}.${tamperedPayload}.${signature}`, SECRET, now())).ok).toBe(false);

		// Flip a signature character.
		const tamperedSig = signature.startsWith("A") ? `B${signature.slice(1)}` : `A${signature.slice(1)}`;
		expect((await verifyBearer(`${prefix}.${payload}.${tamperedSig}`, SECRET, now())).ok).toBe(false);
	});

	it("rejects malformed tokens", async () => {
		for (const bad of ["", "Bearer abc", "prx.onlypayload", "prx..", "prx.a.b.c", "prx.!!!.zzz"]) {
			expect((await verifyBearer(bad, SECRET, now())).ok).toBe(false);
		}
	});

	it("distinguishes itself from upstream bearer tokens", async () => {
		// Upstream tokens (e.g. from auth.docker.io) never carry our prefix.
		expect((await verifyBearer("eyJhbGciOi.jv8hZ.9f8", SECRET, now())).ok).toBe(false);
	});
});

describe("verifyProxyToken", () => {
	const basic = (user: string, password: string) => `Basic ${btoa(`${user}:${password}`)}`;

	it("accepts any username with the token as password", async () => {
		expect(await verifyProxyToken(basic("alice", SECRET), SECRET)).toBe(true);
		expect(await verifyProxyToken(basic("", SECRET), SECRET)).toBe(true);
	});

	it("rejects wrong passwords and non-Basic headers", async () => {
		expect(await verifyProxyToken(basic("alice", "wrong"), SECRET)).toBe(false);
		expect(await verifyProxyToken(`Bearer ${SECRET}`, SECRET)).toBe(false);
		expect(await verifyProxyToken(null, SECRET)).toBe(false);
	});

	it("rejects malformed Basic payloads", async () => {
		expect(await verifyProxyToken("Basic !!!not-base64!!!", SECRET)).toBe(false);
		expect(await verifyProxyToken(`Basic ${btoa("no-colon")}`, SECRET)).toBe(false);
	});
});

describe("proxyChallenge", () => {
	it("points clients at the proxy's own auth realm", () => {
		expect(proxyChallenge("https://proxy.example.com")).toBe(
			'Bearer realm="https://proxy.example.com/-/auth", service="oci-registry-proxy"',
		);
	});
});
