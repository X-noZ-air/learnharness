/** Plugins use the documented per-server initialization hook. A plugin failure
 * must not prevent access to existing learning data or teaching/practice. */
export async function register() {
	if (process.env.NEXT_RUNTIME === "nodejs") {
		const { listenForMaintenance } = await import("./src/server/maintenance-socket.ts");
		const { admissionClosed, tracked, whenOpen } = await import("./src/core/maintenance.ts");
		await listenForMaintenance();
		const boot = () => tracked("startup", async () => {
			const { initializeModelCatalog } = await import("./src/server/remote-model-catalog.ts");
			initializeModelCatalog();
			const { initializePlugins } = await import("./src/server/plugins.ts");
			try { await initializePlugins(); }
			catch (error) { console.error("[plugins] Initialization failed; plugin management will report the error:", error); }
		});
		if (admissionClosed()) whenOpen(() => { void boot().catch(err => console.error("Startup failed", err)); });
		else await boot();
	}
}
