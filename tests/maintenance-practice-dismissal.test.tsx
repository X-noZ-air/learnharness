import React, { act, useReducer } from "react";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { LhMessage } from "../src/core/native-messages.ts";
import { newDrainAttempt } from "./helpers/maintenance-attempt.ts";

test("a practice dismissal refused during drain leaves the task and its complete draft visible", async t => {
	const directory = mkdtempSync(path.join(tmpdir(), "lh-practice-dismiss-"));
	const { document, window } = parseHTML("<html><body><div id='root'></div></body></html>");
	process.env.LH_DATA_DIR = directory;
	process.env.LH_AUTH_FILE = path.join(directory, "auth.json");
	process.env.LH_MAINTENANCE_SOCKET = path.join(directory, "control.sock");
	Object.assign(globalThis, { React, window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true });
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const { activeProblemOf } = await import("../src/core/native-messages.ts");
	const { control } = await import("../src/core/maintenance.ts");
	const { POST } = await import("../app/api/chats/[id]/dismiss/route.ts");
	const { chatStore } = await import("../src/store/chats.ts");
	const { SessionModel } = await import("../components/session-core.ts");
	const { PracticeDock } = await import("../components/practice-dock.tsx");
	const { createRoot } = await import("react-dom/client");
	const chat = chatStore.createChat("Practice dismissal", "practice");
	const input = { statement: "Prove that the sum is even.", mode: "recall" };
	const problemCallId = "practice-call";
	const messages: LhMessage[] = [
		{ ...fauxAssistantMessage([fauxToolCall("problem", input, { id: problemCallId })], { stopReason: "toolUse" }), id: "practice-pose" },
		{ role: "toolResult", id: "practice-posed", toolCallId: problemCallId, toolName: "problem",
			content: [{ type: "text", text: "Problem posed" }], isError: false, timestamp: 1 },
	];
	chatStore.saveMessages(chat.id, messages);
	const replied = Promise.withResolvers<number>();
	const deliver = Promise.withResolvers<void>();
	const model = new SessionModel({ chatId: chat.id, initialMessages: messages, fetch: async (url, options) => {
		const response = await POST(new Request(`http://fixture${url}`, options), { params: Promise.resolve({ id: chat.id }) });
		replied.resolve(response.status);
		await deliver.promise;
		return response;
	} });
	let dismissal: Promise<unknown> | undefined;
	function Surface() {
		const [, redraw] = useReducer((n: number) => n + 1, 0);
		model.onChange = redraw;
		const state = model.getState();
		const problem = activeProblemOf(state.nativeMessages);
		return <>
			{problem && <PracticeDock problemCallId={problem.toolCallId} input={problem.input as typeof input}
				expanded onExpand={() => {}} onSubmit={() => assert.fail("Unexpected submission")} />}
			{problem && <button type="button" aria-label="Dismiss practice problem" onClick={() => { dismissal = model.dismissProblem(problem.toolCallId); }}>Dismiss</button>}
			{state.error && <p role="alert">{state.error.message}</p>}
		</>;
	}
	const host = document.getElementById("root")!;
	const root = createRoot(host);
	const draft = "  First, group the terms.\nThen prove each pair is even.  ";
	const editor = () => host.querySelector<HTMLElement>('[data-file-path-input]');
	try {
		await act(async () => root.render(<Surface />));
		await act(async () => {
			editor()!.textContent = draft;
			editor()!.dispatchEvent(new window.Event("input", { bubbles: true }));
		});
		const hold = control("drain", undefined, undefined, newDrainAttempt());
		t.after(() => control("resume", hold.generation));
		await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Dismiss practice problem"]')!.click(); });
		assert.equal(await replied.promise, 503);
		assert.match(host.textContent!, /Prove that the sum is even/);
		assert.equal(editor()?.textContent, draft);
		await act(async () => { deliver.resolve(); await dismissal; });
		assert.match(host.querySelector('[role="alert"]')!.textContent!, /maintenance/);
		assert.match(host.textContent!, /Prove that the sum is even/);
		assert.equal(editor()?.textContent, draft);
		assert.deepEqual(chatStore.getChat(chat.id)!.messages, messages);
	} finally {
		deliver.resolve();
		await act(async () => { await dismissal; root.unmount(); });
	}
});
