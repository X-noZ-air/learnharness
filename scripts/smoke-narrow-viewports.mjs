/** Browser acceptance for the narrow layout. Run after npm run build:
 *  node scripts/smoke-narrow-viewports.mjs [--out DIR] [--viewport WIDTHxHEIGHT]
 *  Pass --dev to use Next dev and local font fixtures.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import puppeteer from "puppeteer-core";
import { stopOwnedSmokeServer } from "./lib/owned-smoke-lifetime.mjs";
import { answer, followUp, lesson, modelId, opening, viewports } from "../tests/fixtures/narrow-viewports.mjs";

assert.notEqual(process.platform, "win32", "Run the viewport smoke on Linux or macOS");
const root = path.resolve(import.meta.dirname, "..");
const dev = process.argv.includes("--dev");
const option = name => {
	const index = process.argv.indexOf(name);
	if (index === -1) return undefined;
	const value = process.argv[index + 1];
	assert.ok(value && !value.startsWith("--"), `${name} requires a value`);
	return value;
};
const out = option("--out");
const nameOf = ({ width, height }) => `${width}x${height}`;
const only = option("--viewport");
const cases = only ? viewports.filter(viewport => nameOf(viewport) === only) : viewports;
assert.ok(cases.length, `Unknown viewport: ${only}`);

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

const profile = await fs.mkdtemp(path.join(os.tmpdir(), "lh-viewport-"));
let app;
let browser;
let appLogs = "";
const pageErrors = [];
const modelRequests = [];
const shot = (page, name, stage) => out && page.screenshot({ path: path.join(out, `${name}-${stage}.png`) });

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
	if (dev) {
		const require = createRequire(import.meta.url);
		const { getFontAxes } = require("next/dist/compiled/@next/font/dist/google/get-font-axes.js");
		const { getGoogleFontsUrl } = require("next/dist/compiled/@next/font/dist/google/get-google-fonts-url.js");
		const fonts = Object.fromEntries(["JetBrains Mono", "Source Sans 3"].map(family => [
			getGoogleFontsUrl(family, getFontAxes(family, ["variable"], ["normal"]), "swap"),
			`@font-face { font-family: '${family}'; src: local('Arial'); font-weight: 100 900; }`,
		]));
		const fontFile = path.join(profile, "fonts.cjs");
		await fs.writeFile(fontFile, `module.exports = ${JSON.stringify(fonts)};\n`);
		env.NEXT_FONT_GOOGLE_MOCKED_RESPONSES = fontFile;
	}
	app = spawn(process.execPath, ["node_modules/next/dist/bin/next", dev ? "dev" : "start",
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

async function layout(page, viewport) {
	const size = viewport.isMobile ? 44 : 0;
	const editor = await bounds(page, input, size);
	await bounds(page, send, size);
	await bounds(page, modelButton, size);
	const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
	assert.equal(editor.windowWidth, viewport.width);
	assert.equal(documentWidth, viewport.width, "document has horizontal overflow");
	const meta = await page.$eval('meta[name="viewport"]', tag => tag.content);
	assert.match(meta, /interactive-widget=resizes-content/);
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

async function checkDrawer(page, name) {
	await sidebarClosed(page);
	await bounds(page, open, 44);
	const initialEditor = await bounds(page, input);
	await openDrawer(page);
	await bounds(page, close, 44);
	await bounds(page, teaching, 44);
	assert.equal((await bounds(page, input)).width, initialEditor.width, "drawer must overlay the editor");
	await shot(page, name, "drawer");
	await action(page, close, true);
	await sidebarClosed(page);
	const focusReturned = () => page.waitForFunction(selector => document.activeElement === document.querySelector(selector), {}, open);
	await focusReturned();

	await openDrawer(page);
	const edge = await page.$eval(backdrop, node => node.getBoundingClientRect().right - 10);
	await page.touchscreen.tap(edge, 30);
	await sidebarClosed(page);
	await focusReturned();

	await page.keyboard.press("Enter");
	await page.waitForSelector(drawer + '[aria-modal="true"]');
	await page.keyboard.press("Tab");
	assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-label")), "Home");
	await page.focus('[data-testid="session-search"]');
	await page.keyboard.press("Escape");
	await sidebarClosed(page);
	await focusReturned();
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

async function enterSidebar(page, touch) {
	if (touch) await openDrawer(page);
	else await page.waitForSelector(inlineSidebar);
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
	const { context, page } = await newClient(origin, viewport);
	try {
		if (touch) await checkDrawer(page, name);
		await enterSidebar(page, touch);
		await action(page, teaching, touch);
		await page.waitForFunction(() => location.pathname === "/chat/new");
		await page.waitForSelector('main h3');
		if (touch) await sidebarClosed(page);
		await layout(page, viewport);
		await shot(page, name, "new-session");

		await submit(page, opening(name), touch);
		await page.waitForFunction(() => /^\/chat\/chat_/.test(location.pathname) && !location.search);
		const route = new URL(page.url()).pathname;
		await readText(page, lesson);
		await layout(page, viewport);
		await shot(page, name, "lesson");

		await action(page, modelButton, touch);
		await bounds(page, '[data-testid="model-menu"]');
		await page.keyboard.press("Escape");
		await page.waitForSelector('[data-testid="model-menu"]', { hidden: true });
		await submit(page, followUp(name), touch);
		await readText(page, answer);
		assert.ok(modelRequests.some(body => body?.includes(opening(name))));
		assert.ok(modelRequests.some(body => body?.includes(followUp(name))));

		if (touch) await openDrawer(page);
		await page.reload({ waitUntil: "domcontentloaded" });
		if (touch) await sidebarClosed(page);
		else await page.waitForSelector(inlineSidebar);
		await readText(page, lesson);
		await readText(page, answer);
		await layout(page, viewport);

		const second = await newClient(origin, viewport);
		try {
			assert.equal(await second.page.evaluate(() => localStorage.getItem("lh:sidebar-open")), null);
			if (touch) await sidebarClosed(second.page);
			await enterSidebar(second.page, touch);
			const row = `[data-session-id="${route.split("/").at(-1)}"]`;
			if (touch) {
				await second.page.waitForSelector(row);
				await second.page.$eval(row, element => element.scrollIntoView({ block: "nearest" }));
				await bounds(second.page, row, 44);
			}
			await action(second.page, row, touch);
			await second.page.waitForFunction(value => location.pathname === value, {}, route);
			if (touch) await sidebarClosed(second.page);
			await readText(second.page, lesson);
			await readText(second.page, answer);
			await layout(second.page, viewport);
		} finally {
			await second.context.close();
		}
		if (!touch) await verifyDesktopPreference(page, viewport);
	} catch (error) {
		await shot(page, name, "failure");
		throw new Error(`Viewport ${name}: ${error.message}`, { cause: error });
	} finally {
		await context.close();
	}
}

try {
	await fs.mkdir(path.join(profile, "data"));
	await fs.writeFile(path.join(profile, "auth.json"), "{}\n", { mode: 0o600 });
	if (out) await fs.mkdir(out, { recursive: true });
	const providerPort = await listen(stub);
	const origin = await startApp();
	browser = await puppeteer.launch({
		...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }),
		headless: true,
		userDataDir: path.join(profile, "browser"),
		args: ["--disable-background-networking", "--disable-sync", "--no-first-run",
			// Ubuntu runners block Chrome's user-namespace sandbox.
			...(process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : []),
		],
	});

	for (const viewport of cases) {
		const { context, page } = await newClient(origin, viewport);
		try {
			await page.waitForFunction(() => !!document.querySelector('[data-testid="setup-cta"], [data-testid="setup-cta-keys"]'));
			if (viewport.hasTouch) await sidebarClosed(page);
			else await page.waitForSelector(inlineSidebar);
			await layout(page, viewport);
			await shot(page, nameOf(viewport), "start");
		} catch (error) {
			await shot(page, nameOf(viewport), "start-failure");
			throw new Error(`Empty profile at ${nameOf(viewport)}: ${error.message}`, { cause: error });
		} finally {
			await context.close();
		}
	}

	await configureModel(origin, providerPort);
	for (const viewport of cases) {
		await checkLesson(origin, viewport);
		console.log(`${nameOf(viewport)}: start, new session, lesson, answer, sidebar, reload, and second client passed`);
	}
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
