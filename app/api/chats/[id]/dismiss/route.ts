/**
 * THE SILENT DISMISSAL ROUTE (owner design 2026-10-03, "A2"): ESC-abort
 * from a pending question writes the dismissed toolResult to the record
 * and wakes NOTHING — no beginTurn, no agent, no tokens. The session
 * enters the derived dismissal pause (endsInDismissal): job deliveries
 * hold in the wake pipeline's steer queue, the continuation fold demands
 * nothing, and the user's next plain message is the wake that carries
 * the dismissal (plus any held deliveries) into the agent's context.
 *
 * Parallel question calls: each dismissal completes exactly its own call
 * (results bind by toolCallId, not position), so the dock advances
 * call-by-call and the composer returns only when nothing dangles.
 *
 * Guards mirror the turn route's honesty: 404 unknown chat, 400 for an
 * input that targets no dangling question call (or isn't a real
 * dismissal). A RUNNING turn no longer refuses (owner, 2026-10-04 — the
 * GLM practice-loop incident): the dismissal is PARKED server-side and
 * the turn's settle path applies it against the persisted record, so
 * ESC-discard now doubles as the turn abort's bookkeeper. Plugin
 * dismissals additionally validate the current saved occurrence.
 */
import { assertPluginQuestionInputAllowed, ChatInputError, dismissAppends, emit, parseDismissInput } from "@/src/core";
import { admissionClosed, runningTurn, getChat, isTurnRunning, parkDismissal, stores, preparePluginQuestionDismissal, reconcilePluginQuestionCompatibility, tracked, waitForOpen } from "@/src/server";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	const owner = runningTurn(id);
	await reconcilePluginQuestionCompatibility(stores.chatStore, id);
	if (!getChat(id)) return Response.json({ error: "Unknown chat" }, { status: 404 });

	let input;
	try {
		// The POST-family convention: the body is { input } (chatId lives in
		// the URL here).
		const body = (await req.json().catch(() => null)) as { input?: unknown } | null;
		input = parseDismissInput(body?.input ?? null);
	} catch (err) {
		if (err instanceof ChatInputError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}

	for (;;) {
		if (req.signal.aborted) return new Response(null, { status: 499 });
		const chat = getChat(id);
		if (!chat) return Response.json({ error: "Unknown chat" }, { status: 404 });
		const running = isTurnRunning(id);
		const current = running ? runningTurn(id) : undefined;
		const liveHistory = current?.dismissalHistory?.();
		let appends;
		try {
			assertPluginQuestionInputAllowed(chat.messages, input);
			appends = input.type === "dismiss-plugin-question" ? preparePluginQuestionDismissal(chat, input)
				: dismissAppends(liveHistory ? { messages: liveHistory } : chat, input, liveHistory !== undefined);
		} catch (err) {
			if (err instanceof ChatInputError) return Response.json({ error: err.message }, { status: 400 });
			throw err;
		}
		if (input.type === "dismiss-problem" && (running ? !current?.turnId || input.turnId !== current.turnId : input.turnId !== undefined)) {
			return Response.json({ error: "The practice turn changed. Retry the dismissal." }, { status: 409 });
		}
		if (running) {
			if (current !== owner) return Response.json({ error: "The running turn changed. Retry the dismissal." }, { status: 409 });
			parkDismissal(id, input);
			owner?.abort();
			return Response.json({ ok: true, parked: true }, { status: 202 });
		}
		if (admissionClosed()) {
			if (!await waitForOpen(req.signal)) return new Response(null, { status: 499 });
			continue;
		}
		return tracked("write-request", () => {
			stores.chatStore.saveMessages(id, [...chat.messages, ...appends]);
			emit("record-changed", { chatId: id });
			return Response.json({ ok: true });
		});
	}
}
