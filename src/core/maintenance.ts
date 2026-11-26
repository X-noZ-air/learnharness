// Server-only. Separately compiled Next entry points share the process holder.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import process from "node:process";

export type Work = "write-request" | "upload" | "main-turn" | "side-chat" | "job" | "delivery" | "compaction" | "extraction" | "plugin-task" | "plugin-writer" | "sign-in" | "token-refresh" | "startup";
type Mode = "open" | "draining" | "startup-hold";
interface Lease {
	active: boolean;
	run<T>(fn: () => T): T;
	end(): void;
}
// A child may inherit admission only while its parent still owns work. AsyncLocalStorage
// alone would also propagate permission to timers firing long after their owner ended.
const disabled: Lease = { active: false, run: fn => fn(), end() {} };
const key = Symbol.for("learnharness.maintenance.v1");
function createState() {
	return {
		mode: (process.env.LH_MAINTENANCE_STARTUP_HOLD === "1" ? "startup-hold" : "open") as Mode,
		generation: randomUUID(),
		counts: new Map<Work, number>(),
		unknownPlugin: false,
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
	s.counts.set(kind, (s.counts.get(kind) ?? 0) + 1);
	const lease: Lease = {
		active: true,
		run: fn => s.context.run(lease, fn),
		end() {
			if (!lease.active) return;
			lease.active = false;
			const remaining = s.counts.get(kind)! - 1;
			if (remaining) s.counts.set(kind, remaining);
			else s.counts.delete(kind);
		},
	};
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
export function whenOpen(fn: () => void) {
	if (!admissionClosed()) fn();
	else state().onOpen.add(fn);
}
export function maintenanceStatus() {
	const s = state();
	return {
		version: 1,
		generation: s.generation,
		mode: s.mode,
		counts: Object.fromEntries(s.counts),
		reasons: s.unknownPlugin ? ["unknown-plugin-lifecycle"] : [],
		drained: s.mode !== "open" && !s.counts.size && !s.unknownPlugin,
	};
}
export function control(op: string, generation?: string) {
	const s = state();
	if (generation !== undefined && generation !== s.generation) throw new Error("Stale maintenance generation");
	if (op === "drain" && s.mode === "open") {
		s.mode = "draining";
		s.generation = randomUUID();
	} else if (op === "release" || op === "resume") {
		if (s.mode !== (op === "release" ? "startup-hold" : "draining")) throw new Error("Command does not match the active hold");
		s.mode = "open";
		s.generation = randomUUID();
		const callbacks = [...s.onOpen];
		s.onOpen.clear();
		for (const fn of callbacks) fn();
	} else if (op !== "status" && op !== "drain") throw new Error("Unknown maintenance command");
	return maintenanceStatus();
}
