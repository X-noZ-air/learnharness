// POSIX integration test. Every request reaches a real server with a disposable profile.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fixture, until } from "../tests/helpers/maintenance-server.mjs";

const f = await fixture();
const send = (chatId, text) => f.api("chat", { chatId, input: { type: "text", text } });
const settled = (chatId, label) => until(async () => !(await f.api("chats/" + chatId)).turnInFlight, label);
const quiz = { question: "Which synthetic option is first?", options: [{ label: "First" }, { label: "Second" }], correctAnswer: "First", explanation: "Synthetic explanation." };
async function refused(id) {
	const response = await fetch(f.origin + "/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chatId: id, input: { type: "text", text: "late draft" } }) });
	assert.equal(response.status, 503); assert.equal((await response.json()).code, "maintenance");
}
async function hold(kind) {
	const s = await f.control({ op: "drain" });
	assert.equal(s.mode, "draining"); assert.ok(s.counts[kind] > 0, JSON.stringify(s)); return s;
}
try {
	await f.start(true);
	assert.equal((await f.cli("status")).mode, "startup-hold");
	await refused("fixture");
	await f.cli("release");
	const { id } = await f.api("chats", { title: "Synthetic maintenance session" });
	const { id: parked } = await f.api("chats", { title: "Synthetic session with an open question" });
	f.holdModel(); await send(id, "first turn"); await f.waitForModel();
	const held = await hold("main-turn"); await refused(id);
	assert.equal((await f.cli("resume", ["--generation", held.generation])).drained, false);
	f.releaseModel();
	await settled(id, "completed main turn");
	const record = await f.api("chats/" + id);
	const answer = record.messages.find(m => m.role === "assistant");
	assert.ok(JSON.stringify(answer).includes("Synthetic answer."));
	assert.ok(!JSON.stringify(record.messages).includes("late draft"));
	f.holdModel();
	const side = await fetch(f.origin + "/api/chats/" + id + "/side-chats", { method: "POST", headers: { "content-type": "application/json" },
		body: JSON.stringify({ anchor: { messageId: answer.id, partId: answer.id + "-t0", blockIndex: 0, blockText: "Synthetic answer." }, text: "Side question" }) });
	assert.equal(side.status, 200, side.ok ? "" : await side.text());
	await f.waitForModel();
	const sideStatus = await hold("side-chat"); assert.ok(!sideStatus.counts["main-turn"]);
	const drain = f.cli("drain", ["--generation", sideStatus.generation]); f.releaseModel();
	assert.match(await side.text(), /Synthetic answer/); assert.equal((await drain).drained, true);
	await f.cli("resume");
	f.holdModel();
	const form = new FormData(); form.append("files", new Blob(["Synthetic note about addition."]), "note.md");
	const imported = fetch(f.origin + "/api/graph/import", { method: "POST", body: form });
	await f.waitForModel();
	const extract = await hold("extraction"); assert.ok(extract.counts.upload > 0);
	f.releaseModel(); await (await imported).text(); assert.equal((await f.cli("drain", ["--generation", extract.generation])).drained, true);
	await f.stop();
	// A completed plugin computation whose durable marker still needs a session delivery.
	const job = { id: "job_synthetic", chatId: id, kind: "plugin", toolCallId: "fixture-call", status: "done", activity: "finished",
		updatedAt: new Date().toISOString(), createdAt: new Date().toISOString(), delivery: { kind: "result", status: "pending" },
		result: { pluginId: "fixture", toolName: "fixture", text: "Synthetic result", outcome: { id: "fixture", status: "succeeded", result: {} } } };
	await fs.mkdir(path.join(f.data, "jobs"), { recursive: true });
	await fs.writeFile(path.join(f.data, "jobs", job.id + ".json"), JSON.stringify(job));
	// The same kind of marker in a session whose teacher is waiting for an answer.
	const parkedFile = path.join(f.data, "chats", parked + ".json");
	const parkedChat = JSON.parse(await fs.readFile(parkedFile, "utf8"));
	parkedChat.messages.push({ ...answer, id: "parked-question", content: [{ type: "toolCall", id: "parked-call", name: "quiz", arguments: quiz }], stopReason: "toolUse" });
	await fs.writeFile(parkedFile, JSON.stringify(parkedChat));
	const parkedJob = { ...job, id: "job_parked", chatId: parked, toolCallId: "parked-fixture-call" };
	await fs.writeFile(path.join(f.data, "jobs", parkedJob.id + ".json"), JSON.stringify(parkedJob));
	await f.start(true);
	const restored = await f.api("chats/" + id);
	assert.deepEqual(restored.messages, record.messages);
	assert.ok(restored.sideChats[0].messages.some(m => m.text === "Synthetic answer."));
	assert.equal((await f.api("jobs?chatId=" + id)).jobs[0].delivery.status, "pending");
	await f.cli("release");
	f.holdModel();
	await f.api("jobs?chatId=" + id);
	const delivery = await hold("delivery"); await f.waitForModel(); f.releaseModel();
	// The marker behind the open question is saved and needs the learner, so it does not hold the server.
	assert.equal((await f.cli("drain", ["--generation", delivery.generation])).drained, true);
	assert.equal((await f.api("jobs?chatId=" + id)).jobs[0].delivery.status, "delivered");
	assert.equal((await f.api("jobs?chatId=" + parked)).jobs[0].delivery.status, "pending");
	await f.cli("resume"); await send(id, "continue after restart"); await f.cli("drain");
	assert.ok(JSON.stringify((await f.api("chats/" + id)).messages).includes("continue after restart"));
	await f.cli("resume");
	// A caller that dies while it waits cannot leave the server refusing writes.
	f.holdModel(); await send(id, "turn during a lost caller"); await f.waitForModel();
	const lost = f.spawnCli("drain", ["--timeout-ms", "60000", "--hold-ms", "1500"]);
	try {
		const held = await until(async () => { const s = await f.cli("status"); return s.mode === "draining" && s; }, "hold of the caller");
		await delay(2500);
		assert.equal((await f.cli("status")).generation, held.generation, "a living caller keeps its hold past the hold period");
		await refused(id);
		lost.kill("SIGKILL");
		const reopened = await until(async () => { const s = await f.cli("status"); return s.mode === "open" && s; }, "expired hold", 10000);
		assert.notEqual(reopened.generation, held.generation);
	} finally { lost.kill("SIGKILL"); }
	f.releaseModel(); await settled(id, "turn during a lost caller");
	// A learner message accepted into a run that ends before taking it exists only in memory.
	f.holdModel(); await send(id, "turn the learner stops"); await f.waitForModel();
	await f.api("chats/" + id + "/steer", { input: { type: "steer", id: "steer_smoke", text: "Parked synthetic steer" } });
	await f.api("activity/abort", { kind: "turn", id });
	await settled(id, "stopped main turn"); f.releaseModel();
	const postponed = await f.cli("drain", [], 2);
	assert.deepEqual(postponed.reasons, ["parked-learner-steer"]); assert.equal(postponed.mode, "open");
	assert.ok(!JSON.stringify((await f.api("chats/" + id)).messages).includes("Parked synthetic steer"));
	await send(id, "after the postponed switch");
	assert.equal((await f.cli("drain")).drained, true);
	assert.ok(JSON.stringify((await f.api("chats/" + id)).messages).includes("Parked synthetic steer"));
	// The parked marker survives the stop and is delivered once the learner continues that session.
	assert.equal((await f.api("jobs?chatId=" + parked)).jobs[0].delivery.status, "pending");
	await f.stop(); await f.start();
	assert.equal((await f.api("jobs?chatId=" + parked)).jobs[0].delivery.status, "pending");
	await f.api("chats/" + parked + "/dismiss", { input: { type: "dismiss", toolCallId: "parked-call",
		answer: { kind: "quiz", questionText: quiz.question, dontKnow: false, answers: [], dismissed: true, answeredAt: new Date().toISOString() } } });
	await send(parked, "continue after the question"); await settled(parked, "turn after the question");
	assert.ok(JSON.stringify((await f.api("chats/" + parked)).messages).includes("steer_" + parkedJob.id));
	assert.equal((await f.api("jobs?chatId=" + parked)).jobs[0].delivery.status, "delivered");
	const pkg = path.join(f.data, "plugins", "drain-fixture");
	const dist = path.join(pkg, "dist");
	await fs.mkdir(dist, { recursive: true });
	await fs.writeFile(path.join(dist, "manifest.json"), JSON.stringify({ apiVersion: 1, id: "drain-fixture", name: "Synthetic maintenance fixture", version: "1.0.0", minAppVersion: "0.7.0", main: "main.js", backend: "backend.cjs" }));
	await fs.writeFile(path.join(dist, "main.js"), "export function activate() {}");
	await fs.copyFile(new URL("../tests/helpers/maintenance-plugin.cjs", import.meta.url), path.join(dist, "backend.cjs"));
	await f.api("plugins", { action: "refresh" });
	const enable = await fetch(f.origin + "/api/plugins/drain-fixture", { method: "PUT", headers: { "content-type": "application/json" }, body: '{"enabled":true}' });
	assert.equal(enable.status, 200, enable.ok ? "" : await enable.text());
	f.holdModel();
	await f.api("plugins/drain-fixture/call", { operation: "dispatch", input: { chatId: id } });
	await f.waitForModel();
	const pending = await hold("job");
	assert.ok(pending.counts["plugin-task"] > 0);
	assert.deepEqual(pending.reasons, ["unknown-plugin-lifecycle"]);
	f.releaseModel();
	await until(() => fs.stat(path.join(pkg, "data", "format-started")).then(() => true, () => false), "plugin result formatting");
	assert.ok((await f.cli("status")).counts.job > 0);
	const formattedJob = (await f.api("jobs?chatId=" + id)).jobs.find(job => job.plugin?.pluginId === "drain-fixture");
	assert.equal(formattedJob.status, "done");
	assert.equal(formattedJob.delivery.status, "pending");
	await fs.writeFile(path.join(pkg, "data", "release-format"), "");
	await until(async () => !Object.keys((await f.cli("status")).counts).length, "plugin result settlement");
	assert.equal((await f.cli("status")).drained, false);
	assert.ok(JSON.stringify((await f.api("chats/" + id)).messages).includes("Durable synthetic result"));
	console.log("Maintenance smoke passed");
} catch (error) { console.error(f.logs()); throw error; }
finally { await f.close(); }
