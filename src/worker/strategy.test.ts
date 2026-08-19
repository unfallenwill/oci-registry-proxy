import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RegistryGroup, Upstream } from "./registry";
import {
	classifyStatus,
	fetchHedged,
	fetchRace,
	fetchSequential,
	healthyMembers,
	isPenalized,
	penalize,
	resetHealth,
} from "./strategy";

const up = (key: string): Upstream => ({ key, host: key, scheme: "https" });
const group = (...keys: string[]): RegistryGroup => ({
	key: "g.test",
	isDockerFamily: false,
	members: keys.map(up),
});

/** Deferred response factory for controlling attempt timing in tests. */
function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const ok = (body = "ok", status = 200) => new Response(body, { status });

beforeEach(() => {
	resetHealth();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("classifyStatus", () => {
	it("passes success and client-rejection statuses", () => {
		expect(classifyStatus(200)).toBe("pass");
		expect(classifyStatus(307)).toBe("pass");
		expect(classifyStatus(400)).toBe("pass");
		expect(classifyStatus(405)).toBe("pass");
	});

	it("moves on from 404 without penalty", () => {
		expect(classifyStatus(404)).toBe("next");
	});

	it("penalizes unavailable members", () => {
		for (const status of [401, 403, 429, 500, 503]) expect(classifyStatus(status)).toBe("penalty");
	});
});

describe("health tracking", () => {
	it("penalizes with exponential backoff capped at 120s", () => {
		const now = vi.fn(() => 1_000_000);
		penalize("h.test", now());
		expect(isPenalized("h.test", 1_000_000 + 29_000)).toBe(true);
		expect(isPenalized("h.test", 1_000_000 + 31_000)).toBe(false);

		penalize("h.test", 1_000_000 + 31_000); // second failure doubles the window
		expect(isPenalized("h.test", 1_000_000 + 31_000 + 59_000)).toBe(true);
		expect(isPenalized("h.test", 1_000_000 + 31_000 + 61_000)).toBe(false);

		penalize("h.test", 0); // failures accumulate: 3rd -> 120s (cap)
		penalize("h.test", 0); // 4th -> 240s clamped to 120s
		expect(isPenalized("h.test", 119_000)).toBe(true);
		expect(isPenalized("h.test", 121_000)).toBe(false);
	});

	it("healthyMembers skips penalized members but falls back to all when everything is down", () => {
		const now = 1_000_000;
		const members = [up("a.test"), up("b.test"), up("c.test")];
		penalize("a.test", now);
		penalize("b.test", now);
		expect(healthyMembers(members, now).map((m) => m.key)).toEqual(["c.test"]);
		penalize("c.test", now);
		// All penalized: return everyone so the group can recover.
		expect(healthyMembers(members, now)).toHaveLength(3);
	});
});

describe("fetchSequential (tag fallback)", () => {
	it("returns the first member's success without touching others", async () => {
		const attempt = vi.fn(async (m: Upstream) => ok(`from-${m.key}`));
		const result = await fetchSequential(group("a.test", "b.test"), attempt);
		expect(result.ok).toBe(true);
		if (result.ok) expect(await result.res.text()).toBe("from-a.test");
		expect(attempt).toHaveBeenCalledTimes(1);
	});

	it("falls through 404 and 500 to the next member", async () => {
		const attempt = vi.fn(async (m: Upstream) => (m.key === "a.test" ? ok("x", 404) : m.key === "b.test" ? ok("x", 500) : ok("winner")));
		const result = await fetchSequential(group("a.test", "b.test", "c.test"), attempt);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.member.key).toBe("c.test");
	});

	it("aggregates to 404 when every member missed", async () => {
		const attempt = vi.fn(async () => ok("x", 404));
		const result = await fetchSequential(group("a.test", "b.test"), attempt, { notFoundCode: "MANIFEST_UNKNOWN" });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.status).toBe(404);
			expect(result.error.code).toBe("MANIFEST_UNKNOWN");
		}
	});

	it("aggregates to 502 listing tried members when none is usable", async () => {
		const attempt = vi.fn(async () => ok("x", 503));
		const result = await fetchSequential(group("a.test", "b.test"), attempt);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.status).toBe(502);
			expect(result.error.detail).toEqual({ tried: ["a.test", "b.test"] });
		}
	});

	it("skips penalized members (mirror sync-lag scenario)", async () => {
		penalize("slow.test", 1_000_000);
		const attempt = vi.fn(async (m: Upstream) => ok(`from-${m.key}`));
		const result = await fetchSequential(group("slow.test", "fast.test"), attempt, { now: () => 1_000_000 });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.member.key).toBe("fast.test");
	});

	it("times out a hanging member and moves on", async () => {
		const attempt = vi.fn((m: Upstream) =>
			m.key === "hang.test"
				? new Promise<Response>(() => {}) // never resolves
				: Promise.resolve(ok("late-winner")),
		);
		const result = await fetchSequential(group("hang.test", "ok.test"), attempt, { timeoutMs: 20 });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.member.key).toBe("ok.test");
	});

	it("passes client-rejection statuses (400) straight through", async () => {
		const attempt = vi.fn(async () => ok("bad request", 400));
		const result = await fetchSequential(group("a.test", "b.test"), attempt);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.res.status).toBe(400);
		expect(attempt).toHaveBeenCalledTimes(1);
	});
});

describe("fetchRace (digest race)", () => {
	it("takes the first successful member and cancels the loser's body", async () => {
		let loserCancelled = false;
		const loserBody = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("loser"));
				},
				cancel() {
					loserCancelled = true;
				},
			}),
		);
		const loser = deferred<Response>();
		const attempt = vi.fn((m: Upstream) => (m.key === "a.test" ? Promise.resolve(ok("fast")) : loser.promise));

		const pending = fetchRace(group("a.test", "b.test"), attempt);
		await Promise.resolve(); // let the winner settle
		loser.resolve(loserBody); // loser arrives late
		const result = await pending;

		expect(result.ok).toBe(true);
		if (result.ok) expect(await result.res.text()).toBe("fast");
		expect(loserCancelled).toBe(true);
	});

	it("waits for a slow member when the first returns 404", async () => {
		const attempt = vi.fn(async (m: Upstream) => (m.key === "a.test" ? ok("x", 404) : ok("synced")));
		const result = await fetchRace(group("a.test", "b.test"), attempt, { notFoundCode: "MANIFEST_UNKNOWN" });
		expect(result.ok).toBe(true);
		if (result.ok) expect(await result.res.text()).toBe("synced");
	});

	it("aggregates 404 only when every member missed", async () => {
		const attempt = vi.fn(async () => ok("x", 404));
		const result = await fetchRace(group("a.test", "b.test"), attempt, { notFoundCode: "BLOB_UNKNOWN" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("BLOB_UNKNOWN");
	});

	it("a network failure counts as one failed attempt, not a total loss", async () => {
		const attempt = vi.fn((m: Upstream) =>
			m.key === "a.test" ? Promise.reject(new Error("socket hang up")) : Promise.resolve(ok("survivor")),
		);
		const result = await fetchRace(group("a.test", "b.test"), attempt);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.member.key).toBe("b.test");
		expect(isPenalized("a.test", Date.now() + 1000)).toBe(true);
	});
});

describe("fetchHedged (blob pull)", () => {
	it("does not hedge when the first member answers within the delay", async () => {
		const attempt = vi.fn(async (m: Upstream) => ok(`blob-${m.key}`));
		const result = await fetchHedged(group("a.test", "b.test"), attempt, { hedgeDelayMs: 30 });
		expect(result.ok).toBe(true);
		if (result.ok) expect(await result.res.text()).toBe("blob-a.test");
		expect(attempt).toHaveBeenCalledTimes(1);
	});

	it("fires the remaining members after the hedge delay", async () => {
		const attempt = vi.fn((m: Upstream) =>
			m.key === "a.test" ? new Promise<Response>(() => {}) : Promise.resolve(ok("hedged-winner")),
		);
		const result = await fetchHedged(group("a.test", "b.test"), attempt, { hedgeDelayMs: 15, timeoutMs: 500 });
		expect(result.ok).toBe(true);
		if (result.ok) expect(await result.res.text()).toBe("hedged-winner");
		expect(attempt).toHaveBeenCalledTimes(2);
	});
});
