import { resolveConversationSpec } from "@/src/core";
import {
	mutation,
	clampChatLevel,
	effectiveSettings,
	getChat,
	parseSessionSettingsBody,
	stores,
	validateChatSettings,
} from "@/src/server";

/**
 * The per-chat model control (model-control wave).
 * PER-SESSION MODELS (owner, 2026-09-28): this route is THE in-session
 * writer — the composer's control binds the session's own record; the
 * strong slot is only the birth default and never reaches an existing
 * session again.
 * Validation is the catalog gate (src/server/model-catalog.ts): unknown
 * provider/model is a 400. Thinking levels never reject (owner,
 * interlude 2026-09-22): a pinned level clamps to the named model's
 * nearest supported and the clamped value is stored. Effective next turn
 * by construction (agents are stateless per turn).
 */
async function handlePut(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = await req.json().catch(() => null);
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "Not found" }, { status: 404 });

	const parsed = parseSessionSettingsBody(body);
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

	const { model, thinkingLevel, fastMode } = parsed.settings;
	let settings;
	if (fastMode !== undefined && model === undefined && thinkingLevel === undefined) {
		settings = { ...chat.settings, fastMode };
	} else {
		const verdict = validateChatSettings(parsed.settings);
		if (!verdict.ok) {
			return Response.json({ error: verdict.error, supported: verdict.supported }, { status: 400 });
		}
		const strong = effectiveSettings().models.strong;
		settings = clampChatLevel({ model, thinkingLevel }, strong);
		const current = chat.settings;
		if ((model || thinkingLevel !== undefined) && current?.fastMode !== undefined) {
			const before = resolveConversationSpec(current, strong);
			const after = resolveConversationSpec(settings, strong);
			if (before?.provider === after?.provider && before?.id === after?.id) {
				settings.fastMode = current.fastMode;
			}
		}
	}
	stores.chatStore.saveSettings(id, settings);
	return Response.json({ settings });
}

export const PUT = mutation(handlePut);
