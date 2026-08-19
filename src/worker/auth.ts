/**
 * Proxy-side authentication.
 *
 * Clients authenticate with a single shared secret (PROXY_TOKEN) via
 * `docker login`: the password is the token. The proxy exchanges that secret
 * for a short-lived HMAC-signed bearer (`prx.<payload>.<sig>`) which clients
 * attach to every request. Because upstream bearer tokens never use the
 * "prx." prefix, our tokens are trivially distinguishable from credentials
 * meant for upstream registries.
 *
 * Stateless by design: the signing key is derived from PROXY_TOKEN itself, so
 * rotating the secret also invalidates all issued bearers.
 */

import { serializeChallenge } from "./upstream";
import { b64urlDecodeBytes, b64urlEncode, constantTimeEqual, sha256 } from "./util";

const TOKEN_PREFIX = "prx.";
export const BEARER_TTL_SECONDS = 3600;

interface BearerPayload {
	sub: string;
	iat: number;
	exp: number;
}

let signingKeyCache: { token: string; key: Uint8Array } | null = null;

async function signingKey(proxyToken: string): Promise<Uint8Array> {
	if (signingKeyCache?.token === proxyToken) return signingKeyCache.key;
	const key = await sha256(proxyToken);
	signingKeyCache = { token: proxyToken, key };
	return key;
}

async function hmac(message: string, key: Uint8Array): Promise<Uint8Array> {
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		key as BufferSource,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message)));
}

/** Issue a signed bearer for the subject, valid for BEARER_TTL_SECONDS. */
export async function issueBearer(proxyToken: string, sub: string, nowMs: number): Promise<string> {
	const payload: BearerPayload = {
		sub,
		iat: Math.floor(nowMs / 1000),
		exp: Math.floor(nowMs / 1000) + BEARER_TTL_SECONDS,
	};
	const encodedPayload = b64urlEncode(JSON.stringify(payload));
	const signature = await hmac(encodedPayload, await signingKey(proxyToken));
	return `${TOKEN_PREFIX}${encodedPayload}.${b64urlEncode(signature)}`;
}

export type BearerCheck = { ok: true; sub: string } | { ok: false };

/** Verify a bearer token issued by issueBearer (signature + expiry). */
export async function verifyBearer(token: string, proxyToken: string, nowMs: number): Promise<BearerCheck> {
	if (!token.startsWith(TOKEN_PREFIX)) return { ok: false };
	const remainder = token.slice(TOKEN_PREFIX.length);
	const dot = remainder.lastIndexOf(".");
	if (dot <= 0) return { ok: false };
	const encodedPayload = remainder.slice(0, dot);
	const encodedSignature = remainder.slice(dot + 1);

	let signature: Uint8Array;
	try {
		signature = b64urlDecodeBytes(encodedSignature);
	} catch {
		return { ok: false };
	}
	const expected = await hmac(encodedPayload, await signingKey(proxyToken));
	if (!constantTimeEqual(signature, expected)) return { ok: false };

	let payload: BearerPayload;
	try {
		payload = JSON.parse(new TextDecoder().decode(b64urlDecodeBytes(encodedPayload))) as BearerPayload;
	} catch {
		return { ok: false };
	}
	if (typeof payload.exp !== "number" || payload.exp * 1000 <= nowMs) return { ok: false };
	if (typeof payload.sub !== "string") return { ok: false };
	return { ok: true, sub: payload.sub };
}

/** Extract the Basic password ("user:<password>") a client presented. */
function basicPassword(authorization: string | null): string | null {
	if (!authorization?.startsWith("Basic ")) return null;
	try {
		const decoded = atob(authorization.slice("Basic ".length));
		const colon = decoded.indexOf(":");
		return colon === -1 ? null : decoded.slice(colon + 1);
	} catch {
		return null;
	}
}

/** Does the client's Basic password match the configured shared token? (username is ignored) */
export async function verifyProxyToken(authorization: string | null, proxyToken: string): Promise<boolean> {
	const presented = basicPassword(authorization);
	if (presented === null) return false;
	return constantTimeEqual(new TextEncoder().encode(presented), new TextEncoder().encode(proxyToken));
}

/** Challenge pointing OCI clients at our own auth endpoint. */
export function proxyChallenge(origin: string): string {
	return serializeChallenge("Bearer", {
		realm: `${origin}/-/auth`,
		service: "oci-registry-proxy",
	});
}
