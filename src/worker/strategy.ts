/**
 * Pull strategies over a mirror group's members.
 *
 * The OCI rule that shapes everything here: content-addressed requests
 * (digests) are byte-identical on every member, so they can be raced; tag
 * addresses may differ between members (sync lag), so they fall back in
 * order.
 *
 * Member health is tracked isolate-locally with exponential backoff — no
 * external state, and every edge location learns independently which mirrors
 * are currently usable.
 */

import { RegistryError, type RegistryGroup, type Upstream } from "./registry";
import { LruMap } from "./util";

/** How to treat a member's response status. */
export type Verdict = "pass" | "next" | "penalty";

/**
 * - < 400: pass through (including 3xx; redirects are followed inside the fetch)
 * - 404: normal miss on this member, try the next without penalty
 * - 401/403/429/5xx: member is unusable right now, penalize and try the next
 * - other 4xx: the request itself is bad, pass it through unchanged
 */
export function classifyStatus(status: number): Verdict {
	if (status < 400) return "pass";
	if (status === 404) return "next";
	if (status === 401 || status === 403 || status === 429 || status >= 500) return "penalty";
	return "pass";
}

const HEALTH_BASE_MS = 30_000;
const HEALTH_MAX_MS = 120_000;

interface HealthEntry {
	failUntil: number;
	fails: number;
}

const health = new LruMap<string, HealthEntry>(256);

/** Record a member failure; it is skipped until the backoff window expires. */
export function penalize(host: string, now: number): void {
	const entry = health.get(host);
	const fails = (entry?.fails ?? 0) + 1;
	const backoff = Math.min(HEALTH_BASE_MS * 2 ** (fails - 1), HEALTH_MAX_MS);
	health.set(host, { fails, failUntil: now + backoff });
}

/** Clear a member's failure history after a success. */
export function markHealthy(host: string): void {
	health.delete(host);
}

/** Test hook: forget all member health state. */
export function resetHealth(): void {
	health.clear();
}

export function isPenalized(host: string, now: number): boolean {
	const entry = health.get(host);
	return entry !== undefined && now < entry.failUntil;
}

/**
 * Members worth trying, in order. Penalized members are skipped — unless all
 * of them are (then nobody would be left), which keeps recovery possible.
 */
export function healthyMembers(members: Upstream[], now: number): Upstream[] {
	const active = members.filter((m) => !isPenalized(m.key, now));
	return active.length > 0 ? active : members;
}

/** Runs one member attempt; strategies pass an AbortSignal for timeout/cancel. */
export type Attempt = (member: Upstream, signal: AbortSignal) => Promise<Response>;

export interface StrategyOptions {
	now?: () => number;
	/** Per-member budget (ms) for response headers to arrive. Default 8000. */
	timeoutMs?: number;
	/** Hedged mode: delay (ms) before firing the remaining members. Default 150. */
	hedgeDelayMs?: number;
	/** OCI error code for the aggregate not-found error. */
	notFoundCode?: string;
}

export type StrategyResult =
	| { ok: true; member: Upstream; res: Response }
	| { ok: false; error: RegistryError };

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_HEDGE_DELAY_MS = 150;

class AttemptFailure extends Error {
	constructor(public cause: "network" | "timeout") {
		super(cause);
	}
}

/**
 * Wrap one attempt with a header-arrival timeout. The signal is aborted on
 * timeout (freeing the connection); once headers arrive the timer is cleared
 * so streaming the body is never interrupted.
 */
function withTimeout(
	member: Upstream,
	attempt: Attempt,
	controller: AbortController,
	timeoutMs: number,
): { promise: Promise<Response>; cancel: () => void } {
	const promise = new Promise<Response>((resolve, reject) => {
		const timer = setTimeout(() => {
			controller.abort();
			reject(new AttemptFailure("timeout"));
		}, timeoutMs);
		attempt(member, controller.signal).then(
			(res) => {
				clearTimeout(timer);
				resolve(res);
			},
			(e) => {
				clearTimeout(timer);
				reject(e instanceof AttemptFailure ? e : new AttemptFailure("network"));
			},
		);
	});
	return { promise, cancel: () => controller.abort() };
}

interface RaceState {
	settled: boolean;
	failures: number;
	saw404: boolean;
	tried: string[];
}

function aggregateError(state: RaceState, group: RegistryGroup, notFoundCode: string): RegistryError {
	if (state.saw404) {
		return new RegistryError(404, notFoundCode, `${notFoundCode.toLowerCase()} on all members of ${group.key}`);
	}
	return new RegistryError(
		502,
		"UNAVAILABLE",
		`no member of ${group.key} could serve the request`,
		{ tried: state.tried },
	);
}

/**
 * Shared core for racing members with individual start delays.
 * `delayFor(i)` returns member i's start delay (0 for all in a pure race;
 * 0 for the first and hedgeDelayMs for the rest in hedged mode).
 */
function raceWithSchedule(
	group: RegistryGroup,
	attempt: Attempt,
	opts: StrategyOptions,
	delayFor: (index: number) => number,
): Promise<StrategyResult> {
	const now = opts.now ?? Date.now;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const notFoundCode = opts.notFoundCode ?? "UNKNOWN";
	const candidates = healthyMembers(group.members, now());

	return new Promise<StrategyResult>((resolve) => {
		const state: RaceState = { settled: false, failures: 0, saw404: false, tried: [] };
		// Cancels for attempts still awaiting headers; resolved attempts remove
		// theirs so a winner's body stream is never aborted under our feet.
		const cancels = new Set<() => void>();
		const startTimers: ReturnType<typeof setTimeout>[] = [];

		const finish = (winner: { member: Upstream; res: Response } | null) => {
			for (const t of startTimers) clearTimeout(t);
			for (const cancel of cancels) cancel();
			resolve(winner === null ? { ok: false, error: aggregateError(state, group, notFoundCode) } : { ok: true, ...winner });
		};

		const launch = (member: Upstream) => {
			state.tried.push(member.key);
			const controller = new AbortController();
			const entry = withTimeout(member, attempt, controller, timeoutMs);
			cancels.add(entry.cancel);
			entry.promise.then(
				(res) => {
					cancels.delete(entry.cancel);
					if (state.settled) {
						res.body?.cancel();
						return;
					}
					const verdict = classifyStatus(res.status);
					if (verdict === "pass") {
						state.settled = true;
						markHealthy(member.key);
						finish({ member, res });
						return;
					}
					res.body?.cancel();
					if (verdict === "penalty") penalize(member.key, now());
					if (res.status === 404) state.saw404 = true;
					state.failures += 1;
					if (state.failures === candidates.length) finish(null);
				},
				() => {
					cancels.delete(entry.cancel);
					if (state.settled) return;
					penalize(member.key, now());
					state.failures += 1;
					if (state.failures === candidates.length) finish(null);
				},
			);
		};

		candidates.forEach((member, index) => {
			const delay = delayFor(index);
			if (delay === 0) launch(member);
			else startTimers.push(setTimeout(() => launch(member), delay));
		});
	});
}

/** Tag-addressed fallback: try members in order, first pass wins. */
export async function fetchSequential(
	group: RegistryGroup,
	attempt: Attempt,
	opts: StrategyOptions = {},
): Promise<StrategyResult> {
	const now = opts.now ?? Date.now;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const notFoundCode = opts.notFoundCode ?? "UNKNOWN";
	const candidates = healthyMembers(group.members, now());

	let saw404 = false;
	const tried: string[] = [];
	for (const member of candidates) {
		tried.push(member.key);
		const controller = new AbortController();
		const { promise } = withTimeout(member, attempt, controller, timeoutMs);
		let res: Response;
		try {
			res = await promise;
		} catch {
			penalize(member.key, now());
			continue;
		}
		const verdict = classifyStatus(res.status);
		if (verdict === "pass") {
			markHealthy(member.key);
			return { ok: true, member, res };
		}
		res.body?.cancel();
		if (verdict === "penalty") penalize(member.key, now());
		if (res.status === 404) saw404 = true;
	}
	return { ok: false, error: aggregateError({ settled: true, failures: tried.length, saw404, tried }, group, notFoundCode) };
}

/** Digest-addressed race: fire all members at once, first pass wins, losers are cancelled. */
export function fetchRace(group: RegistryGroup, attempt: Attempt, opts: StrategyOptions = {}): Promise<StrategyResult> {
	return raceWithSchedule(group, attempt, opts, () => 0);
}

/** Blob pull: fire the leading member, hedge with the rest after hedgeDelayMs. */
export function fetchHedged(group: RegistryGroup, attempt: Attempt, opts: StrategyOptions = {}): Promise<StrategyResult> {
	const delay = opts.hedgeDelayMs ?? DEFAULT_HEDGE_DELAY_MS;
	return raceWithSchedule(group, attempt, opts, (index) => (index === 0 ? 0 : delay));
}
