import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { piModels } from "../src/agent/models.ts";
import { toLlmMessages } from "../src/core/native-messages.ts";
import { buildProbeHandoffSteer, buildSubagentSteer } from "../src/core/contracts.ts";
import { NATIVE_SUBSCRIPTIONS } from "../src/core/contracts/subscriptions.ts";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-subscription-background-"));
process.env.LH_DATA_DIR = path.join(directory, "data"); process.env.LH_AUTH_FILE = path.join(directory, "auth.json"); fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
const { stores } = await import("../src/server/stores.ts");
const { beginTurn, endTurn } = await import("../src/server/turn-liveness.ts");
const { deliverJobResult, discardChatDeliveries, registerLiveAgent, unregisterLiveAgent, setTurnRunner, settleSteers, steerLiveChat, automaticFollowUpAllowed } = await import("../src/server/jobs.ts");
const { persistTurn } = await import("../src/server/turn-service.ts");
const originalSend = Object.getOwnPropertyDescriptor(process, "send"), originalConnected = Object.getOwnPropertyDescriptor(process, "connected");
const marker = process.env.LH_DESKTOP_SERVER, secret = process.env.LH_DESKTOP_API_SECRET;
let revision = 0;
function connection(providerId: string, background: boolean, connected = true) {
	revision++;
	(process.emit as (event: string, value: unknown) => boolean)("message", { channel: "lh:subscriptions", op: "changed", snapshot: {
		statuses: NATIVE_SUBSCRIPTIONS.map((p) => ({ providerId: p.providerId, available: true, connected: p.providerId !== providerId || connected, pending: false, allowBackgroundUse: p.providerId === providerId ? background : true, connectionId: `fixture-${p.providerId}`, epoch: 1, authorityRevision: 1, revision })),
		models: Object.fromEntries(NATIVE_SUBSCRIPTIONS.map((p) => [p.providerId, piModels().getModels(p.providerId)])),
	} });
}
before(() => {
	process.env.LH_DESKTOP_SERVER = "1"; process.env.LH_DESKTOP_API_SECRET = "d".repeat(64);
	Object.defineProperty(process, "connected", { configurable: true, value: true });
	Object.defineProperty(process, "send", { configurable: true, value: (_message: unknown, callback?: (error: Error) => void) => { callback?.(new Error("unexpected fixture request")); return false; } });
});
after(() => {
	fs.rmSync(directory, { recursive: true, force: true });
	if (originalSend) Object.defineProperty(process, "send", originalSend); else delete process.send;
	if (originalConnected) Object.defineProperty(process, "connected", originalConnected); else delete (process as { connected?: boolean }).connected;
	if (marker === undefined) delete process.env.LH_DESKTOP_SERVER; else process.env.LH_DESKTOP_SERVER = marker;
	if (secret === undefined) delete process.env.LH_DESKTOP_API_SECRET; else process.env.LH_DESKTOP_API_SECRET = secret;
});
for (const p of NATIVE_SUBSCRIPTIONS) for (const revokeAfterQueue of [false, true]) test(`${p.providerId}: foreground survives and automatic queue retains ownership with background ${revokeAfterQueue ? "revoked" : "off"}`, { timeout: 5000 }, async (t) => {
	connection(p.providerId, revokeAfterQueue);
	const chat = stores.chatStore.createChat("Fixture mixed queue"); const model = { ...piModels().getModels(p.providerId)[0]!, provider: p.logicalId };
	t.after(() => discardChatDeliveries(chat.id));
	stores.chatStore.saveSettings(chat.id, { model: { provider: p.logicalId, id: model.id } });
	const job = stores.jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "fixture-job-call" }); const result = { brief: "Fixture helper result", sources: [] };
	stores.jobStore.updateJob(job.id, { status: "done", result, delivery: { kind: "result", status: "pending" } }); const steer = buildSubagentSteer(job, result); const contexts: string[] = [];
	const agent = new Agent({ initialState: { model, messages: [{ id: "fixture-initial", role: "user", content: "Initial learner input", timestamp: 1 } as AgentMessage] }, convertToLlm: toLlmMessages, streamFn: () => {
		contexts.push(JSON.stringify(agent.state.messages)); const stream = new AssistantMessageEventStream();
		const output = { role: "assistant" as const, provider: p.logicalId, api: model.api, model: model.id, content: [{ type: "text" as const, text: "Foreground response" }], stopReason: "stop" as const, timestamp: 2, usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		stream.push({ type: "start", partial: output }); stream.push({ type: "done", reason: "stop", message: output }); stream.end(); return stream;
	} });
	let wakes = 0;
	setTurnRunner(async (chatId, input) => { wakes++; if (input.type === "steers") stores.chatStore.saveMessages(chatId, [...stores.chatStore.getChat(chatId)!.messages, ...input.steers]); return 200; });
	assert(beginTurn(chat.id)); registerLiveAgent(chat.id, agent); const delivered = deliverJobResult(steer);
	assert(steerLiveChat(chat.id, { id: "fixture-live-learner", role: "user", content: "Continue my learning", timestamp: 3 } as never));
	if (revokeAfterQueue) connection(p.providerId, false);
	assert(!automaticFollowUpAllowed(chat.id, agent)); await agent.continue();
	assert.equal(contexts.length, 1); assert(contexts[0]!.includes("Continue my learning")); assert(!contexts[0]!.includes(steer.id));
	const persisted = persistTurn(stores.chatStore, chat.id, 0, agent.state.messages, false);
	unregisterLiveAgent(chat.id); endTurn(chat.id); settleSteers(chat.id, persisted); await new Promise((resolve) => setImmediate(resolve));
	assert.equal(wakes, 0); assert.equal(stores.jobStore.getJob(job.id)!.status, "done"); assert.equal(stores.jobStore.getJob(job.id)!.delivery?.status, "pending");
	connection(p.providerId, true); await delivered; assert.equal(wakes, 1); assert.equal(stores.jobStore.getJob(job.id)!.status, "done");
});

test("a probe handoff waiting for subscription consent postpones drain and reaches the teacher after resume", async (t) => {
	const { control } = await import("../src/core/maintenance.ts");
	const previous = process.env.LH_MAINTENANCE_SOCKET;
	process.env.LH_MAINTENANCE_SOCKET = path.join(directory, "fixture.sock");
	t.after(() => {
		const status = control("status");
		if (status.mode === "draining") control("resume", status.generation);
		if (previous === undefined) delete process.env.LH_MAINTENANCE_SOCKET;
		else process.env.LH_MAINTENANCE_SOCKET = previous;
	});
	const provider = NATIVE_SUBSCRIPTIONS[0]!;
	connection(provider.providerId, false);
	const chat = stores.chatStore.createChat("Synthetic probe handoff");
	t.after(() => discardChatDeliveries(chat.id));
	const model = piModels().getModels(provider.providerId)[0]!;
	stores.chatStore.saveSettings(chat.id, { model: { provider: provider.logicalId, id: model.id } });
	const handoff = buildProbeHandoffSteer(chat.id);
	setTurnRunner(async (id, input) => {
		if (input.type === "steers") stores.chatStore.saveMessages(id, input.steers);
		return 200;
	});
	const delivered = deliverJobResult(handoff);
	await new Promise(resolve => setImmediate(resolve));
	const held = control("drain");
	assert.deepEqual(held.counts, {});
	assert.equal(held.drained, false);
	assert.deepEqual(held.reasons, ["parked-probe-handoff"]);
	control("resume", held.generation);
	connection(provider.providerId, true);
	await delivered;
	assert.deepEqual(stores.chatStore.getChat(chat.id)!.messages, [handoff]);
	assert.deepEqual(control("status").reasons, []);
});

test("a subscription change from admitted sign-in wakes parked delivery only after resume", { timeout: 5000 }, async (t) => {
	const { beginWork, control, maintenanceStatus } = await import("../src/core/maintenance.ts");
	const previous = process.env.LH_MAINTENANCE_SOCKET;
	process.env.LH_MAINTENANCE_SOCKET = path.join(directory, "fixture.sock");
	const provider = NATIVE_SUBSCRIPTIONS[0]!;
	connection(provider.providerId, true, false);
	const chat = stores.chatStore.createChat("Parked subscription delivery");
	const model = piModels().getModels(provider.providerId)[0]!;
	stores.chatStore.saveSettings(chat.id, { model: { provider: provider.logicalId, id: model.id } });
	const job = stores.jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "parked-subscription-job" });
	const result = { brief: "Fixture helper result", sources: [] };
	stores.jobStore.updateJob(job.id, { status: "done", result, delivery: { kind: "result", status: "pending" } });
	const steer = buildSubagentSteer(job, result);
	setTurnRunner(async (id, input) => {
		if (input.type === "steers") stores.chatStore.saveMessages(id, input.steers);
		return 200;
	});
	const delivered = deliverJobResult(steer);
	void delivered.catch(() => {});
	await new Promise(resolve => setImmediate(resolve));
	const login = beginWork("sign-in", true);
	const held = control("drain");
	t.after(() => {
		login.end();
		discardChatDeliveries(chat.id);
		if (maintenanceStatus().mode === "draining") control("resume", held.generation);
		if (previous === undefined) delete process.env.LH_MAINTENANCE_SOCKET;
		else process.env.LH_MAINTENANCE_SOCKET = previous;
	});
	assert.deepEqual(held.counts, { "sign-in": 1 });
	login.run(() => connection(provider.providerId, true));
	login.end();
	assert.equal(control("status", held.generation).drained, true);
	assert.deepEqual(stores.chatStore.getChat(chat.id)!.messages, []);
	assert.equal(stores.jobStore.getJob(job.id)!.delivery?.status, "pending");

	control("resume", held.generation);
	await delivered;
	assert.deepEqual(stores.chatStore.getChat(chat.id)!.messages, [steer]);
	assert.equal(stores.jobStore.getJob(job.id)!.delivery?.status, "delivered");
});
