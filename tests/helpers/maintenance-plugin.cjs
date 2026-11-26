// Synthetic community backend for the real-server maintenance smoke.
const fs = require("node:fs/promises");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

exports.activate = ctx => {
	ctx.workers.register({ id: "fixture-worker", instructions: "Return a synthetic result.",
		resultSchema: { type: "object", properties: {}, additionalProperties: false } });
	ctx.handle("dispatch", async ({ chatId }) => {
		const tool = ctx.createBackgroundTool({ agent: "teacher", chatId }, {
			name: "fixture_job", label: "Synthetic job", description: "Synthetic maintenance test",
			parameters: { type: "object", properties: {} }, workerId: "fixture-worker",
			prepare: () => ({ input: {}, prompt: "Synthetic task", model: { provider: "custom", id: "synthetic" }, maxTurns: 1 }),
			async format() {
				await fs.writeFile(path.join(ctx.dataDirectory, "format-started"), "");
				const end = Date.now() + 30000;
				while (Date.now() < end) {
					if (await fs.stat(path.join(ctx.dataDirectory, "release-format")).then(() => true, () => false)) return { text: "Durable synthetic result" };
					await delay(25);
				}
				throw new Error("Fixture formatter timed out");
			},
		});
		return tool.execute("fixture-tool-call", {}, ctx.signal);
	});
};
