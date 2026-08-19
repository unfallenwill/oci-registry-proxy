/**
 * Small shared utilities: LRU map, base64url, constant-time comparison,
 * SHA-256. No dependencies on the Workers runtime beyond Web standard APIs
 * (btoa/atob/crypto), so unit tests run on plain Node.
 */

/** Map that evicts its oldest entry once `capacity` is exceeded. */
export class LruMap<K, V> extends Map<K, V> {
	constructor(private readonly capacity: number) {
		super();
	}

	override get(key: K): V | undefined {
		if (!super.has(key)) return undefined;
		const value = super.get(key) as V;
		// Re-insert to refresh recency.
		super.delete(key);
		super.set(key, value);
		return value;
	}

	override set(key: K, value: V): this {
		super.set(key, value);
		if (this.size > this.capacity) {
			const oldest = this.keys().next().value;
			if (oldest !== undefined) this.delete(oldest);
		}
		return this;
	}
}

/** URL-safe base64 without padding. */
export function b64urlEncode(bytes: Uint8Array | string): string {
	const binary =
		typeof bytes === "string" ? bytes : String.fromCharCode(...Array.from(bytes));
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode URL-safe base64 (padding optional) into a string. */
export function b64urlDecode(text: string): string {
	const padded = text.replace(/-/g, "+").replace(/_/g, "/");
	return atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
}

/** Decode URL-safe base64 into bytes. */
export function b64urlDecodeBytes(text: string): Uint8Array {
	const binary = b64urlDecode(text);
	return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

/** Length-safe constant-time equality for secret comparison. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0;
}

/** SHA-256 digest as raw bytes. */
export async function sha256(bytes: Uint8Array | string): Promise<Uint8Array> {
	const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
	const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
	return new Uint8Array(digest);
}
