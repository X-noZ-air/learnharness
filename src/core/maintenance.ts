// Server-only. Separately compiled Next entry points share the process holder.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import process from "node:process";

export type Work = "write-request" | "upload" | "main-turn" | "side-chat" | "job" | "delivery" | "compaction" | "extraction" | "plugin-task" | "plugin-writer" | "sign-in" | "token-refresh" | "startup";
type Mode = "open" | "draining" | "startup-hold";
export interface Lease {
	active: boolean;
	run<T>(fn: () => T): T;
	end(): void;
	/** Count again after end(). Refused while admission is closed: an ended owner cannot admit itself. */
	renew(): boolean;
}
// A child may inherit admission only while its parent still owns work. AsyncLocalStorage
// alone would also propagate permission to timers firing long after their owner ended.
const disabled: Lease = { active: false, run: fn => fn(), end() {}, renew: () => true };
const key = Symbol.for("learnharness.maintenance.v1");
/** A drain hold lasts this long after its last drain command unless the command names a period. */
const HOLD_MS = 60_000;
const MAX_HOLD_MS = 600_000;
type DrainAttempt = { id: string; startByMs?: number };
function createState() {
	return {
		mode: (process.env.LH_MAINTENANCE_STARTUP_HOLD === "1" ? "startup-hold" : "open") as Mode,
		generation: randomUUID(),
		counts: new Map<Work, number>(),
		unknownPlugin: false,
		refusals: new Map<string, () => boolean>(),
		holdTimer: undefined as ReturnType<typeof setTimeout> | undefined,
		drainAttemptId: undefined as string | undefined,
		context: new AsyncLocalStorage<Lease>(),
		onOpen: new Set<() => void>(),
	};
}
function state() {
	const holder = process as typeof process & { [key]?: ReturnType<typeof createState> };
	return holder[key] ??= createState();
}
export function maintenanceEnabled() { return Boolean(process.env.LH_MAINTENANCE_SOCKET); }
export function admissionClosed() { return maintenanceEnabled() && state().mode !== "open"; }
export function canStartWork() { return !admissionClosed() || !!state().context.getStore()?.active; }
export class MaintenanceError extends Error {
	constructor() { super("Server maintenance is in progress. Your request was not accepted. Try again after maintenance."); }
}
export function maintenanceRefusal() {
	return Response.json({ code: "maintenance", error: new MaintenanceError().message }, { status: 503, headers: { "Cache-Control": "no-store" } });
}

export function beginWork(kind: Work, external = false): Lease {
	if (!maintenanceEnabled()) return disabled;
	const s = state();
	if (s.mode !== "open" && (external || !s.context.getStore()?.active)) throw new MaintenanceError();
	const count = (change: 1 | -1) => {
		const next = (s.counts.get(kind) ?? 0) + change;
		if (next) s.counts.set(kind, next);
		else s.counts.delete(kind);
	};
	const lease: Lease = {
		active: true,
		run: fn => s.context.run(lease, fn),
		end() {
			if (!lease.active) return;
			lease.active = false;
			count(-1);
		},
		renew() {
			if (!lease.active && s.mode === "open") { lease.active = true; count(1); }
			return lease.active;
		},
	};
	count(1);
	return lease;
}

export async function tracked<T>(kind: Work, fn: () => T | Promise<T>, external = false): Promise<T> {
	const lease = beginWork(kind, external);
	try { return await lease.run(fn); }
	finally { lease.end(); }
}
export function mutation<A extends unknown[]>(fn: (...args: A) => Response | Promise<Response>, kind: "write-request" | "upload" = "write-request") {
	return async (...args: A): Promise<Response> => {
		try { return await tracked(kind, () => fn(...args), true); }
		catch (err) { if (err instanceof MaintenanceError) return maintenanceRefusal(); throw err; }
	};
}
export function unknownPluginLoaded() {
	if (maintenanceEnabled()) state().unknownPlugin = true;
}
/** Accepted state that exists only in this process and no running work will save.
 * While present, readiness is refused under this reason. The name carries no identifiers. */
export function refuseDrainWhile(reason: string, present: () => boolean) {
	state().refusals.set(reason, present);
}
export function whenOpen(fn: () => void) {
	if (!admissionClosed()) fn();
	else state().onOpen.add(fn);
}
export function maintenanceStatus() {
	const s = state();
	const reasons = s.unknownPlugin ? ["unknown-plugin-lifecycle"] : [];
	for (const [reason, present] of s.refusals) if (present()) reasons.push(reason);
	return {
		version: 1,
		generation: s.generation,
		mode: s.mode,
		counts: Object.fromEntries(s.counts),
		reasons,
		drained: s.mode !== "open" && !s.counts.size && !reasons.length,
	};
}
function open(s: ReturnType<typeof state>) {
	clearTimeout(s.holdTimer);
	s.holdTimer = undefined;
	s.drainAttemptId = undefined;
	s.mode = "open";
	s.generation = randomUUID();
	const callbacks = [...s.onOpen];
	s.onOpen.clear();
	for (const fn of callbacks) {
		try { fn(); }
		catch (error) { console.error("[maintenance] Work deferred by a hold failed to continue:", error); }
	}
}
export function control(op: string, generation?: string, holdMs: number = HOLD_MS, attempt?: DrainAttempt) {
	const s = state();
	if (generation !== undefined && generation !== s.generation) throw new Error("Stale maintenance generation");
	if (attempt !== undefined && (typeof attempt?.id !== "string" || !attempt.id)) throw new Error("Invalid drain attempt");
	if (op === "drain") {
		if (s.mode === "startup-hold") throw new Error("Release the startup hold before draining");
		if (!Number.isSafeInteger(holdMs) || holdMs < 1 || holdMs > MAX_HOLD_MS) throw new Error("Invalid hold period");
		if (s.mode === "draining" && generation === undefined) throw new Error("Drain renewal requires its generation");
		if (s.mode === "open") {
			if (generation !== undefined) throw new Error("A generation can only renew an active drain");
			if (attempt && (typeof attempt.startByMs !== "number" || !Number.isSafeInteger(attempt.startByMs) || Date.now() >= attempt.startByMs)) {
				throw new Error("Drain attempt expired before admission");
			}
			s.mode = "draining";
			s.generation = randomUUID();
			s.drainAttemptId = attempt?.id;
		}
		// Only its holder keeps a drain alive. A caller that dies cannot leave admission closed.
		clearTimeout(s.holdTimer);
		s.holdTimer = setTimeout(() => { if (s.mode === "draining") open(s); }, holdMs);
		s.holdTimer.unref();
	} else if (op === "cancel-drain") {
		if (!attempt) throw new Error("Cancelling a drain requires its attempt");
		if (s.mode === "draining" && s.drainAttemptId === attempt.id) open(s);
	} else if (op === "release" || op === "resume") {
		if (generation === undefined) throw new Error("Releasing a hold requires its generation");
		if (s.mode !== (op === "release" ? "startup-hold" : "draining")) throw new Error("Command does not match the active hold");
		open(s);
	} else if (op !== "status") throw new Error("Unknown maintenance command");
	return maintenanceStatus();
}
