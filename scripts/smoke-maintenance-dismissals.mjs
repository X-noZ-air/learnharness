import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { fixture } from "../tests/helpers/maintenance-server.mjs";

const f = await fixture();
const quiz = { question: "Which synthetic option is first?", options: [{ label: "First" }, { label: "Second" }], correctAnswer: "First", explanation: "Synthetic explanation.", nodeId: "fixture-node" };
const problem = { statement: "Prove the synthetic claim.", mode: "recall" };
let browser;

async function seed(kind, toolName, args) {
	const { id } = await f.api("chats", { title: "Maintenance dismissal fixture", kind });
	const file = path.join(f.data, "chats", id + ".json");
	const chat = JSON.parse(await fs.readFile(file, "utf8"));
	const assistant = content => ({
		id: randomUUID(), role: "assistant", api: "openai-completions", provider: "custom", model: "synthetic",
		timestamp: Date.now(), stopReason: "toolUse", content,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	});
	const call = (name, args) => ({ type: "toolCall", id: randomUUID(), name, arguments: args });
	const result = (call, details) => ({
		id: randomUUID(), role: "toolResult", toolName: call.name, toolCallId: call.id, timestamp: Date.now(), isError: false,
		content: [{ type: "text", text: "Tool finished." }], details,
	});
	const target = call(toolName, args);
	if (kind === "practice") chat.messages = [assistant([target]), result(target)];
	else {
		const probe = call("probe_done", {});
		chat.messages = [assistant([probe]), result(probe, { ok: true }), assistant([target])];
	}
	await fs.writeFile(file, JSON.stringify(chat));
	return id;
}

async function verifyDismissal(chatId, field, title, draft) {
	const before = (await f.api("chats/" + chatId)).messages;
	const page = await browser.newPage();
	try {
		await page.goto(f.origin + "/chat/" + chatId, { waitUntil: "domcontentloaded", timeout: 90000 });
		await page.waitForSelector(field, { visible: true });
		await page.type(field, draft);
		await page.waitForFunction(expected => {
			if (document.querySelector('[data-testid="abort-turn-title"]')?.textContent === expected) return true;
			window.dispatchEvent(new Event("lh:kbd-abort-turn"));
			return false;
		}, { polling: 250, timeout: 30000 }, title);
		const response = page.waitForResponse(res => res.url().endsWith("/dismiss"));
		await page.click('[data-testid="abort-turn-confirm"]');
		assert.equal((await response).status(), 409);
		await page.waitForFunction(() => document.body.textContent.includes("Update in progress. Try again shortly."));
		await page.waitForSelector(field, { visible: true });
		assert.equal(await page.$eval(field, element => element.textContent), draft);
		assert.deepEqual((await f.api("chats/" + chatId)).messages, before);
	} finally { await page.close(); }
}

try {
	await f.start();
	const credentialFile = path.join(f.home, "chatgpt-credentials.json");
	const credentials = await fs.readFile(credentialFile);
	const questionId = await seed("teach", "quiz", quiz);
	const problemId = await seed("practice", "problem", problem);
	const hold = await f.control({ op: "drain", holdMs: 180000, attempt: { id: randomUUID(), startByMs: Date.now() + 5000 } });
	assert.equal(hold.drained, true);
	const status = await fetch(f.origin + "/api/subscriptions", {
		headers: { origin: f.origin, "x-learnharness-subscriptions": "1", "sec-fetch-site": "same-origin" },
	});
	assert.equal(status.status, 200);
	assert.equal((await status.json()).chatgpt.available, true);
	assert.deepEqual(await fs.readFile(credentialFile), credentials);
	browser = await puppeteer.launch({ channel: "chrome", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
	await verifyDismissal(questionId, '[data-testid="reading-thinking-field"] [data-file-path-input]', "Dismiss this question?", "My complete unsent reading notes.");
	await verifyDismissal(problemId, '[data-testid="practice-thinking-field"] [data-file-path-input]', "Discard this problem?", "My complete unsent solution draft.");
	assert.equal((await f.cli("status", ["--generation", hold.generation])).drained, true);
	console.log("Maintenance dismissal browser smoke passed");
} catch (error) { console.error(f.logs()); throw error; }
finally { try { await browser?.close(); } finally { await f.close(); } }
