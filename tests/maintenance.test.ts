import assert from "node:assert/strict";
import { after, test } from "node:test";
import { beginWork, control, maintenanceStatus, mutation, refuseDrainWhile, tracked, unknownPluginLoaded } from "../src/core/maintenance.ts";

const previous = process.env.LH_MAINTENANCE_SOCKET;
after(() => {
	if (previous === undefined) delete process.env.LH_MAINTENANCE_SOCKET;
	else process.env.LH_MAINTENANCE_SOCKET = previous;
});

test("an owner hands off through a closed admission gate and finishes after durable work", async () => {
	process.env.LH_MAINTENANCE_SOCKET = "/unused/unit-test.sock";
	const owner = beginWork("main-turn");
	const held = control("drain");
	assert.equal(held.counts["main-turn"], 1);
	const late = await mutation(() => { throw new Error("late mutation executed"); })();
	assert.equal(late.status, 503);
	const done = Promise.withResolvers<void>();
	const delivery = owner.run(() => tracked("delivery", () => done.promise));
	owner.end();
	assert.deepEqual(maintenanceStatus().counts, { delivery: 1 });
	assert.throws(() => owner.run(() => beginWork("job")));
	done.resolve(); await delivery;
	assert.equal(control("status", held.generation).drained, true);
	assert.equal(control("resume", held.generation).drained, false);
	assert.throws(() => control("status", held.generation));
});

test("a request owns streamed input until its handler settles", async () => {
	const done = Promise.withResolvers<void>();
	const request = mutation(async () => { await done.promise; return new Response(); })();
	const held = control("drain");
	assert.equal(held.counts["write-request"], 1);
	done.resolve(); await request;
	assert.equal(control("status").drained, true);
	control("resume", held.generation);
});

test("a hold whose caller died expires and the server accepts writes again", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const accepted = mutation(() => new Response());
	const held = control("drain", undefined, 1000);
	t.mock.timers.tick(600);
	assert.equal(control("status", held.generation).drained, true, "reading the status keeps the hold as it is");
	t.mock.timers.tick(399);
	assert.equal((await accepted()).status, 503);
	t.mock.timers.tick(1);
	const reopened = maintenanceStatus();
	assert.equal(reopened.mode, "open");
	assert.equal(reopened.drained, false);
	assert.notEqual(reopened.generation, held.generation);
	assert.equal((await accepted()).status, 200);
	assert.throws(() => control("status", held.generation), /Stale/, "the earlier readiness is withdrawn");
	assert.throws(() => control("resume", held.generation), /Stale/);
});

test("a living holder keeps its hold by repeating the drain", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const held = control("drain", undefined, 1000);
	t.mock.timers.tick(900);
	assert.throws(() => control("drain", undefined, 1), /requires its generation/);
	assert.throws(() => control("drain", "other-generation", 1), /Stale/);
	assert.equal(control("drain", held.generation, 1000).generation, held.generation);
	t.mock.timers.tick(900);
	assert.equal(control("status", held.generation).drained, true);
	assert.equal((await mutation(() => new Response())()).status, 503);
	assert.equal(control("resume", held.generation).mode, "open");
	t.mock.timers.tick(5000);
	assert.equal(control("drain").mode, "draining", "an ended hold leaves no deadline behind");
	t.mock.timers.tick(59999);
	assert.equal(maintenanceStatus().mode, "draining", "the default hold lasts a minute");
	t.mock.timers.tick(1);
	assert.equal(maintenanceStatus().mode, "open");
	for (const period of [0, -1, 1.5, 600001, "1000", null]) assert.throws(() => control("drain", undefined, period as number), /hold period/);
	assert.equal(maintenanceStatus().mode, "open", "a refused period closes nothing");
});

test("resume requires the current drain generation", () => {
	const previousHold = control("drain");
	control("resume", previousHold.generation);
	const held = control("drain");
	try {
		assert.throws(() => control("resume"), /requires its generation/);
		assert.throws(() => control("resume", previousHold.generation), /Stale/);
		assert.equal(control("status", held.generation).drained, true);
	} finally {
		if (maintenanceStatus().mode === "draining") control("resume", held.generation);
	}
});

test("the open generation cannot start a drain", () => {
	const open = control("status");
	assert.throws(() => control("drain", open.generation), /only renew an active drain/);
	assert.deepEqual(control("status"), open);
});

test("cancellation applies only to the matching timely drain attempt", () => {
	const expired = { id: "expired", startByMs: Date.now() - 1 };
	assert.throws(() => control("drain", undefined, 60000, expired), /expired/);
	const attempt = { id: "timely", startByMs: Date.now() + 60000 };
	const held = control("drain", undefined, 60000, attempt);
	try {
		assert.deepEqual(control("cancel-drain", undefined, undefined, expired), held);
		assert.equal(control("cancel-drain", undefined, undefined, attempt).mode, "open");
	} finally {
		if (maintenanceStatus().mode === "draining") control("resume", held.generation);
	}
});

test("an ended owner counts again only while admission is open", () => {
	const owner = beginWork("delivery");
	owner.end();
	assert.deepEqual(maintenanceStatus().counts, {});
	assert.equal(owner.renew(), true);
	assert.deepEqual(maintenanceStatus().counts, { delivery: 1 });
	owner.end();
	const held = control("drain");
	assert.equal(owner.renew(), false);
	assert.throws(() => owner.run(() => beginWork("main-turn")), "an ended owner admits no child");
	assert.equal(control("status", held.generation).drained, true);
	control("resume", held.generation);
	assert.equal(owner.renew(), true);
	owner.end();
});

test("accepted state held only in memory withholds readiness under its own reason", () => {
	let parked = true;
	refuseDrainWhile("fixture-memory-only", () => parked);
	const held = control("drain");
	assert.deepEqual(held.counts, {});
	assert.deepEqual(held.reasons, ["fixture-memory-only"]);
	assert.equal(held.drained, false);
	parked = false;
	const ready = control("status", held.generation);
	assert.deepEqual(ready.reasons, []);
	assert.equal(ready.drained, true);
	control("resume", held.generation);
});

test("unknown backend lifetime refuses a guarantee even after its request ends", () => {
	unknownPluginLoaded();
	const s = control("drain");
	assert.deepEqual(s.counts, {});
	assert.deepEqual(s.reasons, ["unknown-plugin-lifecycle"]);
	assert.equal(s.drained, false);
	control("resume", s.generation);
});
