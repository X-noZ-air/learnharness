import assert from "node:assert/strict";
import { after, test } from "node:test";
import { beginWork, control, maintenanceStatus, mutation, tracked, unknownPluginLoaded } from "../src/core/maintenance.ts";

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
	assert.equal(control("drain").counts["write-request"], 1);
	done.resolve(); await request;
	assert.equal(control("status").drained, true);
	control("resume");
});

test("unknown backend lifetime refuses a guarantee even after its request ends", () => {
	unknownPluginLoaded();
	const s = control("drain");
	assert.deepEqual(s.counts, {});
	assert.deepEqual(s.reasons, ["unknown-plugin-lifecycle"]);
	assert.equal(s.drained, false);
	control("resume");
});
