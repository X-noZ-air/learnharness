import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { fixture, until } from "../tests/helpers/maintenance-server.mjs";

const f = await fixture();
const confirm = '[data-testid="abort-turn-confirm"]';
const editor = '[data-testid="practice-thinking-field"] [data-file-path-input]';
const quiz = { question: "Which synthetic option is first?", options: [{ label: "First" }, { label: "Second" }], correctAnswer: "First", explanation: "Synthetic explanation." };
let browser;

async function seed(kind, toolName, args) {
	const { id } = await f.api("chats", { title: "Maintenance dismissal fixture", kind });
	const file = path.join(f.data, "chats", id + ".json");
	const chat = JSON.parse(await fs.readFile(file, "utf8"));
	const callId = randomUUID();
	chat.messages = [{
		id: randomUUID(), role: "assistant", api: "openai-completions", provider: "custom", model: "synthetic",
		timestamp: Date.now(), stopReason: "toolUse", content: [{ type: "toolCall", id: callId, name: toolName, arguments: args }],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	}];
	if (toolName === "problem") chat.messages.push({
		id: randomUUID(), role: "toolResult", toolName, toolCallId: callId, timestamp: Date.now(), isError: false,
		content: [{ type: "text", text: "Problem posed" }],
	});
	await fs.writeFile(file, JSON.stringify(chat));
	return { id, callId };
}

async function open(chatId) {
	const page = await browser.newPage();
	await page.goto(f.origin + "/chat/" + chatId, { waitUntil: "domcontentloaded", timeout: 90000 });
	return page;
}

async function showConfirmation(page, title) {
	await page.waitForFunction(expected => {
		if (document.querySelector('[data-testid="abort-turn-title"]')?.textContent === expected) return true;
		window.dispatchEvent(new Event("lh:kbd-abort-turn"));
		return false;
	}, { polling: 250, timeout: 30000 }, title);
}

function drain() {
	return f.control({ op: "drain", attempt: { id: randomUUID(), startByMs: Date.now() + 5000 } });
}

function record(chatId) {
	return f.api("chats/" + chatId);
}

async function delayDismissal(page) {
	await page.evaluate(() => {
		const originalFetch = window.fetch;
		window.fetch = async (input, init) => {
			if (String(input).endsWith("/dismiss")) await new Promise(resolve => { window.releaseDismissal = resolve; });
			return originalFetch(input, init);
		};
	});
}

try {
	await f.start();
	browser = await puppeteer.launch({ channel: "chrome", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
	const practice = await seed("practice", "problem", { statement: "Prove the synthetic claim.", mode: "recall" });
	const originalPrefix = "Original streamed response.";
	f.holdModel(originalPrefix);
	await f.api("chat", { chatId: practice.id, input: { type: "thinking", problemCallId: practice.callId, text: "Here is my first step." } });
	const practicePage = await open(practice.id);
	await practicePage.waitForFunction(prefix => document.body.textContent.includes(prefix), {}, originalPrefix);
	const bar = await practicePage.$('[data-testid="practice-dock-bar"]');
	if (bar) await bar.click();
	await practicePage.waitForSelector(editor, { visible: true });
	await practicePage.type(editor, "My unsent proof");
	assert.equal(await practicePage.$eval(editor, element => element.textContent), "My unsent proof");
	const practiceHold = await drain();
	assert.equal(practiceHold.mode, "draining");
	assert.ok(practiceHold.counts["main-turn"] > 0);
	const abortRequests = [];
	practicePage.on("request", req => { if (req.url().endsWith("/api/activity/abort")) abortRequests.push(req.url()); });
	await showConfirmation(practicePage, "Discard this problem?");
	const accepted = practicePage.waitForResponse(res => res.url().endsWith("/dismiss"));
	await practicePage.click(confirm);
	assert.equal((await accepted).status(), 202);
	await until(async () => !(await record(practice.id)).turnInFlight, "dismissed original settlement");
	assert.ok((await record(practice.id)).messages.some(m => m.customType === "problem-dismissed"));
	await practicePage.waitForSelector(editor, { hidden: true });
	assert.deepEqual(abortRequests, []);
	assert.equal((await f.cli("status", ["--generation", practiceHold.generation])).drained, true);
	await f.cli("resume", ["--generation", practiceHold.generation]);
	f.releaseModel();
	await practicePage.close();

	const question = await seed("teach", "quiz", quiz);
	const stalePage = await open(question.id);
	stalePage.on("request", req => { if (req.url().endsWith("/api/activity/abort")) abortRequests.push(req.url()); });
	await delayDismissal(stalePage);
	await showConfirmation(stalePage, "Dismiss this question?");
	await stalePage.click(confirm);
	await stalePage.waitForFunction(() => typeof window.releaseDismissal === "function");
	const successorPrefix = "Successor streamed response.";
	f.holdModel(successorPrefix);
	await f.api("chat", { chatId: question.id, input: { type: "answer", toolCallId: question.callId, answer: {
		kind: "quiz", questionText: quiz.question, dontKnow: false, answers: [{ index: 1, label: "First", value: "First" }], answeredAt: new Date().toISOString(),
	} } });
	const successor = await open(question.id);
	await successor.waitForFunction(prefix => document.body.textContent.includes(prefix), {}, successorPrefix);
	const successorHold = await drain();
	assert.ok(successorHold.counts["main-turn"] > 0);
	const rejected = stalePage.waitForResponse(res => res.url().endsWith("/dismiss"));
	await stalePage.evaluate(() => window.releaseDismissal());
	assert.equal((await rejected).status(), 400);
	assert.equal((await record(question.id)).turnInFlight, true);
	f.releaseModel();
	await until(async () => !(await record(question.id)).turnInFlight, "successor settlement");
	assert.ok((await record(question.id)).messages.some(m => m.content?.some?.(part => part.text === successorPrefix + " Synthetic answer.")));
	assert.deepEqual(abortRequests, []);
	await f.cli("resume", ["--generation", successorHold.generation]);
	await stalePage.close();
	await successor.close();

	const retries = await seed("practice", "problem", { statement: "Prove another synthetic claim.", mode: "recall" });
	const attempt = text => f.api("chat", { chatId: retries.id, input: { type: "thinking", problemCallId: retries.callId, text } });
	const firstPrefix = "First practice attempt is streaming.";
	f.holdModel(firstPrefix);
	await attempt("First proof");
	const retryPage = await open(retries.id);
	await retryPage.waitForFunction(prefix => document.body.textContent.includes(prefix), {}, firstPrefix);
	await delayDismissal(retryPage);
	await showConfirmation(retryPage, "Discard this problem?");
	await retryPage.click(confirm);
	await retryPage.waitForFunction(() => typeof window.releaseDismissal === "function");
	f.releaseModel();
	await until(async () => !(await record(retries.id)).turnInFlight, "first practice attempt settlement");
	const retryPrefix = "Second practice attempt is streaming.";
	f.holdModel(retryPrefix);
	await attempt("Second proof");
	const retrySuccessor = await open(retries.id);
	await retrySuccessor.waitForFunction(prefix => document.body.textContent.includes(prefix), {}, retryPrefix);
	const retryHold = await drain();
	const staleAttempt = retryPage.waitForResponse(res => res.url().endsWith("/dismiss"));
	await retryPage.evaluate(() => window.releaseDismissal());
	assert.equal((await staleAttempt).status(), 409);
	assert.equal((await record(retries.id)).turnInFlight, true);
	f.releaseModel();
	await until(async () => !(await record(retries.id)).turnInFlight, "second practice attempt settlement");
	assert.ok((await record(retries.id)).messages.some(m => m.content?.some?.(part => part.text === retryPrefix + " Synthetic answer.")));
	await f.cli("resume", ["--generation", retryHold.generation]);
	await retryPage.close();
	await retrySuccessor.close();

	const delayed = await seed("teach", "quiz", quiz);
	const sidePage = await open(delayed.id);
	await delayDismissal(sidePage);
	await showConfirmation(sidePage, "Dismiss this question?");
	await sidePage.click(confirm);
	await sidePage.waitForFunction(() => typeof window.releaseDismissal === "function");
	await sidePage.evaluate(() => window.dispatchEvent(new Event("lh:kbd-toggle-question-thread")));
	const sideInput = '[data-testid="side-thread-input"]';
	await sidePage.waitForSelector(sideInput, { visible: true });
	await sidePage.type(sideInput, "My side question");
	const acknowledged = sidePage.waitForResponse(res => res.url().endsWith("/dismiss"));
	await sidePage.evaluate(() => window.releaseDismissal());
	assert.equal((await acknowledged).status(), 200);
	await sidePage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
	assert.equal(await sidePage.$eval(sideInput, input => input.value), "My side question");
	console.log("Maintenance dismissal browser smoke passed");
} catch (error) { console.error(f.logs()); throw error; }
finally { try { await browser?.close(); } finally { await f.close(); } }
