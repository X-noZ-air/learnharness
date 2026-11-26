import { createConnection } from "node:net";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

async function request(socket, op, generation, timeout) {
	return new Promise((resolve, reject) => {
		const peer = createConnection(socket);
		let reply = "";
		peer.setTimeout(timeout, () => peer.destroy(new Error("Maintenance socket timed out")));
		peer.setEncoding("utf8").on("error", reject);
		peer.on("connect", () => peer.write(JSON.stringify({ op, generation }) + "\n"));
		peer.on("data", chunk => { reply += chunk; if (reply.length > 8192) peer.destroy(new Error("Invalid response")); });
		peer.on("end", () => {
			try {
				const value = JSON.parse(reply);
				if (value.error || value.version !== 1) throw new Error(value.error || "Unexpected maintenance protocol");
				resolve(value);
			} catch (err) { reject(err); }
		});
	});
}
try {
	const { values, positionals } = parseArgs({ allowPositionals: true, options: { socket: { type: "string" }, "timeout-ms": { type: "string", default: "30000" }, generation: { type: "string" } } });
	const [op] = positionals;
	const socket = values.socket || process.env.LH_MAINTENANCE_SOCKET;
	const timeout = Number(values["timeout-ms"]);
	if (positionals.length !== 1 || !["drain", "resume", "release", "status"].includes(op) || !socket || !Number.isSafeInteger(timeout) || timeout < 0)
		throw new Error("Usage: maintenance.mjs status|drain|resume|release --socket PATH [--timeout-ms N] [--generation ID]");
	const end = performance.now() + timeout;
	let status = await request(socket, op, values.generation, 5000);
	const generation = status.generation;
	while (op === "drain" && !status.drained && !status.reasons.length && performance.now() < end) {
		await delay(Math.min(100, end - performance.now()));
		status = await request(socket, "status", generation, 5000);
	}
	console.log(JSON.stringify(status));
	if (op === "drain" && !status.drained) process.exitCode = 2;
} catch (error) { console.error(error.message); process.exitCode = 1; }
