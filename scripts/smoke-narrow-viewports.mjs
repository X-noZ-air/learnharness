/** Browser acceptance for the narrow layout. Run after npm run build:
 *  node scripts/smoke-narrow-viewports.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import puppeteer from "puppeteer-core";
import { stopOwnedSmokeServer } from "./lib/owned-smoke-lifetime.mjs";
import {
	answer, desktopViewport, followUp, lesson, modelId, opening,
	phoneViewport, rotatedPhoneViewport, ultrawideViewport, viewports,
} from "../tests/fixtures/narrow-viewports.mjs";

assert.notEqual(process.platform, "win32", "Run the viewport smoke on Linux or macOS");
const root = path.resolve(import.meta.dirname, "..");
const nameOf = ({ width, height }) => `${width}x${height}`;
const isNarrow = viewport => viewport.width < 640;

const input = "main [data-file-path-input]";
const send = 'main button:is([aria-label="Send"], [aria-label="Start session"])';
const open = 'button[aria-label="Open sidebar"]';
const drawerOpener = open + '[aria-haspopup="dialog"]';
const close = 'button[aria-label="Close sidebar"]';
const drawer = '[role="dialog"][aria-label="Sessions"]';
const inlineSidebar = '[data-testid="sessions-sidebar"][aria-hidden="false"]';
const backdrop = '[data-testid="sidebar-backdrop"]';
const teaching = '[data-testid="new-session"]';
const content = "[data-session-surface]";
const modelButton = '[data-testid="stats-model"]';
const keyboardViewport = { ...phoneViewport, height: 200 };

const profile = await fs.mkdtemp(path.join(os.tmpdir(), "lh-viewport-"));
let app;
let browser;
let appLogs = "";
const pageErrors = [];
const modelRequests = [];

const stub = createServer(async (request, response) => {
	if (request.method === "GET" && request.url === "/v1/models") {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ object: "list", data: [{ id: modelId, object: "model" }] }));
		return;
	}
	if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
		response.writeHead(404).end();
		return;
	}
	try {
		const body = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString());
		const user = body.messages.findLast(message => message.role === "user");
		modelRequests.push(JSON.stringify(user?.content));
		const text = modelRequests.at(-1).includes("How many sides") ? answer : lesson;
		const chunk = { id: "synthetic-viewport-turn", object: "chat.completion.chunk", created: 1, model: modelId };
		const start = { ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] };
		const stop = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(`data: ${JSON.stringify(start)}\n\ndata: ${JSON.stringify(stop)}\n\ndata: [DONE]\n\n`);
	} catch {
		response.writeHead(400).end();
	}
});

async function listen(server) {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return server.address().port;
}

async function startApp() {
	const portProbe = createServer();
	const port = await listen(portProbe);
	await new Promise((resolve, reject) => portProbe.close(error => error ? reject(error) : resolve()));
	const origin = `http://127.0.0.1:${port}`;
	const env = {
		PATH: process.env.PATH,
		TMPDIR: profile, LH_DATA_DIR: path.join(profile, "data"), LH_AUTH_FILE: path.join(profile, "auth.json"),
		LH_IGNORE_ENV_KEYS: "1", NEXT_TELEMETRY_DISABLED: "1",
	};
	app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start",
		"--hostname", "127.0.0.1", "--port", String(port)], {
		cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"],
	});
	const capture = chunk => { appLogs = (appLogs + chunk).slice(-20_000); };
	app.stdout.on("data", capture);
	app.stderr.on("data", capture);
	app.on("error", capture);
	const end = Date.now() + 60_000;
	while (Date.now() < end && app.exitCode === null) {
		try {
			const response = await fetch(origin + "/api/chats", { signal: AbortSignal.timeout(4000) });
			if (response.ok) {
				assert.deepEqual((await response.json()).chats, [], "fixture starts without sessions");
				return origin;
			}
			await response.body?.cancel();
		} catch (error) {
			if (!(error instanceof TypeError || error.name === "TimeoutError")) throw error;
		}
		await delay(250);
	}
	throw new Error("The isolated Next server did not start");
}

async function configureModel(origin, providerPort) {
	const url = origin + "/api/custom-provider";
	const get = await fetch(url);
	assert.equal(get.status, 200);
	const etag = get.headers.get("etag");
	await get.body?.cancel();
	const response = await fetch(url, {
		method: "POST",
		headers: { origin, "if-match": etag, "content-type": "application/json" },
		body: JSON.stringify({ baseUrl: `http://127.0.0.1:${providerPort}/v1`, authMode: "keyless" }),
	});
	assert.equal(response.status, 200, await response.text());
	const pin = { model: { provider: "custom", id: modelId } };
	const slots = await fetch(origin + "/api/settings/models", {
		method: "PUT", headers: { "content-type": "application/json" },
		body: JSON.stringify({ strong: pin, cheap: pin, vision: pin }),
	});
	assert.equal(slots.status, 200, await slots.text());
}

async function newClient(origin, viewport) {
	const context = await browser.createBrowserContext();
	const page = await context.newPage();
	page.setDefaultTimeout(12_000);
	page.on("pageerror", error => pageErrors.push(error.message));
	await page.setViewport(viewport);
	await page.goto(origin, { waitUntil: "load" });
	await page.evaluate(() => document.fonts.ready.then(() => true));
	return { context, page };
}

async function action(page, selector, useTouch) {
	await page.waitForSelector(selector, { visible: true });
	if (useTouch) await page.tap(selector);
	else await page.click(selector);
}

async function bounds(page, selector, minimum = 0) {
	await page.waitForSelector(selector, { visible: true });
	const rect = await page.$eval(selector, element => {
		const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
		return { left, top, right, bottom, width, height, windowWidth: document.documentElement.clientWidth, windowHeight: window.innerHeight };
	});
	assert.ok(rect.left >= -0.5 && rect.top >= -0.5 &&
		rect.right <= rect.windowWidth + 0.5 && rect.bottom <= rect.windowHeight + 0.5,
		`${selector} clipped: ${JSON.stringify(rect)}`);
	assert.ok(rect.width >= minimum && rect.height >= minimum,
		`${selector} target is smaller than ${minimum}px: ${rect.width}x${rect.height}`);
	return rect;
}

async function waitForInlineSidebar(page) {
	await page.waitForSelector(inlineSidebar, { visible: true });
	await page.$eval(inlineSidebar, async sidebar => {
		await Promise.all(sidebar.getAnimations().map(animation => animation.finished));
	});
}

async function layout(page, viewport) {
	const size = isNarrow(viewport) ? 44 : 0;
	const editor = await bounds(page, input, size);
	const sendButton = await bounds(page, send, size);
	await bounds(page, modelButton, size);
	const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
	assert.equal(editor.windowWidth, viewport.width);
	assert.equal(documentWidth, viewport.width, "document has horizontal overflow");
	const meta = await page.$eval('meta[name="viewport"]', tag => tag.content);
	assert.match(meta, /interactive-widget=resizes-content/);

	if (viewport === ultrawideViewport) {
		const sidebar = await bounds(page, inlineSidebar);
		const composer = await bounds(page, "main [data-attachment-composer]");
		assert.equal(sidebar.left, 0);
		assert.equal(sidebar.width, 288);
		assert.equal(composer.width, 704);
		assert.ok(Math.abs((composer.left + composer.right) / 2 - (sidebar.right + viewport.width) / 2) < 8,
			"ultrawide composer stays centered in the content column");
		assert.equal(sendButton.height, 40);
	}
}

async function sidebarClosed(page, narrow = true) {
	await page.waitForSelector(drawer, { hidden: true });
	await page.waitForSelector((narrow ? drawerOpener : open) + '[aria-expanded="false"]', { visible: true });
}

async function openDrawer(page, touch = true) {
	await action(page, drawerOpener, touch);
	await page.waitForSelector(drawer + '[aria-modal="true"]');
	await page.waitForFunction(selector => document.activeElement === document.querySelector(selector), {}, drawer + " aside");
}

const waitForFocus = (page, selector) => page.waitForFunction(target =>
	document.activeElement === document.querySelector(target), {}, selector);

async function checkDrawer(page) {
	await sidebarClosed(page);
	await bounds(page, open, 44);
	const initialEditor = await bounds(page, input);
	await openDrawer(page);
	await bounds(page, close, 44);
	await bounds(page, teaching, 44);
	assert.equal((await bounds(page, input)).width, initialEditor.width, "drawer must overlay the editor");
	await action(page, close, true);
	await sidebarClosed(page);
	await waitForFocus(page, open);

	await openDrawer(page);
	const edge = await page.$eval(backdrop, node => node.getBoundingClientRect().right - 10);
	await page.touchscreen.tap(edge, 30);
	await sidebarClosed(page);
	await waitForFocus(page, open);

	await page.keyboard.press("Enter");
	await page.waitForSelector(drawer + '[aria-modal="true"]');
	await page.keyboard.press("Tab");
	assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-label")), "Home");
	await page.focus('[data-testid="session-search"]');
	await page.keyboard.press("Escape");
	await sidebarClosed(page);
	await waitForFocus(page, open);
	assert.equal(await page.evaluate(() => localStorage.getItem("lh:sidebar-open")), null);
}

async function readText(page, text) {
	await page.waitForFunction((selector, value) => {
		const session = document.querySelector(selector);
		const header = session?.querySelector("header");
		const dock = session?.querySelector("[data-dock-viewport]");
		const transcript = session?.querySelector("[data-session-find-root]");
		if (!header || !dock || !transcript) return false;
		const top = header.getBoundingClientRect().bottom;
		const bottom = dock.getBoundingClientRect().top;
		const walker = document.createTreeWalker(transcript, NodeFilter.SHOW_TEXT);
		while (walker.nextNode()) {
			const node = walker.currentNode;
			if (!node.textContent.includes(value)) continue;
			const range = document.createRange();
			range.selectNodeContents(node);
			const rect = range.getBoundingClientRect();
			if (!rect.width || rect.left < 0 || rect.right > innerWidth) continue;
			if (rect.top >= top && rect.bottom <= bottom - 28) return true;
			// The composer overlays the log, so center within the readable area.
			let scroller = transcript.parentElement;
			while (scroller && !["auto", "scroll"].includes(getComputedStyle(scroller).overflowY)) {
				scroller = scroller.parentElement;
			}
			scroller?.scrollBy({ top: (rect.top + rect.bottom - top - bottom + 28) / 2, behavior: "instant" });
			return false;
		}
		return false;
	}, { polling: 100 }, content, text);
}

async function submit(page, text, touch) {
	await action(page, input, touch);
	await page.keyboard.type(text);
	await page.waitForSelector(send + ":enabled");
	await action(page, send, touch);
}

async function enterSidebar(page, viewport) {
	if (isNarrow(viewport)) await openDrawer(page, viewport.hasTouch);
	else await waitForInlineSidebar(page);
}

async function toggleDrawerWithShortcut(page) {
	const modifier = await page.evaluate(() => /mac/i.test(navigator.platform || navigator.userAgent) ? "Meta" : "Control");
	await page.keyboard.down(modifier);
	await page.keyboard.press("b");
	await page.keyboard.up(modifier);
}

async function openDrawerWithShortcut(page) {
	await page.evaluate(() => document.activeElement.blur());
	await waitForFocus(page, "body");
	await toggleDrawerWithShortcut(page);
	await waitForFocus(page, drawer + " aside");
}

async function checkDrawerRotation(page, focusTarget = `${inlineSidebar} ${close}`) {
	await waitForFocus(page, drawer + " aside");
	await page.setViewport(rotatedPhoneViewport);
	await page.waitForSelector(drawer, { hidden: true });
	await waitForFocus(page, focusTarget);
	await page.setViewport(phoneViewport);
	await sidebarClosed(page);
}

async function checkSidebarContextMenus(page, chatId) {
	await openDrawer(page);
	await action(page, '[data-testid="sidebar-add-folder"]', true);
	await page.type('[data-testid="sidebar-new-folder-row"] input', "Rotation fixture");
	await page.keyboard.press("Enter");

	const rows = [
		["session", `[data-session-id="${chatId}"]`],
		["folder", 'button[aria-label="Expand folder Rotation fixture"]'],
	];
	for (const [kind, row] of rows) {
		const menu = `[data-testid="${kind}-context-menu"]`;
		const openMenu = async () => {
			await page.waitForSelector(row, { visible: true });
			await page.click(row, { button: "right" });
			await page.waitForSelector(menu, { visible: true });
		};
		if (kind === "session") {
			for (const reverse of [false, true]) {
				await openMenu();
				await page.keyboard.press("Escape");
				await page.waitForSelector(menu, { hidden: true });
				await waitForFocus(page, drawer);
				if (reverse) await page.keyboard.down("Shift");
				await page.keyboard.press("Tab");
				if (reverse) await page.keyboard.up("Shift");
				const focus = await page.evaluate(selector => ({
					inDrawer: document.querySelector(selector)?.contains(document.activeElement),
					label: document.activeElement.getAttribute("aria-label"),
				}), drawer + " aside");
				assert.equal(focus.inDrawer, true, "Tab moves from the dialog frame into the drawer");
				assert.equal(focus.label === "Home", !reverse, "Tab and Shift+Tab enter at opposite ends");
			}
		}
		await openMenu();
		await toggleDrawerWithShortcut(page);
		await sidebarClosed(page);
		await action(page, drawerOpener, true);
		await page.waitForSelector(drawer + '[aria-modal="true"]');
		await page.waitForSelector(row, { visible: true });
		assert.equal(await page.$(menu), null, `${kind} context menu stays closed when the drawer reopens`);
		await openMenu();
		await page.setViewport(rotatedPhoneViewport);
		await waitForInlineSidebar(page);
		assert.equal(await page.$(menu), null, `${kind} context menu closes when the drawer becomes inline`);
		await page.setViewport(phoneViewport);
		await sidebarClosed(page);
		if (kind === "session") await openDrawer(page);
	}
}

async function typeDraftWithKeyboardOpen(page, text) {
	await action(page, input, true);
	await page.setViewport(keyboardViewport);
	const draft = [text, ...Array(20).fill("Draft line")].join("\n");
	await page.keyboard.sendCharacter(draft);
	await page.waitForSelector(send + ":enabled");
	assert.ok(await page.$eval(input, editor => editor.scrollHeight > editor.clientHeight),
		"long draft scrolls within the editor");
	await layout(page, keyboardViewport);
	return draft;
}

async function submitDraftWithKeyboardOpen(page, text) {
	await typeDraftWithKeyboardOpen(page, text);
	await action(page, send, true);
	await page.setViewport(phoneViewport);
}

async function checkPracticeRename(page) {
	await page.setViewport({ ...phoneViewport, width: 360 });
	await action(page, 'header button[data-plugin-chrome-title]', true);
	const title = 'header input[aria-label="Session title"]';
	await waitForFocus(page, title);
	const field = await bounds(page, title);
	const chip = await bounds(page, 'header [data-phase="practice"]');
	assert.ok(Math.abs(chip.left - field.right - 12) < 1, "the rename field fills the space before the practice chip");
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 360);
}

async function checkDraftRetry(origin) {
	const { context, page } = await newClient(origin, phoneViewport);
	try {
		await openDrawer(page);
		await action(page, teaching, true);
		await page.waitForFunction(() => location.pathname === "/chat/new" && !location.search);
		await sidebarClosed(page);
		await openDrawer(page);
		await action(page, '[data-testid="new-session-practice"]', true);
		await page.waitForFunction(() => location.pathname === "/chat/new" && location.search === "?mode=practice");
		await sidebarClosed(page);
		await openDrawer(page);
		await page.evaluate(() => history.back());
		await page.waitForFunction(() => location.pathname === "/chat/new" && !location.search);
		await sidebarClosed(page);
		await page.evaluate(() => history.forward());
		await page.waitForFunction(() => location.search === "?mode=practice");
		await page.waitForSelector(input + '[aria-label="What do you want to practice?"]');

		const attempts = [];
		page.on("request", request => {
			if (request.method() === "DELETE" && new URL(request.url()).pathname.startsWith("/api/chats/")) return;
			if (request.method() === "POST" && new URL(request.url()).pathname === "/api/chats") {
				attempts.push(request.postData());
				if (attempts.length === 1) return request.respond({ status: 503 });
			}
			return request.continue();
		});
		await page.setRequestInterception(true);
		const draft = await typeDraftWithKeyboardOpen(page, "Practice squares after retrying session creation.");
		await action(page, send, true);
		await page.waitForFunction(() => document.querySelector('main [role="alert"]')?.textContent.includes("Try sending again"));
		await page.waitForSelector(send + ":enabled");
		await layout(page, keyboardViewport);
		for (const selector of [input, send]) {
			assert.ok(await page.$eval(selector, target => {
				const { left, width, top, bottom } = target.getBoundingClientRect();
				const x = left + width / 2;
				return [top + 2, bottom - 2].every(y => target.contains(document.elementFromPoint(x, y)));
			}), `${selector} is clipped after a failed start`);
		}

		await action(page, send, true);
		await page.waitForFunction(() => /^\/chat\/chat_/.test(location.pathname));
		assert.equal(attempts.length, 2);
		assert.deepEqual(JSON.parse(attempts[0]), { title: draft, kind: "practice" });
		assert.equal(attempts[1], attempts[0], "the retry sends the original practice draft");

		await page.setViewport(phoneViewport);
		await openDrawer(page);
		const chatPath = new URL(page.url()).pathname;
		const row = `[data-session-id="${chatPath.split("/").at(-1)}"]`;
		await page.waitForSelector(row, { visible: true });
		await page.click(row, { button: "right" });
		await action(page, '[data-testid="ctx-delete"]', false);
		const confirming = '[data-testid="delete-confirm"]';
		const pending = page.waitForRequest(request => request.method() === "DELETE" &&
			new URL(request.url()).pathname === `/api/chats/${chatPath.split("/").at(-1)}`);
		await action(page, confirming, false);
		const request = await pending;
		await toggleDrawerWithShortcut(page);
		await page.waitForSelector(confirming + ":disabled");
		await request.respond({ status: 503 });
		await page.waitForSelector('[data-testid="delete-failure"]', { visible: true });
		await action(page, '[data-testid="delete-cancel"]', false);
		await action(page, close, true);
		await sidebarClosed(page);
		await checkPracticeRename(page);
	} finally {
		await context.close();
	}
}

async function verifyDesktopPreference(page, viewport) {
	await action(page, close, false);
	await page.waitForSelector(open + '[aria-expanded="false"]');
	await page.reload({ waitUntil: "domcontentloaded" });
	await sidebarClosed(page, false);
	assert.equal(await page.evaluate(() => localStorage.getItem("lh:sidebar-open")), "0");

	// Widening back to the desktop must use its last preference even when
	// the intervening drawer was open.
	await page.setViewport({ ...viewport, width: 639 });
	await openDrawer(page, false);
	await page.setViewport(viewport);
	await sidebarClosed(page, false);
	await waitForFocus(page, open);
	assert.equal(await page.evaluate(() => localStorage.getItem("lh:sidebar-open")), "0");
	await action(page, open, false);
	await page.waitForSelector(inlineSidebar);
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.waitForSelector(inlineSidebar);
	assert.equal(await page.evaluate(() => localStorage.getItem("lh:sidebar-open")), "1");
}

async function checkLesson(origin, viewport) {
	const name = nameOf(viewport);
	const touch = Boolean(viewport.hasTouch);
	const narrow = isNarrow(viewport);
	const { context, page } = await newClient(origin, viewport);
	try {
		if (narrow) await checkDrawer(page);
		if (viewport === phoneViewport) {
			await openDrawer(page);
			await checkDrawerRotation(page);
		}
		await enterSidebar(page, viewport);
		await action(page, teaching, touch);
		await page.waitForFunction(() => location.pathname === "/chat/new");
		await page.waitForSelector('main h3');
		if (narrow) await sidebarClosed(page);
		await layout(page, viewport);

		if (viewport === phoneViewport) await submitDraftWithKeyboardOpen(page, opening(name));
		else await submit(page, opening(name), touch);
		await page.waitForFunction(() => /^\/chat\/chat_/.test(location.pathname) && !location.search);
		const route = new URL(page.url()).pathname;
		await readText(page, lesson);
		await layout(page, viewport);

		await action(page, modelButton, touch);
		await bounds(page, '[data-testid="model-menu"]');
		await page.keyboard.press("Escape");
		await page.waitForSelector('[data-testid="model-menu"]', { hidden: true });
		await submit(page, followUp(name), touch);
		await readText(page, answer);
		assert.ok(modelRequests.some(body => body?.includes(opening(name))));
		assert.ok(modelRequests.some(body => body?.includes(followUp(name))));

		if (viewport === phoneViewport) {
			await checkSidebarContextMenus(page, route.split("/").at(-1));
			await openDrawerWithShortcut(page);
			await page.keyboard.press("Escape");
			await sidebarClosed(page);
			await waitForFocus(page, drawerOpener);
			await openDrawerWithShortcut(page);
			await checkDrawerRotation(page);
			await page.setViewport(rotatedPhoneViewport);
			await waitForInlineSidebar(page);
			await action(page, close, true);
			await sidebarClosed(page, false);
			await page.setViewport(phoneViewport);
			await sidebarClosed(page);
			await openDrawerWithShortcut(page);
			await checkDrawerRotation(page, open);
		}

		if (narrow) await openDrawer(page);
		await page.reload({ waitUntil: "domcontentloaded" });
		if (narrow) await sidebarClosed(page);
		else await waitForInlineSidebar(page);
		await readText(page, lesson);
		await readText(page, answer);
		await layout(page, viewport);

		const secondViewport = touch ? desktopViewport : phoneViewport;
		const second = await newClient(origin, secondViewport);
		try {
			assert.equal(await second.page.evaluate(() => localStorage.getItem("lh:sidebar-open")), null);
			if (isNarrow(secondViewport)) await sidebarClosed(second.page);
			await enterSidebar(second.page, secondViewport);
			const row = `[data-session-id="${route.split("/").at(-1)}"]`;
			if (isNarrow(secondViewport)) {
				await second.page.waitForSelector(row);
				await second.page.$eval(row, element => element.scrollIntoView({ block: "nearest" }));
				await bounds(second.page, row, 44);
			}
			await action(second.page, row, secondViewport.hasTouch);
			await second.page.waitForFunction(value => location.pathname === value, {}, route);
			if (isNarrow(secondViewport)) await sidebarClosed(second.page);
			await readText(second.page, lesson);
			await readText(second.page, answer);
			await layout(second.page, secondViewport);
		} finally {
			await second.context.close();
		}
		if (!narrow) await verifyDesktopPreference(page, viewport);
	} catch (error) {
		throw new Error(`Viewport ${name}: ${error.message}`, { cause: error });
	} finally {
		await context.close();
	}
}

try {
	await fs.mkdir(path.join(profile, "data"));
	await fs.writeFile(path.join(profile, "auth.json"), "{}\n", { mode: 0o600 });
	const providerPort = await listen(stub);
	const origin = await startApp();
	browser = await puppeteer.launch({
		channel: "chrome",
		headless: true,
		userDataDir: path.join(profile, "browser"),
		args: ["--disable-background-networking", "--disable-sync", "--no-first-run",
			// Ubuntu runners block Chrome's user-namespace sandbox.
			...(process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : []),
		],
	});

	for (const viewport of viewports) {
		const { context, page } = await newClient(origin, viewport);
		try {
			await page.waitForFunction(() => !!document.querySelector('[data-testid="setup-cta"], [data-testid="setup-cta-keys"]'));
			if (isNarrow(viewport)) await sidebarClosed(page);
			else await waitForInlineSidebar(page);
			await layout(page, viewport);
		} catch (error) {
			throw new Error(`Empty profile at ${nameOf(viewport)}: ${error.message}`, { cause: error });
		} finally {
			await context.close();
		}
	}

	await configureModel(origin, providerPort);
	for (const viewport of viewports) {
		await checkLesson(origin, viewport);
		console.log(`${nameOf(viewport)}: start, new session, lesson, answer, sidebar, reload, and second client passed`);
	}
	await checkDraftRetry(origin);
	console.log("Practice draft retry at 412x200 and session rename at 360px passed");
	assert.deepEqual(pageErrors, [], "uncaught errors in Chromium");
} catch (error) {
	console.error(appLogs);
	throw error;
} finally {
	try {
		await browser?.close();
		if (app?.pid) await stopOwnedSmokeServer(app);
	} finally {
		if (stub.listening) await new Promise(resolve => stub.close(resolve));
		await fs.rm(profile, { recursive: true, force: true });
	}
}
