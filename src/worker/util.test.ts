import { describe, expect, it } from "vitest";
import { b64urlDecode, b64urlDecodeBytes, b64urlEncode, constantTimeEqual, LruMap, sha256 } from "./util";

describe("LruMap", () => {
	it("evicts the oldest entry beyond capacity", () => {
		const map = new LruMap<string, number>(2);
		map.set("a", 1);
		map.set("b", 2);
		map.set("c", 3);
		expect(map.has("a")).toBe(false);
		expect(map.get("b")).toBe(2);
		expect(map.get("c")).toBe(3);
	});

	it("refreshing an entry protects it from eviction", () => {
		const map = new LruMap<string, number>(2);
		map.set("a", 1);
		map.set("b", 2);
		map.get("a");
		map.set("c", 3);
		expect(map.get("a")).toBe(1);
		expect(map.has("b")).toBe(false);
	});
});

describe("b64url", () => {
	it("round-trips bytes without padding or URL-unsafe chars", () => {
		const bytes = new Uint8Array([0, 255, 254, 1, 250, 251, 252, 253]);
		const encoded = b64urlEncode(bytes);
		expect(encoded).not.toMatch(/[+/=]/);
		expect(Array.from(b64urlDecodeBytes(encoded))).toEqual(Array.from(bytes));
	});

	it("round-trips strings", () => {
		expect(b64urlDecode(b64urlEncode("hello wörld"))).toBe("hello wörld");
	});
});

describe("constantTimeEqual", () => {
	it("accepts equal byte strings", () => {
		expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
	});

	it("rejects differing bytes", () => {
		expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
	});

	it("rejects different lengths", () => {
		expect(constantTimeEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
	});
});

describe("sha256", () => {
	it("computes the known digest of 'abc'", async () => {
		const hex = Array.from(await sha256("abc"))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		expect(hex).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	});
});
