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
 * Model and effort writes validate against the catalog and clamp effort to
 * the nearest supported level. Retain the Fast preference only when the
 * effective model stays the same. Fast-only writes merge into the latest
 * session settings so overlapping edits keep their model and effort.
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
