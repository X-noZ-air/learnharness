import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { stopOwnedSmokeServer } from "../../scripts/lib/owned-smoke-lifetime.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);
const exec = promisify(execFile);

export async function until(probe, label, timeout = 90000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		const value = await probe();
		if (value) return value;
		await delay(50);
	}
	throw new Error("Timed out waiting for " + label);
}
async function listen(server) {
	server.listen(0, "127.0.0.1"); await once(server, "listening"); return server.address().port;
}
export async function fixture() {
	const home = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "lh-drain-"));
	const data = path.join(home, "data");
	await fs.mkdir(data);
	let barrier, waiting = 0;
	const model = http.createServer(async (req, res) => {
		if (req.url === "/v1/models") { res.end(JSON.stringify({ data: [{ id: "synthetic" }] })); return; }
		if (req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
		const body = [];
		for await (const part of req) body.push(part);
		const request = JSON.parse(Buffer.concat(body).toString());
		waiting++;
		try { await barrier?.promise; } finally { waiting--; }
		res.writeHead(200, { "content-type": "text/event-stream" });
		const chunk = (delta, finish_reason) => "data: " + JSON.stringify({ id: "fixture", model: "synthetic", choices: [{ index: 0, delta, finish_reason }] }) + "\n\n";
		const worker = request.tools?.some(tool => tool.function?.name === "submit_result");
		const delta = worker
			? { role: "assistant", tool_calls: [{ index: 0, id: "fixture-result", type: "function", function: { name: "submit_result", arguments: '{"result":{}}' } }] }
			: { role: "assistant", content: "Synthetic answer." };
		res.end(chunk(delta, null) + chunk({}, worker ? "tool_calls" : "stop") + "data: [DONE]\n\n");
	});
	const baseUrl = "http://127.0.0.1:" + await listen(model) + "/v1";
	const portReservation = net.createServer();
	const origin = "http://127.0.0.1:" + await listen(portReservation);
	await new Promise(resolve => portReservation.close(resolve));
	const id = randomBytes(16).toString("hex");
	const slot = { model: { provider: "custom", id: "synthetic" }, thinkingLevel: "off" };
	await fs.writeFile(path.join(data, "settings.json"), JSON.stringify({ version: 1, models: { strong: slot, cheap: slot, vision: slot },
		customProvider: { baseUrl, authMode: "keyless", credentialBindingId: id, models: [{ id: "synthetic", context: 131072, maxTokens: 4096 }] } }));
	await fs.writeFile(path.join(home, "auth.json"), JSON.stringify({ __learnharness_custom_provider_binding: JSON.stringify({ version: 1, id, baseUrl, authMode: "keyless" }) }));
	const { getFontAxes } = require("next/dist/compiled/@next/font/dist/google/get-font-axes.js");
	const { getGoogleFontsUrl } = require("next/dist/compiled/@next/font/dist/google/get-google-fonts-url.js");
	const fonts = Object.fromEntries(["JetBrains Mono", "Source Sans 3"].map(family => [getGoogleFontsUrl(family, getFontAxes(family, ["variable"], ["normal"]), "swap"), "@font-face{font-family:'" + family + "';src:local('Arial')}"]));
	await fs.writeFile(path.join(home, "fonts.cjs"), "module.exports=" + JSON.stringify(fonts));
	let server, socket, starts = 0, logs = "";
	async function start(hold = false) {
		socket = path.join(home, "control-" + ++starts + ".sock");
		const env = { PATH: process.env.PATH, HOME: home, TMPDIR: home, LH_DATA_DIR: data, LH_AUTH_FILE: path.join(home, "auth.json"),
			NEXT_TELEMETRY_DISABLED: "1", NEXT_FONT_GOOGLE_MOCKED_RESPONSES: path.join(home, "fonts.cjs"),
			LH_MAINTENANCE_SOCKET: socket, LH_MAINTENANCE_STARTUP_HOLD: hold ? "1" : "0" };
		logs = "";
		server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "-H", "127.0.0.1", "-p", new URL(origin).port], { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		for (const stream of [server.stdout, server.stderr]) stream.on("data", chunk => { logs = (logs + chunk).slice(-30000); });
		await until(() => {
			if (server.exitCode !== null || server.signalCode) throw new Error("Server exited: " + logs);
			return logs.includes("Ready in");
		}, "Next server");
		// Dev compiles instrumentation on the first request.
		await api("chats");
		await until(() => fs.stat(socket).then(s => s.isSocket(), () => false), "maintenance listener");
	}
	async function stop() { if (server) { await stopOwnedSmokeServer(server); server = undefined; } }
	async function cli(op, args = [], expected = 0) {
		const result = await exec(process.execPath, ["scripts/maintenance.mjs", op, "--socket", socket, ...args], { cwd: root }).catch(error => error);
		assert.equal(result.code ?? 0, expected, result.stderr + result.stdout);
		return JSON.parse(result.stdout);
	}
	async function api(url, body) {
		const res = await fetch(origin + "/api/" + url, body === undefined ? {} : { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
		assert.ok(res.ok, res.status + " " + (res.ok ? "" : (await res.text()).slice(0, 500)));
		return res.json();
	}
	function releaseModel() { barrier?.resolve(); barrier = undefined; }
	return { home, data, origin, start, stop, cli, api, logs: () => logs,
		holdModel() { barrier = Promise.withResolvers(); }, releaseModel,
		waitForModel: () => until(() => waiting > 0, "local model request"),
		async close() { releaseModel(); try { await stop(); } finally { model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); await fs.rm(home, { recursive: true, force: true }); } },
	};
}
