import assert from "node:assert/strict";
import { newDrainAttempt } from "./helpers/maintenance-attempt.ts";
import test, { after } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { createModels, type OAuthCredential, type ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lh-web-sub-"));
process.env.LH_AUTH_FILE = path.join(directory, "auth.json");
process.env.LH_DATA_DIR = path.join(directory, "data");
delete process.env.LH_DESKTOP_SERVER; delete process.env.LH_DESKTOP_API_SECRET;
await fs.writeFile(process.env.LH_AUTH_FILE, "{}", { mode: 0o600 });
const require = createRequire(import.meta.url);
const { SCOPES, createChatGPT, fileStore } = require("../electron/chatgpt.cjs");
const { createWebSubscriptionOwner, webSubscriptionOwner, webSubscriptionsEnabled } = await import("../src/server/web-subscriptions.ts");
const { subscriptionControlsResponse, subscriptionBrowserResponse } = await import("../src/server/web-subscription-http.ts");
const chat = await import("../src/agent/chatgpt-bridge.ts");
const native = await import("../src/agent/subscription-bridge.ts");
const { piModels } = await import("../src/agent/models.ts");
const { refreshConnectionCatalog } = await import("../src/server/model-catalog.ts");
const model = piModels().getModels("openai").find((entry) => entry.api === "openai-responses")!;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
	assert.equal(String(input), "https://api.openai.com/v1/models", "unexpected network request forbidden");
	return Response.json({ models: [{ slug: model.id, display_name: "Fixture ChatGPT", visibility: "list" }] });
};
const copilot = githubCopilotProvider().getModels()[0]!;
const credentials = (id: string): OAuthCredential => ({ type: "oauth", access: id === "xai" ? "fixture-xai-access" : "tid=fixture;proxy-ep=proxy.individual.githubcopilot.com;", refresh: "fixture-refresh", expires: Date.now() + 3600000, ...(id === "github-copilot" ? { availableModelIds: [copilot.id] } : {}) });
await fs.writeFile(path.join(directory, "chatgpt-credentials.json"), JSON.stringify({ version: 1, hostId: "fixture-host", allowBackgroundUse: true, activeId: "fixture-account", registrations: [{ id: "fixture-account", clientId: "oaiapp_fixture", issuer: "https://auth.openai.com", subject: "fixture-subject", email: "fixture@example.invalid", tokens: { accessToken: "fixture-chatgpt-access", refreshToken: "fixture-chatgpt-refresh", idToken: "fixture-id-token", scopes: SCOPES, expiresAt: Date.now() + 3600000 } }] }), { mode: 0o600 });
for (const id of ["github-copilot", "xai"]) await fs.writeFile(path.join(directory, `${id}-credentials.json`), JSON.stringify({ version: 1, allowBackgroundUse: true, connectionId: "00000000-0000-4000-8000-000000000001", credential: credentials(id) }), { mode: 0o600 });
function request(command?: Record<string, unknown>, origin = "http://192.168.1.10:3000") {
	return new Request(`${origin}/api/subscriptions`, { method: command ? "POST" : "GET", headers: { host: new URL(origin).host, origin, "sec-fetch-site": "same-origin", "x-learnharness-subscriptions": "1", "content-type": "application/json" }, ...(command ? { body: JSON.stringify(command) } : {}) });
}
after(async () => { webSubscriptionOwner().close(); globalThis.fetch = originalFetch; await fs.rm(directory, { recursive: true, force: true }); });

test("cold subscription reads and cancellation preserve their public contracts during drain", async t => {
	const { control } = await import("../src/core/maintenance.ts");
	const key = Symbol.for("lh.webSubscriptions");
	const global = globalThis as typeof globalThis & { [key]?: { owner?: unknown } };
	const previous = global[key];
	const previousSocket = process.env.LH_MAINTENANCE_SOCKET;
	global[key] = {};
	process.env.LH_MAINTENANCE_SOCKET = "fixture";
	const hold = control("drain", undefined, undefined, newDrainAttempt());
	t.after(() => {
		control("resume", hold.generation);
		global[key] = previous;
		if (previousSocket === undefined) delete process.env.LH_MAINTENANCE_SOCKET;
		else process.env.LH_MAINTENANCE_SOCKET = previousSocket;
	});
	assert.equal(hold.drained, true);
	const credentialFile = path.join(directory, "chatgpt-credentials.json");
	const credentialsBefore = await fs.readFile(credentialFile);
	const upstream = createChatGPT({ store: fileStore(credentialFile), openExternal: async () => {} });
	const cancel = await subscriptionControlsResponse(request({ providerId: "chatgpt", op: "cancel" }));
	assert.equal(cancel.status, 200);
	assert.deepEqual(await cancel.json(), { value: upstream.cancelLogin() });
	const status = await subscriptionControlsResponse(request());
	assert.equal(status.status, 200);
	const payload = await status.json();
	assert.deepEqual(payload.chatgpt, await upstream.status());
	assert.equal(payload.chatgpt.activeId, "fixture-account");
	assert.deepEqual(payload.native.map((provider: { providerId: string; connected: boolean }) => [provider.providerId, provider.connected]),
		[["github-copilot", true], ["xai", true]]);
	assert.deepEqual(await fs.readFile(credentialFile), credentialsBefore);
	assert.equal(control("status", hold.generation).drained, true);
});

test("ordinary web restores configured sibling credentials, private runtime leases work for LAN-owned requests", async () => {
	await refreshConnectionCatalog();
	assert(chat.chatGPTConnected()); assert(native.nativeSubscriptionConnected("github-copilot")); assert(native.nativeSubscriptionConnected("xai"));
	assert.equal((await chat.chatGPTLease(chat.chatGPTScope(model.id), false)).accessToken, "fixture-chatgpt-access");
	const xaiModel = native.nativeSubscriptionModels().find((entry) => entry.provider === "xai-subscription")!;
	assert.equal((await native.subscriptionLease(native.subscriptionScope("xai", xaiModel.id), false)).apiKey, "fixture-xai-access");
	const response = await subscriptionControlsResponse(request());
	assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
	const publicState = await response.text();
	for (const secret of ["fixture-chatgpt-access", "fixture-chatgpt-refresh", "fixture-id-token", "fixture-xai-access", "fixture-refresh"]) assert(!publicState.includes(secret));
	assert(publicState.includes("fixture@example.invalid"));
});

test("web background OFF immediately aborts background streams, retains foreground and rejects private background leases", async () => {
	const foreground = chat.chatGPTAbortController(false), background = chat.chatGPTAbortController(true);
	const nativeForeground = native.subscriptionAbortController("xai", false), nativeBackground = native.subscriptionAbortController("xai", true);
	try {
		assert.equal((await subscriptionControlsResponse(request({ providerId: "chatgpt", op: "consent", enabled: false }))).status, 200);
		assert(background.controller.signal.aborted); assert(!foreground.controller.signal.aborted);
		const scope = chat.chatGPTScope(model.id); await chat.chatGPTLease(scope, false); await assert.rejects(chat.chatGPTLease(scope, true));
		assert.equal((await subscriptionControlsResponse(request({ providerId: "xai", op: "consent", enabled: false }))).status, 200);
		assert(nativeBackground.controller.signal.aborted); assert(!nativeForeground.controller.signal.aborted);
		const xaiModel = native.nativeSubscriptionModels().find((entry) => entry.provider === "xai-subscription")!;
		const nativeScope = native.subscriptionScope("xai", xaiModel.id); await native.subscriptionLease(nativeScope, false); await assert.rejects(native.subscriptionLease(nativeScope, true));
		await subscriptionControlsResponse(request({ providerId: "xai", op: "disconnect" }));
		assert(nativeForeground.controller.signal.aborted); assert(!native.nativeSubscriptionConnected("xai"));
		assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "xai-credentials.json"), "utf8")), { version: 1, allowBackgroundUse: false });
	} finally { foreground.release(); background.release(); nativeForeground.release(); nativeBackground.release(); }
});

test("HTTP controls reject cross-origin, simple-form and private credential operations; desktop never falls back", async () => {
	const forged = request({ providerId: "chatgpt", op: "consent", enabled: true }); forged.headers.set("origin", "https://unrelated.invalid");
	assert.equal((await subscriptionControlsResponse(forged)).status, 403);
	const noHeader = request(); noHeader.headers.delete("x-learnharness-subscriptions");
	assert.equal((await subscriptionControlsResponse(noHeader)).status, 403);
	const noOrigin = request({ providerId: "chatgpt", op: "cancel" }); noOrigin.headers.delete("origin");
	assert.equal((await subscriptionControlsResponse(noOrigin)).status, 403);
	for (const op of ["lease", "models", "snapshot", "token", "openExternal"]) assert.equal((await subscriptionControlsResponse(request({ providerId: "chatgpt", op }))).status, 400);
	const huge = request({ providerId: "chatgpt", op: "cancel", padding: "x".repeat(16384) });
	assert.equal((await subscriptionControlsResponse(huge)).status, 413);
	const browser = new Request("http://localhost:3000/api/subscriptions/browser?id=00000000-0000-4000-8000-000000000001");
	assert.equal((await subscriptionBrowserResponse(browser)).status, 403);
	for (const [marker, secret] of [["1", undefined], [undefined, "fixture-capability"]]) {
		if (marker) process.env.LH_DESKTOP_SERVER = marker; else delete process.env.LH_DESKTOP_SERVER;
		if (secret) process.env.LH_DESKTOP_API_SECRET = secret; else delete process.env.LH_DESKTOP_API_SECRET;
		assert(!webSubscriptionsEnabled());
		assert.equal((await subscriptionControlsResponse(request())).status, 404);
		await assert.rejects(chat.chatGPTRequest("status"), /desktop app/);
	}
	delete process.env.LH_DESKTOP_SERVER; delete process.env.LH_DESKTOP_API_SECRET;
});

function fakeSDK(login: (id: string, interaction: ProviderAuthInteraction) => Promise<OAuthCredential>) {
	const factory = (id: string) => {
		const provider = id === "xai" ? xaiProvider() : githubCopilotProvider();
		return { ...provider, auth: { oauth: { ...provider.auth.oauth!, login: (interaction: ProviderAuthInteraction) => login(id, interaction), refresh: async () => credentials(id) } } };
	};
	return { createModels, githubCopilotProvider: () => factory("github-copilot"), xaiProvider: () => factory("xai") };
}
test("device browser actions preserve complete URLs privately, are origin-bound, one-use and cancellation-bound", async () => {
	const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "lh-web-action-"));
	let complete!: (credential: OAuthCredential) => void;
	const pending = new Promise<OAuthCredential>((resolve) => { complete = resolve; });
	let notified!: () => void;
	const notification = new Promise<void>((resolve) => { notified = resolve; });
	const owner = createWebSubscriptionOwner({ directory: scratch, sdk: fakeSDK(async (_id, interaction) => { interaction.notify({ type: "device_code", userCode: "PUBLIC", verificationUri: "https://auth.x.ai/device?user_code=PUBLIC" }); notified(); return pending; }) });
	try {
		const login = owner.control("xai", { op: "login" }, "http://localhost:3000"); await notification;
		const interaction = (await owner.native.status()).find((entry: { providerId: string }) => entry.providerId === "xai")!.interaction;
		const command = { op: "open", attemptId: interaction.attemptId, actionId: interaction.browser.id };
		const opened = await owner.control("xai", command, "http://localhost:3000");
		assert(opened.browserAction); assert(!JSON.stringify(opened).includes("auth.x.ai"));
		const id = new URL(opened.browserAction, "http://localhost:3000").searchParams.get("id")!;
		assert.equal(await owner.takeBrowserAction(id, "http://other.invalid"), undefined);
		assert.equal(await owner.takeBrowserAction(id, "http://localhost:3000"), "https://auth.x.ai/device?user_code=PUBLIC");
		assert.equal(await owner.takeBrowserAction(id, "http://localhost:3000"), undefined);
		const stale = await owner.control("xai", command, "http://localhost:3000");
		await owner.control("xai", { op: "cancel" }, "http://localhost:3000");
		complete(credentials("xai")); await login;
		assert.equal(await owner.takeBrowserAction(new URL(stale.browserAction!, "http://localhost:3000").searchParams.get("id")!, "http://localhost:3000"), undefined);
	} finally { owner.close(); await fs.rm(scratch, { recursive: true, force: true }); }
});

test("web ChatGPT login supplies only an opaque browser action; cancel/replacement invalidates earlier launch", async () => {
	const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "lh-web-chat-action-"));
	const owner = createWebSubscriptionOwner({ directory: scratch, sdk: fakeSDK(async (id) => credentials(id)) });
	try {
		const first = await owner.control("chatgpt", { op: "login" }, "http://localhost:3000");
		assert(first.browserAction); assert(!JSON.stringify(first).includes("auth.openai.com"));
		await owner.control("chatgpt", { op: "cancel" }, "http://localhost:3000");
		const second = await owner.control("chatgpt", { op: "login" }, "http://localhost:3000");
		assert(second.browserAction);
		const firstId = new URL(first.browserAction, "http://localhost:3000").searchParams.get("id")!;
		assert.equal(await owner.takeBrowserAction(firstId, "http://localhost:3000"), undefined);
		const secondId = new URL(second.browserAction, "http://localhost:3000").searchParams.get("id")!;
		const target = new URL((await owner.takeBrowserAction(secondId, "http://localhost:3000"))!);
		assert.equal(target.origin, "https://auth.openai.com");
		const callback = new URL(target.searchParams.get("redirect_uri")!);
		assert.equal(callback.hostname, "127.0.0.1"); assert.equal(callback.pathname, "/auth/callback");
		assert(target.searchParams.has("state")); assert(target.searchParams.has("code_challenge"));
	} finally { owner.close(); await fs.rm(scratch, { recursive: true, force: true }); }
});

test("drain waits for a device sign-in through its bound browser action and durable credential save", async () => {
	const { control } = await import("../src/core/maintenance.ts");
	const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "lh-device-drain-"));
	const previous = process.env.LH_MAINTENANCE_SOCKET;
	process.env.LH_MAINTENANCE_SOCKET = path.join(scratch, "unit.sock");
	const challenge = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<OAuthCredential>();
	const owner = createWebSubscriptionOwner({ directory: scratch, sdk: fakeSDK(async (_id, interaction) => {
		interaction.notify({ type: "device_code", userCode: "FIXTURE", verificationUri: "https://example.invalid/verify" });
		challenge.resolve();
		return finish.promise;
	}) });
	const origin = "http://localhost";
	try {
		const login = owner.control("xai", { op: "login" }, origin);
		await challenge.promise;
		const state = control("drain", undefined, undefined, newDrainAttempt());
		assert.equal(state.drained, false);
		assert.equal(state.counts["sign-in"], 1);
		await assert.rejects(owner.control("xai", { op: "login" }, origin), /maintenance/);
		const pending = (await owner.native.status()).find((p: {providerId: string}) => p.providerId === "xai")!.interaction;
		await assert.rejects(owner.control("xai", { op: "open", attemptId: "stale", actionId: pending.browser.id }, origin));
		const action = await owner.control("xai", { op: "open", attemptId: pending.attemptId, actionId: pending.browser.id }, origin);
		const id = new URL(action.browserAction!, origin).searchParams.get("id")!;
		assert.equal(await owner.takeBrowserAction(id, origin), "https://example.invalid/verify");
		finish.resolve(credentials("xai")); await login;
		assert.equal(control("status", state.generation).drained, true);
		assert.ok(JSON.parse(await fs.readFile(path.join(scratch, "xai-credentials.json"), "utf8")).credential);
	} finally {
		const status = control("status");
		if (status.mode === "draining") control("resume", status.generation);
		owner.close();
		if (previous === undefined) delete process.env.LH_MAINTENANCE_SOCKET;
		else process.env.LH_MAINTENANCE_SOCKET = previous;
		await fs.rm(scratch, { recursive: true, force: true });
	}
});

test("a pending web sign-in remains visible and can finish through its local callback during drain", async () => {
	const { control } = await import("../src/core/maintenance.ts");
	const previous = process.env.LH_MAINTENANCE_SOCKET;
	process.env.LH_MAINTENANCE_SOCKET = path.join(directory, "unit.sock");
	const origin = "http://localhost:3000";
	try {
		const response = await subscriptionControlsResponse(request({ providerId: "chatgpt", op: "login" }, origin));
		assert.equal(response.status, 200);
		const { browserAction } = await response.json();
		const hold = control("drain", undefined, undefined, newDrainAttempt());
		assert.equal(hold.counts["sign-in"], 1);
		const status = await subscriptionControlsResponse(request(undefined, origin));
		assert.equal((await status.json()).chatgpt.pending, true);
		const late = await subscriptionControlsResponse(request({ providerId: "chatgpt", op: "login" }, origin));
		assert.equal(late.status, 503);
		const launch = await subscriptionBrowserResponse(new Request(origin + browserAction, {
			headers: { host: new URL(origin).host, "sec-fetch-site": "same-origin" },
		}));
		assert.equal(launch.status, 303);
		const parameters = new URL(launch.headers.get("location")!).searchParams;
		const callback = new URL(parameters.get("redirect_uri")!);
		assert.equal(callback.hostname, "127.0.0.1");
		callback.searchParams.set("state", parameters.get("state")!);
		callback.searchParams.set("error", "access_denied");
		assert.equal((await originalFetch(callback)).status, 200);
		assert.equal(control("status", hold.generation).drained, true);
	} finally {
		const status = control("status");
		if (status.mode === "draining") control("resume", status.generation);
		if (previous === undefined) delete process.env.LH_MAINTENANCE_SOCKET;
		else process.env.LH_MAINTENANCE_SOCKET = previous;
	}
});

test("the web control cancels an admitted device sign-in during drain", { timeout: 5000 }, async (t) => {
	const { control } = await import("../src/core/maintenance.ts");
	const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "lh-device-cancel-"));
	const previous = process.env.LH_MAINTENANCE_SOCKET;
	process.env.LH_MAINTENANCE_SOCKET = path.join(scratch, "unit.sock");
	const challenge = Promise.withResolvers<void>();
	const owner = createWebSubscriptionOwner({ directory: scratch, sdk: fakeSDK(async (_id, interaction) => {
		interaction.notify({ type: "device_code", userCode: "FIXTURE", verificationUri: "https://example.invalid/verify" });
		challenge.resolve();
		return interaction.prompt({ type: "text", message: "Fixture prompt" }).then(() => credentials("xai"));
	}) });
	t.mock.method(webSubscriptionOwner(), "control", owner.control);
	const issue = (op: string) => subscriptionControlsResponse(request({ providerId: "xai", op }));
	const login = issue("login");
	try {
		await challenge.promise;
		const hold = control("drain", undefined, undefined, newDrainAttempt());
		assert.equal(hold.counts["sign-in"], 1);
		assert.equal((await issue("login")).status, 503);
		assert.equal((await issue("cancel")).status, 200);
		await login;
		assert.equal((await owner.native.status()).find((entry: { providerId: string }) => entry.providerId === "xai")?.pending, false);
		assert.equal(control("status", hold.generation).drained, true);
	} finally {
		owner.close();
		await login;
		const status = control("status");
		if (status.mode === "draining") control("resume", status.generation);
		if (previous === undefined) delete process.env.LH_MAINTENANCE_SOCKET;
		else process.env.LH_MAINTENANCE_SOCKET = previous;
		await fs.rm(scratch, { recursive: true, force: true });
	}
});
