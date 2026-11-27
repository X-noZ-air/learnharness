import { admissionClosed, maintenanceRefusal, mutation, waitForOpen } from "../core/maintenance.ts";
import { isPluginHostError } from "./plugin-host.ts";
import { apiRequestRefusal } from "./desktop-access.ts";
import type { PluginFrontendContext, PluginInfo } from "../core/plugins.ts";

/** Thin HTTP adapter, separately injectable so its tests never boot plugins. */
export interface PluginTransportHost {
	list(): PluginInfo[];
	conflicts(): { id: string; error: string }[];
	refresh(): Promise<void>;
	setEnabled(id: string, enabled: boolean): Promise<void>;
	call(id: string, operation: string, input: unknown): Promise<unknown>;
	convertDocument(id: string, request: Request): ReturnType<PluginFrontendContext["documents"]["toMarkdown"]>;
	asset(id: string, segments: string[]): { bytes: Uint8Array; contentType: string };
}
class InputError extends Error {}
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
async function objectBody(request: Request): Promise<Record<string, unknown>> {
	let body: unknown;
	try { body = await request.json(); } catch { throw new InputError("Expected a JSON object"); }
	if (!body || typeof body !== "object" || Array.isArray(body)) throw new InputError("Expected a JSON object");
	return body as Record<string, unknown>;
}
export function createPluginTransport(deps: {
	getHost(): Promise<PluginTransportHost>;
	cancelOwnedFlashcardsBatch?(input: unknown): Promise<unknown> | undefined;
	directory: string;
}) {
	const guarded = async (handle: () => Promise<Response>) => {
		try { return await handle(); }
		catch (error) {
			const status = error instanceof InputError ? 400 : isPluginHostError(error) ? error.status : 500;
			return json({ error: error instanceof Error || isPluginHostError(error) ? error.message : "Plugin request failed" }, status);
		}
	};
	const catalog = (host: PluginTransportHost) => ({ plugins: host.list(), directory: deps.directory, conflicts: host.conflicts() });
	return {
		list: () => guarded(async () => json(catalog(await deps.getHost()))),
		refresh: (request: Request) => guarded(async () => {
			const body = await objectBody(request);
			if (body.action !== "refresh") throw new InputError("Expected action: refresh");
			const host = await deps.getHost();
			await host.refresh();
			return json(catalog(host));
		}),
		setEnabled: (id: string, request: Request) => guarded(async () => {
			const body = await objectBody(request);
			if (typeof body.enabled !== "boolean") throw new InputError("enabled must be a boolean");
			const host = await deps.getHost();
			await host.setEnabled(id, body.enabled);
			return json(catalog(host));
		}),
		call(id: string, request: Request) {
			const handle = (continuationOnly: boolean) => guarded(async () => {
				const { operation, input } = await objectBody(request);
				if (typeof operation !== "string" || !operation.trim()) throw new InputError("operation must be a nonempty string");
				const dispatch = async () => json({ result: (await (await deps.getHost()).call(id, operation, input)) ?? null });
				if (!continuationOnly) return dispatch();
				if (id !== "flashcards" || operation !== "cancel-generation") return maintenanceRefusal();
				if (!input || typeof input !== "object" || !("batchId" in input) || typeof input.batchId !== "string" || !input.batchId)
					throw new InputError("Invalid batch id");
				while (admissionClosed()) {
					if (request.signal.aborted) return new Response(null, { status: 499 });
					const cancellation = deps.cancelOwnedFlashcardsBatch?.(input);
					if (cancellation) return json({ result: (await cancellation) ?? null });
					if (!await waitForOpen(request.signal)) return new Response(null, { status: 499 });
				}
				return mutation(dispatch)();
			});
			return admissionClosed() ? handle(true) : mutation(() => handle(false))();
		},
		convertDocument: (id: string, request: Request) => guarded(async () => json(await (await deps.getHost()).convertDocument(id, request))),
		asset: (id: string, segments: string[]) => guarded(async () => {
			const { bytes, contentType } = (await deps.getHost()).asset(id, segments);
			return new Response(new Uint8Array(bytes), { headers: { "Content-Type": contentType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
		}),
	};
}

/** This one streamed route must avoid Proxy's silently truncated body clone.
 * Preserve the identical mode-aware API policy before ANY params/body/host
 * work, including unsupported methods and framework-style OPTIONS responses. */
export function createPluginDocumentRoute(transport: Pick<ReturnType<typeof createPluginTransport>, "convertDocument">) {
	const refusal = (request: Request) => {
		const error = apiRequestRefusal(request);
		return error ? json({ error }, 403) : undefined;
	};
	const unsupported = (request: Request) => refusal(request) ?? new Response(null, { status: 405 });
	return {
		async POST(request: Request, context: { params: Promise<{ id: string }> }) {
			const denied = refusal(request);
			if (denied) return denied;
			return mutation(async () => transport.convertDocument((await context.params).id, request), "upload")();
		},
		OPTIONS: (request: Request) => refusal(request) ?? new Response(null, { status: 204, headers: { Allow: "OPTIONS, POST" } }),
		GET: unsupported, HEAD: unsupported, PUT: unsupported, PATCH: unsupported, DELETE: unsupported,
	};
}
