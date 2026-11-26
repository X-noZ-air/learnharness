import { createServer } from "node:net";
import { chmod, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { control } from "../core/maintenance.ts";

const key = Symbol.for("learnharness.maintenance.listener");
export async function listenForMaintenance() {
	const socket = process.env.LH_MAINTENANCE_SOCKET;
	if (!socket) {
		if (process.env.LH_MAINTENANCE_STARTUP_HOLD === "1") throw new Error("Startup hold requires LH_MAINTENANCE_SOCKET");
		return;
	}
	const holder = process as typeof process & { [key]?: Promise<void> };
	return holder[key] ??= listen(socket);
}
async function listen(socket: string) {
	const parent = path.dirname(socket);
	const stat = await lstat(parent);
	if (!path.isAbsolute(socket) || !stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.() || await realpath(parent) !== parent)
		throw new Error("Maintenance socket requires an absolute path in a private, service-owned directory");
	const server = createServer(peer => {
		let buffer = "";
		peer.setEncoding("utf8").setTimeout(5000, () => peer.destroy());
		peer.on("error", () => peer.destroy());
		peer.on("data", data => {
			buffer += data;
			if (buffer.length > 1024) { peer.destroy(); return; }
			if (!buffer.includes("\n")) return;
			peer.pause();
			try {
				const request = JSON.parse(buffer);
				const result = control(request.op, request.generation);
				peer.end(JSON.stringify(result) + "\n");
			} catch { peer.end('{"error":"Invalid command, hold or generation"}\n'); }
		});
	});
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
	try { await chmod(socket, 0o600); }
	catch (error) { server.close(); throw error; }
	server.unref();
}
