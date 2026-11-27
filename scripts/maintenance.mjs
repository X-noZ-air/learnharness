import { createConnection } from "node:net";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

class DrainTimeout extends Error {}
class SocketTimeout extends Error {}

async function request(socket, command, deadline = Infinity) {
	const remaining = deadline - performance.now();
	if (remaining <= 0) throw new DrainTimeout();
	return new Promise((resolve, reject) => {
		const peer = createConnection(socket);
		let reply = "";
		const timer = setTimeout(() => {
			peer.destroy(remaining <= 5000 ? new DrainTimeout() : new SocketTimeout("Maintenance socket timed out"));
		}, Math.min(5000, Math.ceil(remaining)));
		peer.once("close", () => clearTimeout(timer));
		peer.setEncoding("utf8").on("error", reject);
		peer.on("connect", () => {
			if (performance.now() >= deadline) peer.destroy(new DrainTimeout());
			else peer.write(JSON.stringify(command) + "\n");
		});
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

async function drain(socket, generation, holdMs, timeout) {
	const deadline = performance.now() + timeout;
	// The server starts the lease after receipt. Measuring from before send
	// gives the caller a conservative deadline even for a buffered reply.
	const period = holdMs ?? 60000;
	let validUntil;
	let wallDeadline;
	let status;
	const renew = () => {
		wallDeadline = Date.now() + period;
		validUntil = performance.now() + period;
		return request(socket, { op: "drain", generation, holdMs: period }, deadline);
	};
	try {
		status = await renew();
		while (status.mode === "draining") {
			if (typeof status.generation !== "string" || !status.generation || (generation !== undefined && status.generation !== generation))
				throw new Error("Drain response did not confirm the requested hold generation");
			generation = status.generation;
			const remaining = Math.min(deadline, validUntil) - performance.now();
			if (remaining <= 0) break;
			if (status.drained === true) {
				const now = Date.now();
				const remainingHoldMs = Math.floor(Math.min(validUntil - performance.now(), wallDeadline - now));
				if (remainingHoldMs <= 0 || performance.now() >= deadline) break;
				return { ...status, holdExpiresAtMs: now + remainingHoldMs, remainingHoldMs };
			}
			if (status.reasons.length) break;
			await delay(Math.min(100, period / 2, Math.ceil(remaining)));
			if (performance.now() >= validUntil) break;
			status = await renew();
		}
	} catch (error) {
		if (!(error instanceof DrainTimeout) && !(error instanceof SocketTimeout && generation)) throw error;
	}
	process.exitCode = 2;
	if (generation && (!status || status.mode === "draining")) {
		try { return await request(socket, { op: "resume", generation }); }
		catch (error) {
			const current = await request(socket, { op: "status" }).catch(() => undefined);
			if (current && current.generation !== generation) return current;
			console.error("Drain release could not be confirmed:", error.message);
			return;
		}
	}
	if (!status) console.error("Drain timed out before the server confirmed a hold");
	return status;
}

try {
	const { values, positionals } = parseArgs({ allowPositionals: true, options: { socket: { type: "string" }, "timeout-ms": { type: "string", default: "30000" },
		"hold-ms": { type: "string" }, generation: { type: "string" } } });
	const [op] = positionals;
	const socket = values.socket || process.env.LH_MAINTENANCE_SOCKET;
	const timeout = Number(values["timeout-ms"]);
	const holdMs = values["hold-ms"] === undefined ? undefined : Number(values["hold-ms"]);
	if (positionals.length !== 1 || !["drain", "resume", "release", "status"].includes(op) || !socket || !Number.isSafeInteger(timeout) || timeout < 0
		|| (holdMs !== undefined && (op !== "drain" || !Number.isSafeInteger(holdMs) || holdMs < 1)))
		throw new Error("Usage: maintenance.mjs status|drain|resume|release --socket PATH [--generation ID] [drain: --timeout-ms N --hold-ms N]");
	if ((op === "resume" || op === "release") && !values.generation) throw new Error(`${op} requires --generation ID`);
	const status = op === "drain"
		? await drain(socket, values.generation, holdMs, timeout)
		: await request(socket, { op, generation: values.generation });
	if (status) console.log(JSON.stringify(status));
} catch (error) { console.error(error.message); process.exitCode = 1; }
