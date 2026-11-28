import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import test from "node:test";
import { Chat } from "../components/chat.tsx";
import { KeyboardShortcuts } from "../components/keyboard-shortcuts.tsx";
import { useInteractionLayers, type InteractionLayersController } from "../components/interaction-layers.tsx";
import { notifySettingsSaved } from "../components/settings-signal.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { mountPluginChrome } from "./helpers/plugin-chrome.tsx";

// Exercise Chat -> DockOverlay -> QuestionDock, not a test-authored notification bridge.
for (const thinking of [false, true]) for (const overflow of [false, true]) test(`production Chat isolates ${thinking ? "thinking" : "answer"} edits with fresh ${overflow ? "overflow" : "inline"} and shortcut actions`, async () => {
  let ownerRenders = 0, controller!: InteractionLayersController;
  // Count the actual component function without replacing its hooks or children.
  const TrackedChat = new Proxy(Chat, { apply(target, self, args) { ownerRenders++; return Reflect.apply(target, self, args); } });
  const messages: LhMessage[] = [{
    id: "question", role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture", timestamp: 1,
    stopReason: "toolUse", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    content: [{ type: "text", text: "Unchanged synthetic lesson." }, { type: "toolCall", id: "pending", name: thinking ? "quiz" : "explain", arguments: thinking
      ? { type: "predict", question: "Choose the result", options: [{ label: "One", value: "one" }, { label: "Two", value: "two" }], correctAnswer: "one", explanation: "Fixture" }
      : { question: "Explain the result", correctAnswer: "Fixture" } }],
  }];
  function Session() {
    controller = useInteractionLayers();
    return <><KeyboardShortcuts /><TrackedChat chatId="one" title="Synthetic lesson" initialMessages={messages} /></>;
  }
  const savedObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  // Fixed geometry: draft edits must not simulate legitimate dock-height updates.
  Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
  const captured: { placement: string; text: string }[] = [];
  let fixture: Awaited<ReturnType<typeof mountPluginChrome>> | undefined;
  try {
    fixture = await mountPluginChrome({ activate(ctx) {
      ctx.registerAction({ id: "draft", name: "Read draft", shortcut: { scope: { sessions: ["teaching"] }, defaultBinding: "mod+shift+d" }, disabled(context) {
        if (context.surface !== "session" || context.view.input.type !== "answer") return true;
        return !(thinking ? context.view.input.draft.thinking : context.view.input.draft.text).trim();
      }, run(context) {
        if (context.surface === "session" && context.view.input.type === "answer") captured.push({ placement: context.placement, text: thinking ? context.view.input.draft.thinking : context.view.input.draft.text });
      } });
      ctx.placeAction({ id: "draft", actionId: "draft", location: "top-bar", sessions: ["teaching"] });
    } }, <Session />, {
      strictMode: true, pathname: "/chat/one", prepareDom(dom) {
        const prototype = dom.window.HTMLElement.prototype;
        const saved = [
          [dom.window, "location"], [dom.window, "localStorage"], [prototype, "getAnimations"], [prototype, "offsetWidth"],
        ].map(([object, key]) => ({ object: object as object, key: key as string, descriptor: Object.getOwnPropertyDescriptor(object, key as string) }));
        const values = new Map<string, string>();
        Object.defineProperty(dom.window, "location", { configurable: true, value: new URL("http://fixture/chat/one") });
        Object.defineProperty(dom.window, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
        Object.defineProperty(prototype, "getAnimations", { configurable: true, value: () => [] });
        Object.defineProperty(prototype, "offsetWidth", { configurable: true, get() { return this.clientWidth; } });
        return () => { for (const { object, key, descriptor } of saved) { if (descriptor) Object.defineProperty(object, key, descriptor); else Reflect.deleteProperty(object, key); } };
      }, fetch: async input => {
        const url = String(input);
        if (url === "/api/models") return Response.json({ providers: [], models: [], slots: {} });
        if (url === "/api/settings") return Response.json({});
        if (url === "/api/chats/one") return Response.json({ id: "one", messages });
        if (url === "/api/chats/one/side-chats") return Response.json({ threads: [] });
        if (url === "/api/jobs?chatId=one") return Response.json({ jobs: [], turnInFlight: false });
        assert.fail(`Unexpected fixture request: ${url}`);
      },
    });
    const mounted = fixture;
    const editor = () => mounted.document.querySelector<HTMLElement>(`[data-testid="${thinking ? "thinking" : "answer"}-field"] [data-file-path-input]`)!;
    assert.ok(editor(), "production dock must expose the real field");
    await mounted.resize(overflow ? 120 : 2400);
    if (overflow) await mounted.click(mounted.document.querySelector<HTMLElement>('[aria-label="More plugin actions"]')!);
    const button = () => mounted.document.querySelector<HTMLButtonElement>('[data-plugin-action="fixture/draft"]')!;
    assert.equal(button().closest('[role="menu"]') !== null, overflow);
    assert.equal(button().disabled, true);
    const baseline = ownerRenders;
    const type = async (value: string) => { await act(async () => { editor().textContent = value; editor().dispatchEvent(new window.Event("input", { bubbles: true })); }); };
    for (let i = 1; i <= 12; i++) await type("a".repeat(i));
    assert.equal(button().disabled, false);
    await type(""); assert.equal(button().disabled, true);
    await type("latest draft"); assert.equal(button().disabled, false);
    assert.equal(ownerRenders, baseline, "draft notification must not invalidate production Chat");
    await mounted.click(button());
    await type("shortcut draft");
    const key = new window.Event("keydown", { bubbles: true, cancelable: true });
    Object.assign(key, { key: "d", code: "KeyD", metaKey: true, shiftKey: true });
    await act(async () => { controller.captureKeyDown(key as KeyboardEvent); mounted.document.body.dispatchEvent(key); });
    assert.equal(key.defaultPrevented, true);
    assert.deepEqual(captured, [{ placement: "top-bar", text: "latest draft" }, { placement: "keyboard", text: "shortcut draft" }]);
    await mounted.render(null);
    assert.equal(mounted.owner.manager.shortcutPageContext(), undefined, "departed Chat must release its shortcut reader");
    await mounted.render(<Session />);
    assert.equal(editor().textContent, "", "re-entry must not retain the departed form's draft");
    const context = mounted.owner.manager.shortcutPageContext();
    assert.equal(context?.surface, "session");
    if (context?.surface === "session") { assert.equal(context.view.input.type, "answer"); if (context.view.input.type === "answer") assert.equal(thinking ? context.view.input.draft.thinking : context.view.input.draft.text, ""); }
  } finally {
    await fixture?.close();
    if (savedObserver) Object.defineProperty(globalThis, "ResizeObserver", savedObserver); else Reflect.deleteProperty(globalThis, "ResizeObserver");
  }
});

test("a steer fallback without a Fast save survives a model change", async () => {
  const stream = Promise.withResolvers<Response>();
  const steer = Promise.withResolvers<Response>();
  const posts: string[] = [];
  const first = { provider: "fixture", id: "first-model" };
  const second = { provider: "fixture", id: "second-model" };
  let model = first;
  const savedObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
  let mounted: Awaited<ReturnType<typeof mountPluginChrome>> | undefined;
  try {
    mounted = await mountPluginChrome({ activate() {} }, <Chat chatId="one" title="Steer fallback" initialMessages={[]} initialConfigured />, {
      pathname: "/chat/one",
      prepareDom({ window }) {
        const prototype = window.HTMLElement.prototype;
        const properties = [
          [window, "location", { value: new URL("http://fixture/chat/one") }],
          [window, "localStorage", { value: { getItem: () => null, setItem() {} } }],
          [prototype, "getAnimations", { value: () => [] }],
          [prototype, "offsetWidth", { get(this: HTMLElement) { return this.clientWidth; } }],
        ] as const;
        const saved = properties.map(([object, key]) => Object.getOwnPropertyDescriptor(object, key));
        properties.forEach(([object, key, descriptor]) => Object.defineProperty(object, key, { configurable: true, ...descriptor }));
        return () => properties.forEach(([object, key], idx) => {
          if (saved[idx]) Object.defineProperty(object, key, saved[idx]!);
          else Reflect.deleteProperty(object, key);
        });
      },
      fetch: async (input, init) => {
        const url = String(input);
        if (url === "/api/models") return Response.json({
          providers: [{ id: model.provider, keyPresent: true }],
          models: [first, second].map(entry => ({ ...entry, name: entry.id, supportedLevels: ["off"], input: ["text"] })),
          slots: { strong: { model }, cheap: { model }, vision: { model } },
        });
        if (url === "/api/settings") return Response.json({});
        if (url === "/api/chats/one") return Response.json({ id: "one", messages: [], settings: { model }, turnInFlight: false });
        if (url === "/api/chats/one/side-chats") return Response.json({ threads: [] });
        if (url === "/api/jobs?chatId=one") return Response.json({ jobs: [], turnInFlight: false });
        if (url === "/api/chats/one/steer") {
          posts.push(JSON.parse(String(init?.body)).input.text);
          return steer.promise;
        }
        if (url === "/api/chat") {
          posts.push(JSON.parse(String(init?.body)).input.text);
          return Response.json({ accepted: true });
        }
        if (url === "/api/chats/one/stream") return posts.length === 1 ? stream.promise : new Response("data: [DONE]\n\n");
        assert.fail(`Unexpected fixture request: ${url}`);
      },
    });
    const doc = mounted.document;
    const submit = async (text: string) => {
      const form = doc.querySelector('[data-testid="composer"]')!;
      const editor = form.querySelector<HTMLElement>("[contenteditable]")!;
      await act(async () => {
        editor.textContent = text;
        editor.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
      await act(async () => form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
    };
    await submit("Start the turn");
    assert.deepEqual(posts, ["Start the turn"]);
    await submit("Steer this turn");
    assert.deepEqual(posts, ["Start the turn", "Steer this turn"]);
    model = second;
    await act(async () => notifySettingsSaved("models"));
    assert.match(doc.querySelector('[data-testid="stats-model"]')?.textContent ?? "", /second-model/);
    await act(async () => stream.resolve(new Response("data: [DONE]\n\n")));
    await act(async () => steer.resolve(new Response(null, { status: 409 })));
    assert.deepEqual(posts, ["Start the turn", "Steer this turn", "Steer this turn"]);
  } finally {
    await act(async () => { stream.resolve(new Response("data: [DONE]\n\n")); steer.resolve(new Response(null, { status: 400 })); });
    await mounted?.close();
    if (savedObserver) Object.defineProperty(globalThis, "ResizeObserver", savedObserver); else Reflect.deleteProperty(globalThis, "ResizeObserver");
  }
});
