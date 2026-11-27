import assert from "node:assert/strict";
import { newDrainAttempt } from "./helpers/maintenance-attempt.ts";
import fs from "node:fs";
import os from "node:os";
import { createConnection, createServer, type Socket } from "node:net";
import path from "node:path";
import { execFile, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { after, afterEach, test } from "node:test";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { LhMessage } from "../src/core/native-messages.ts";
import { buildSubagentSteer, type SteerMessage } from "../src/core/contracts.ts";

// Install isolation and the private control socket before importing any storage composition.
const root = path.resolve(import.meta.dirname, "..");
const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "lh-maintenance-delivery-"));
process.env.LH_DATA_DIR = path.join(directory, "data");
process.env.LH_AUTH_FILE = path.join(directory, "auth.json");
process.env.LH_MAINTENANCE_SOCKET = path.join(directory, "control.sock");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
const { beginWork, control, maintenanceStatus } = await import("../src/core/maintenance.ts");
const { listenForMaintenance } = await import("../src/server/maintenance-socket.ts");
await listenForMaintenance();
const { stores } = await import("../src/server/stores.ts");
const { createJobRunner, researchModelOverride } = await import("../src/agent/subagents/runner.ts");
const { beginTurn, endTurn } = await import("../src/server/turn-liveness.ts");
const { deliverJobResult, discardChatDeliveries, reconcileUserSteers, registerLiveAgent, settleSteers, setTurnRunner, unregisterLiveAgent } = await import("../src/server/jobs.ts");
const chatRoute = await import("../app/api/chat/route.ts");
const steerRoute = await import("../app/api/chats/[id]/steer/route.ts");
const tokenRoute = await import("../app/api/stt/token/route.ts");
const modelRoute = await import("../app/api/models/route.ts");

const chats: string[] = [];
const question = {
	id: "question-message", role: "assistant", content: [{ type: "toolCall", id: "question-call", name: "quiz", arguments: {} }],
	api: "openai-completions", provider: "faux", model: "faux", timestamp: 1,
} as unknown as LhMessage;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean): Promise<void> {
	const end = Date.now() + 8000;
	while (!predicate()) { assert(Date.now() < end, "fixture condition timed out"); await delay(10); }
}
function chat(blocked = false) {
	const value = stores.chatStore.createChat("Isolated maintenance fixture");
	chats.push(value.id);
	if (blocked) stores.chatStore.saveMessages(value.id, [question]);
	return value;
}
function agent() {
	const handed: LhMessage[] = [];
	const value = { state: { model: createFauxCore({}).getModel() }, steer: (message: LhMessage) => handed.push(message) };
	return { handed, value: value as unknown as Parameters<typeof registerLiveAgent>[1] };
}
const cliEnvironment = { PATH: process.env.PATH, NODE_ENV: "test" as const, LH_MAINTENANCE_SOCKET: process.env.LH_MAINTENANCE_SOCKET };
/** The operator command against this process's real control socket. */
function cli(...args: string[]) {
	type CliStatus = ReturnType<typeof maintenanceStatus> & { remainingHoldMs?: number; holdExpiresAtMs?: number };
	return new Promise<{ code: number; status: CliStatus; stderr: string }>((resolve) => {
		execFile(process.execPath, ["scripts/maintenance.mjs", ...args], { cwd: root, env: cliEnvironment }, (error, stdout, stderr) => {
			resolve({ code: error ? Number(error.code) : 0, status: stdout ? JSON.parse(stdout) : undefined, stderr });
		});
	});
}
/** A second process on the same profile, as after a restart. Its script reports one value through done(). */
function freshProcess(script: string, env: Record<string, string>) {
	const report = "const done = value => process.stdout.write(JSON.stringify(value) + '\\n', () => process.exit(0));";
	const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", report + script], {
		cwd: root, encoding: "utf8", timeout: 30000,
		env: { PATH: process.env.PATH, HOME: path.join(directory, "home"), NODE_ENV: "test", LH_AUTH_FILE: process.env.LH_AUTH_FILE, LH_MAINTENANCE_SOCKET: path.join(directory, "unbound.sock"), ...env },
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim().split("\n").at(-1)!);
}
const post = (url: string, body: unknown) => new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const steer = (chatId: string, text: string) => steerRoute.POST(
	post(`http://test/api/chats/${chatId}/steer`, { input: { type: "steer", id: "steer_fixture", text } }), { params: Promise.resolve({ id: chatId }) });

afterEach(() => {
	const status = maintenanceStatus();
	if (status.mode === "draining") control("resume", status.generation);
	researchModelOverride.current = undefined;
	setTurnRunner(async () => 500);
	for (const id of chats.splice(0)) {
		unregisterLiveAgent(id); endTurn(id); discardChatDeliveries(id);
		stores.jobStore.deleteJobsForChat(id); stores.chatStore.deleteChat(id);
	}
});
after(() => fs.rmSync(directory, { recursive: true, force: true }));

test("a result finished behind an open question leaves the server ready and is delivered after a restart", async () => {
	const owner = chat(true);
	const job = stores.jobStore.createJob({ kind: "research", chatId: owner.id, toolCallId: "behind-question", input: { question: "Fixture question", context: "Fixture context" } });
	const faux = createFauxCore({});
	faux.setResponses([fauxAssistantMessage("Fixture brief")]);
	researchModelOverride.current = { model: faux.getModel(), streamFn: faux.streamSimple };
	await createJobRunner({ ...stores, deliver: deliverJobResult }).runJob(job.id);
	assert.equal(stores.jobStore.getJob(job.id)!.status, "done");
	assert.equal(stores.jobStore.getJob(job.id)!.delivery?.status, "pending");

	const ready = await cli("drain", "--timeout-ms", "3000");
	assert.equal(ready.code, 0, JSON.stringify(ready));
	assert.equal(ready.status.drained, true);
	assert.deepEqual(ready.status.counts, {});
	const answer = await chatRoute.POST(post("http://test/api/chat", { chatId: owner.id, input: { type: "text", text: "An answer during the hold" } }));
	assert.equal(answer.status, 503);
	assert.equal((await answer.json()).code, "maintenance");
	// The waiting delivery polls for the answer. Polling must not count as work again.
	await delay(1000);
	assert.equal((await cli("status", "--generation", ready.status.generation)).status.drained, true);
	assert.equal(stores.jobStore.getJob(job.id)!.delivery?.status, "pending", "the marker stays saved");

	const restarted = freshProcess(`
		const { control } = await import('./src/core/maintenance.ts');
		const { stores } = await import('./src/server/stores.ts');
		const { recoverStaleJobs, registerLiveAgent, noteSteersDurable, setTurnRunner, unregisterLiveAgent } = await import('./src/server/jobs.ts');
		const { beginTurn, endTurn } = await import('./src/server/turn-liveness.ts');
		const id = ${JSON.stringify(owner.id)};
		setTurnRunner(async () => 500);
		recoverStaleJobs();
		const { newDrainAttempt } = await import('./tests/helpers/maintenance-attempt.ts');
		const held = control('drain', undefined, undefined, newDrainAttempt());
		control('resume', held.generation);
		const handed = []; beginTurn(id);
		registerLiveAgent(id, { steer: marker => handed.push(marker) });
		const record = stores.chatStore.getChat(id);
		stores.chatStore.saveMessages(id, [...record.messages, ...handed]);
		noteSteersDurable(id, handed); unregisterLiveAgent(id); endTurn(id);
		done({ held, handed: handed.map(marker => marker.id) });
	`, { LH_DATA_DIR: process.env.LH_DATA_DIR! });
	assert.equal(restarted.held.drained, true, "the restored marker does not block the next switch either");
	assert.deepEqual(restarted.held.counts, {});
	assert.deepEqual(restarted.handed, [`steer_${job.id}`]);
	assert.equal(stores.jobStore.getJob(job.id)!.delivery?.status, "delivered");
	assert.equal(stores.chatStore.getChat(owner.id)!.messages.filter((message) => message.id === `steer_${job.id}`).length, 1);
	assert.equal((await cli("resume", "--generation", ready.status.generation)).code, 0);
});

test("a result that is being delivered counts as work and finishes during the hold", async () => {
	const owner = chat();
	const job = stores.jobStore.createJob({ kind: "research", chatId: owner.id, toolCallId: "idle-session" });
	const result = { brief: "Fixture research result", sources: [] };
	const saved = stores.jobStore.updateJob(job.id, { status: "done", result, activity: "finished", delivery: { kind: "result", status: "pending" } })!;
	const wakes: SteerMessage[][] = [];
	setTurnRunner(async (chatId, input) => {
		const steers = (input as { steers: SteerMessage[] }).steers;
		wakes.push(steers);
		stores.chatStore.saveMessages(chatId, [...stores.chatStore.getChat(chatId)!.messages, ...steers]);
		return 200;
	});
	const delivery = deliverJobResult(buildSubagentSteer(saved, result));
	const held = control("drain", undefined, undefined, newDrainAttempt());
	assert.deepEqual(held.counts, { delivery: 1 });
	assert.equal(held.drained, false);
	await delivery;
	assert.equal(wakes.length, 1, "admitted delivery finishes during the hold");
	await until(() => control("status", held.generation).drained);
	assert.equal(stores.jobStore.getJob(job.id)!.delivery?.status, "delivered");
});

function queueResult(chatId: string, toolCallId: string) {
	const job = stores.jobStore.createJob({ kind: "research", chatId, toolCallId });
	const result = { brief: "Fixture research result", sources: [] };
	const saved = stores.jobStore.updateJob(job.id, { status: "done", result, delivery: { kind: "result", status: "pending" } })!;
	const marker = buildSubagentSteer(saved, result);
	return { job, marker, delivered: deliverJobResult(marker) };
}

test("an admitted job takes over a pump parked behind a quiz during drain", { timeout: 5000 }, async (t) => {
	const owner = chat(true);
	const earlier = queueResult(owner.id, "parked-result");
	assert.deepEqual(maintenanceStatus().counts, {});
	const answer = beginWork("main-turn", true);
	const worker = beginWork("job", true);
	t.after(() => { answer.end(); worker.end(); });
	assert(beginTurn(owner.id));
	const held = control("drain", undefined, undefined, newDrainAttempt());
	const later = worker.run(() => queueResult(owner.id, "admitted-result"));
	worker.end();
	const wakes: LhMessage[][] = [];
	setTurnRunner(async (id, input) => {
		assert.equal(input.type, "steers");
		wakes.push(input.steers);
		stores.chatStore.saveMessages(id, [...stores.chatStore.getChat(id)!.messages, ...input.steers]);
		return 200;
	});
	const answered = [question, {
		id: "answer-message", role: "toolResult", toolCallId: "question-call", toolName: "quiz",
		content: [{ type: "text", text: "Synthetic answer" }], isError: false, timestamp: 2,
	}] as LhMessage[];
	answer.run(() => {
		stores.chatStore.saveMessages(owner.id, answered);
		endTurn(owner.id);
		settleSteers(owner.id, answered);
	});
	answer.end();
	assert.equal(control("status", held.generation).counts.delivery, 1);
	await later.delivered;
	await until(() => control("status", held.generation).drained);
	assert.deepEqual(wakes, [[later.marker]]);
	assert.equal(stores.jobStore.getJob(earlier.job.id)!.delivery?.status, "pending");

	control("resume", held.generation);
	await earlier.delivered;
	assert.deepEqual(wakes, [[later.marker], [earlier.marker]]);
});

test("a deliberate retry registered during the hold delivers after resume", { timeout: 5000 }, async (t) => {
	const owner = chat();
	const failure = Promise.withResolvers<void>();
	setTurnRunner(async () => { failure.resolve(); return 500; });
	const { marker, job, delivered } = queueResult(owner.id, "retry-result");
	await failure.promise;
	await until(() => Object.keys(maintenanceStatus().counts).length === 0);
	const answer = beginWork("main-turn", true);
	t.after(() => answer.end());
	const held = control("drain", undefined, undefined, newDrainAttempt());
	const live = agent();
	answer.run(() => {
		assert(beginTurn(owner.id));
		registerLiveAgent(owner.id, live.value);
		assert.deepEqual(live.handed, []);
		unregisterLiveAgent(owner.id);
		endTurn(owner.id);
		settleSteers(owner.id, [], false, live.value);
	});
	answer.end();
	assert.equal(control("status", held.generation).drained, true);
	assert.equal(stores.jobStore.getJob(job.id)!.delivery?.status, "pending");
	setTurnRunner(async (id, input) => {
		assert.equal(input.type, "steers");
		stores.chatStore.saveMessages(id, input.steers);
		return 200;
	});
	control("resume", held.generation);
	assert.equal(maintenanceStatus().counts.delivery, 1);
	await delivered;
	assert.deepEqual(stores.chatStore.getChat(owner.id)!.messages, [marker]);
});

test("a learner message parked behind a question postpones the switch and reaches the next run", async () => {
	const owner = chat();
	const live = agent();
	assert(beginTurn(owner.id));
	registerLiveAgent(owner.id, live.value);
	assert.equal((await steer(owner.id, "Accepted before the question")).status, 200);
	// The run ends at a question before it takes the message.
	stores.chatStore.saveMessages(owner.id, [question]);
	unregisterLiveAgent(owner.id); settleSteers(owner.id, [question]); reconcileUserSteers(owner.id, [question]); endTurn(owner.id);

	const postponed = await cli("drain", "--timeout-ms", "3000");
	assert.equal(postponed.code, 2, JSON.stringify(postponed));
	assert.deepEqual(postponed.status.reasons, ["parked-learner-steer"]);
	assert.deepEqual(postponed.status.counts, {});
	assert.equal(postponed.status.drained, false);
	assert.equal(postponed.status.mode, "open", "the switch is postponed and the server keeps serving");

	const next = agent();
	assert(beginTurn(owner.id));
	registerLiveAgent(owner.id, next.value);
	assert.equal(next.handed.length, 1);
	const persisted = [...stores.chatStore.getChat(owner.id)!.messages, ...next.handed];
	stores.chatStore.saveMessages(owner.id, persisted);
	unregisterLiveAgent(owner.id); settleSteers(owner.id, persisted); reconcileUserSteers(owner.id, persisted); endTurn(owner.id);
	assert(JSON.stringify(stores.chatStore.getChat(owner.id)!.messages).includes("Accepted before the question"));

	const ready = await cli("drain", "--timeout-ms", "3000");
	assert.equal(ready.code, 0, JSON.stringify(ready));
	assert.deepEqual(ready.status.reasons, []);
	assert.equal((await cli("resume", "--generation", ready.status.generation)).code, 0);
});

test("a wait that ends without readiness resumes the server and keeps the distinct exit code", async () => {
	const lesson = beginWork("main-turn");
	const postponed = await cli("drain", "--timeout-ms", "300");
	assert.equal(postponed.code, 2, JSON.stringify(postponed));
	assert.deepEqual(postponed.status.counts, { "main-turn": 1 });
	assert.equal(postponed.status.mode, "open");
	assert.equal(maintenanceStatus().mode, "open");
	assert.equal((await steer("chat_unknown", "after the postponed switch")).status, 404, "writes reach their handler again");

	lesson.end();
});

test("a drain whose caller is killed releases the server by itself", async () => {
	const lesson = beginWork("main-turn");
	const caller = spawn(process.execPath, ["scripts/maintenance.mjs", "drain", "--timeout-ms", "60000", "--hold-ms", "1200"], { cwd: root, env: cliEnvironment, stdio: "ignore" });
	try {
		await until(() => maintenanceStatus().mode === "draining");
		const { generation } = maintenanceStatus();
		await delay(2000);
		assert.equal(maintenanceStatus().generation, generation, "a living caller keeps its hold past the hold period");
		assert.equal((await steer("chat_unknown", "during the hold")).status, 503);
		caller.kill("SIGKILL");
		await once(caller, "exit");
		assert.equal(maintenanceStatus().mode, "draining");
		await until(() => maintenanceStatus().mode === "open");
		assert.notEqual(maintenanceStatus().generation, generation, "the dead caller's readiness is withdrawn");
		assert.equal((await steer("chat_unknown", "after the caller died")).status, 404, "writes reach their handler again");
	} finally { caller.kill("SIGKILL"); lesson.end(); }
});

test("a dictation token stays available during a hold", async (t) => {
	process.env.DEEPGRAM_API_KEY = "fixture-key";
	t.after(() => { delete process.env.DEEPGRAM_API_KEY; });
	t.mock.method(globalThis, "fetch", async () => Response.json({ access_token: "fixture-token" }));
	const held = control("drain", undefined, undefined, newDrainAttempt());
	const response = await tokenRoute.GET();
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { token: "fixture-token" });
	control("resume", held.generation);
});

test("the configured API-key model catalog stays readable during a hold", async (t) => {
	const previousKey = process.env.ANTHROPIC_API_KEY;
	process.env.ANTHROPIC_API_KEY = "fixture-key";
	t.after(() => {
		if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
		else process.env.ANTHROPIC_API_KEY = previousKey;
	});
	const before = await (await modelRoute.GET()).json();
	assert(before.models.some((model: { provider: string }) => model.provider === "anthropic"));

	const held = control("drain", undefined, undefined, newDrainAttempt());
	const response = await modelRoute.GET();
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), before);
	assert.equal(control("status", held.generation).drained, true);
});

test("an admitted chat request reconciles its saved question after a hold begins", async () => {
	const owner = chat();
	const occurrence = { messageId: "saved-question", contentIndex: 0, toolCallId: "saved-call", toolName: "old_plugin_question" };
	const saved = {
		...question, id: occurrence.messageId,
		content: [{ type: "toolCall", id: occurrence.toolCallId, name: occurrence.toolName, arguments: {} }],
		lhQuestions: { "0": { protocolVersion: 99, occurrence } },
	} as unknown as LhMessage;
	stores.chatStore.saveMessages(owner.id, [saved]);

	const body = Promise.withResolvers<void>();
	class DelayedRequest extends Request {
		override async json() { await body.promise; return super.json(); }
	}
	const sending = chatRoute.POST(new DelayedRequest(post("http://test/api/chat", { chatId: owner.id, input: { type: "text", text: "Continue after the old question" } })));
	const held = control("drain", undefined, undefined, newDrainAttempt());
	assert.equal(held.counts["write-request"], 1);
	body.resolve();
	assert.equal((await sending).status, 503, "the request reaches the unconfigured model gate");
	assert.partialDeepStrictEqual(stores.chatStore.getChat(owner.id)!.messages.find(message => message.role === "toolResult")?.details, { reason: "unreadable-protocol" });
	assert.equal(control("status", held.generation).drained, true);
});

test("a failed plugin runtime composition leaves no startup work behind", () => {
	const code = path.join(root, "core-plugins");
	const existed = fs.existsSync(code);
	const misplaced = path.join(code, `profile-inside-code-${process.pid}`);
	try {
		const outcome = freshProcess(`
			const { getPluginHost } = await import('./src/server/plugins.ts');
			const { maintenanceStatus } = await import('./src/core/maintenance.ts');
			const failures = [];
			for (let attempt = 0; attempt < 2; attempt++) await getPluginHost().then(() => failures.push('started'), error => failures.push(error.message));
			done({ failures, counts: maintenanceStatus().counts });
		`, { LH_DATA_DIR: misplaced });
		const refusal = "Core plugin data must be outside app-owned code";
		assert.deepEqual(outcome.failures, [refusal, refusal]);
		assert.deepEqual(outcome.counts, {});
	} finally {
		fs.rmSync(misplaced, { recursive: true, force: true });
		if (!existed) fs.rmSync(code, { recursive: true, force: true });
	}
});

test("the drain command cannot acquire a startup hold", () => {
	const result = freshProcess(`
		const { default: assert } = await import('node:assert/strict');
		const { listenForMaintenance } = await import('./src/server/maintenance-socket.ts');
		const { control } = await import('./src/core/maintenance.ts');
		const { execFile } = await import('node:child_process');
		await listenForMaintenance();
		const before = control('status');
		const code = await new Promise(resolve => execFile(process.execPath, ['scripts/maintenance.mjs', 'drain'], error => resolve(error?.code ?? 0)));
		assert.throws(() => control('release'), /requires its generation/);
		done({ code, mode: control('status', before.generation).mode, released: control('release', before.generation).mode });
	`, { LH_DATA_DIR: process.env.LH_DATA_DIR!, LH_MAINTENANCE_STARTUP_HOLD: "1" });
	assert.deepEqual(result, { code: 1, mode: "startup-hold", released: "open" });
});

type Command = { op: string; generation?: string; holdMs?: number; attempt?: { id: string; startByMs?: number } };
async function throughDelayedSocket(handle: (command: Command, socket: Socket) => void, args: string[]) {
	const socket = path.join(directory, "delayed.sock");
	const server = createServer(peer => {
		let buffer = "";
		peer.setEncoding("utf8").on("data", chunk => {
			buffer += chunk;
			if (buffer.includes("\n")) handle(JSON.parse(buffer), peer);
		});
	});
	server.listen(socket);
	await once(server, "listening");
	try { return await cli("drain", "--socket", socket, ...args); }
	finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

test("a delayed ready reply reports only the remaining time for its confirmed generation", async () => {
	const period = 2000;
	let receivedAt = 0;
	const result = await throughDelayedSocket((command, peer) => {
		receivedAt = Date.now();
		const status = control(command.op, command.generation, command.holdMs, command.attempt);
		setTimeout(() => peer.end(JSON.stringify(status) + "\n"), 150);
	}, ["--timeout-ms", "3000", "--hold-ms", String(period)]);
	assert.equal(result.code, 0, JSON.stringify(result));
	assert.equal(control("status", result.status.generation).drained, true);
	const { remainingHoldMs, holdExpiresAtMs } = result.status;
	assert(remainingHoldMs && remainingHoldMs <= period - 100);
	assert(holdExpiresAtMs && Date.now() < holdExpiresAtMs && holdExpiresAtMs <= receivedAt + period);

	const unproven = await throughDelayedSocket((_command, peer) => {
		peer.end(JSON.stringify({ ...maintenanceStatus(), generation: "unconfirmed" }) + "\n");
	}, ["--generation", result.status.generation]);
	assert.equal(unproven.code, 1);
	assert.equal(unproven.status, undefined);
});

test("listing chats and jobs on a fresh profile leaves its directories absent", () => {
	const profile = path.join(directory, "unopened");
	const result = freshProcess(`
		const { existsSync } = await import('node:fs');
		const { stores } = await import('./src/server/stores.ts');
		const chats = stores.chatStore.listChats();
		const jobs = stores.jobStore.listJobs('chat_missing');
		done({ chats, jobs, created: existsSync(process.env.LH_DATA_DIR) });
	`, { LH_DATA_DIR: profile });
	assert.deepEqual(result, { chats: [], jobs: [], created: false });
});

test("a ready reply delivered after its requested hold expired is refused", async () => {
	const result = await throughDelayedSocket((command, peer) => {
		try {
			const status = control(command.op, command.generation, command.holdMs, command.attempt);
			const reply = () => peer.end(JSON.stringify(status) + "\n");
			if (command.op === "drain") setTimeout(reply, 100);
			else reply();
		} catch { peer.end(JSON.stringify({ error: "stale generation" }) + "\n"); }
	}, ["--timeout-ms", "3000", "--hold-ms", "20"]);
	assert.equal(result.code, 2);
	assert.equal(result.status.mode, "open");
	assert.equal(result.status.holdExpiresAtMs, undefined);
	assert.equal(result.status.remainingHoldMs, undefined);
});

test("a stalled renewal releases the confirmed drain generation and exits with code 2", async () => {
	const lesson = beginWork("main-turn");
	const ops: string[] = [];
	try {
		const result = await throughDelayedSocket((command, peer) => {
			ops.push(command.op);
			const status = control(command.op, command.generation, command.holdMs, command.attempt);
			if (ops.length !== 2) peer.end(JSON.stringify(status) + "\n");
		}, ["--timeout-ms", "30000"]);
		assert.equal(result.code, 2);
		assert.deepEqual(ops, ["drain", "drain", "resume"]);
		assert.equal(maintenanceStatus().mode, "open");
	} finally { lesson.end(); }
});

test("a timed-out first drain releases the hold without receiving its generation", async () => {
	let accepted = false;
	const result = await throughDelayedSocket((command, peer) => {
		const upstream = createConnection(process.env.LH_MAINTENANCE_SOCKET!);
		upstream.on("error", error => peer.destroy(error));
		peer.on("close", () => upstream.destroy());
		upstream.once("connect", () => upstream.write(JSON.stringify(command) + "\n"));
		if (command.op === "drain") {
			upstream.once("data", () => { accepted = maintenanceStatus().mode === "draining"; });
		} else {
			upstream.pipe(peer);
		}
	}, ["--timeout-ms", "250", "--hold-ms", "60000"]);
	assert.equal(accepted, true);
	assert.equal(result.code, 2, JSON.stringify(result));
	assert.equal(maintenanceStatus().mode, "open");
	assert.equal((await steer("chat_unknown", "after the lost response")).status, 404);
});
