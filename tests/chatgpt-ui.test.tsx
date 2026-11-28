import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ModelControl, useModelCatalog, catalogLimits, type ComposerModelSettings } from "../components/model-picker.tsx";
import { useZeroKeys, useStrongKeyless } from "../components/setup-cta.tsx";
import { notifySettingsSaved, onSettingsSaved } from "../components/settings-signal.ts";
import { SidebarProvider } from "../components/sidebar.tsx";
import { ChatGPTConnection, ChatGPTUIProvider } from "../components/settings/chatgpt-connection.tsx";
import { AgentSection } from "../components/settings/agent-section.tsx";
import { GraphCostControl } from "../components/graph-view.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { graphCostSummary as foldGraphCostSummary, type CostSummaryInput } from "../src/core/cost-summary.ts";
const graphCostSummary = (input: CostSummaryInput) => foldGraphCostSummary(input, () => null);
import type { ModelCatalogResponse, ChatGPTStatus, ModelsSettings } from "../src/core/index.ts";
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, localStorage: { getItem: () => null, setItem() {} } });
const originalFetch = globalThis.fetch;
let root: Root | undefined, host: HTMLDivElement | undefined;
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function body(id: string, ready = true): ModelCatalogResponse {
 return { models: ready ? [{ id, name: id, provider: "chatgpt", input: ["text"], contextWindow: 8192, maxTokens: 1024, reasoning: false, supportedLevels: ["off"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] : [], providers: [{ id: "chatgpt", envVar: "", keyPresent: ready }], slots: { strong: { model: { provider: "chatgpt", id: "explicit-pin" } }, cheap: null, vision: null }, defaults: {} } as ModelCatalogResponse;
}
let snapshots: Record<string, { catalog?: ModelCatalogResponse; zero: boolean; strong: boolean }> = {};
function Reader({ id }: { id: string }) {
 const { catalog } = useModelCatalog();
 snapshots[id] = { catalog, zero: useZeroKeys(), strong: useStrongKeyless() };
 return <span data-testid={id}>{catalog ? [...catalogLimits(catalog).keys()].join(",") : "unavailable"}</span>;
}
async function mount(children: React.ReactNode) { host = document.createElement("div"); document.body.append(host); root = createRoot(host); await act(async () => root!.render(<InteractionLayersProvider>{children}</InteractionLayersProvider>)); }
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined; globalThis.fetch = originalFetch; delete window.lh; snapshots = {}; });

test("shared ChatGPT-only readiness admits without API keys; connection invalidation clears every reader and fences old success/error", async () => {
 const requests: ReturnType<typeof deferred<Response>>[] = [];
 globalThis.fetch = async (input) => { assert.equal(input, "/api/models"); const request = deferred<Response>(); requests.push(request); return request.promise; };
 await mount(<><Reader id="first" /><Reader id="second" /></>);
 assert.equal(requests.length, 1);
 await act(async () => requests[0]!.resolve(Response.json(body("A"))));
 for (const value of Object.values(snapshots)) { assert.equal(value.zero, false); assert.equal(value.strong, false); assert.equal(value.catalog?.models[0]?.id, "A"); }
 await act(async () => notifySettingsSaved("models"));
 assert.equal(requests.length, 2);
 await act(async () => notifySettingsSaved("keys"));
 assert.equal(requests.length, 3);
 for (const value of Object.values(snapshots)) assert.equal(value.catalog, undefined);
 await act(async () => requests[2]!.resolve(Response.json(body("B", false))));
 await act(async () => requests[1]!.resolve(Response.json(body("stale-A"))));
 for (const value of Object.values(snapshots)) { assert.equal(value.catalog?.models.length, 0); assert.equal(value.zero, true); assert.equal(value.strong, true); }
 assert(!document.body.textContent?.includes("chatgpt:A"));
});

test("the picker offers Fast only for an advertised ChatGPT tier and saves the opt-in", async () => {
 const model = { provider: "chatgpt", id: "tier-model" };
 const tier: NonNullable<ModelsSettings["strong"]> = { model };
 const models = { strong: tier, cheap: { model }, vision: { model } };
 let supportsFast = true;
 let catalogReads = 0;
 globalThis.fetch = async (input, init) => {
  if (input === "/api/models") {
   catalogReads++;
   const catalog = body(model.id);
   if (supportsFast) catalog.models[0]!.fastServiceTier = "priority";
   return Response.json(catalog);
  }
  if (input === "/api/settings/models" && init?.method === "PUT") {
   const next = JSON.parse(String(init.body));
   assert.deepEqual(next, { strong: { fastMode: true } });
   tier.fastMode = next.strong.fastMode;
  } else {
   assert.equal(input, "/api/settings");
  }
  return Response.json({ settings: { models } });
 };
 const toggle = () => host?.querySelector<HTMLButtonElement>('button[aria-label="Fast Mode"]') ?? null;
 await mount(<><ModelControl /><AgentSection agent={undefined} models={models} graph={undefined} compaction={undefined}
  onModelsChange={() => {}} onSectionChange={() => true} onCompactionChange={() => true} /></>);
 assert.equal(host?.querySelectorAll('button[aria-label$="Fast Mode"]').length, 1);
 assert.equal(toggle()?.getAttribute("aria-pressed"), "false");
 const readsBeforeToggle = catalogReads;
 const savedSections: string[] = [];
 const unsubscribe = onSettingsSaved(section => savedSections.push(section));
 try {
  await act(async () => toggle()!.click());
  assert.deepEqual(savedSections, []);
  assert.equal(catalogReads, readsBeforeToggle);
 } finally {
  unsubscribe();
 }
 assert.equal(tier.fastMode, true);
 assert.equal(toggle()?.getAttribute("aria-pressed"), "true");
 supportsFast = false;
 await act(async () => notifySettingsSaved("keys"));
 assert.equal(toggle(), null);
});

test("a late Strong Fast response cannot replace a newer model read", async () => {
 const first = { provider: "chatgpt", id: "first-model" };
 const second = { provider: "chatgpt", id: "second-model" };
 const put = deferred<Response>();
 const newerRead = deferred<Response>();
 let reads = 0;
 globalThis.fetch = async (input, init) => {
  if (input === "/api/models") {
   const catalog = body(first.id);
   catalog.models[0]!.fastServiceTier = "priority";
   catalog.models.push(body(second.id).models[0]!);
   return Response.json(catalog);
  }
  if (input === "/api/settings/models" && init?.method === "PUT") return put.promise;
  assert.equal(input, "/api/settings");
  return ++reads === 1 ? Response.json({ settings: { models: { strong: { model: first } } } }) : newerRead.promise;
 };
 let selected: string | undefined;
 await mount(<ModelControl onModelChange={(model) => { selected = model; }} />);
 const fast = () => host!.querySelector<HTMLButtonElement>('[aria-label="Fast Mode"]');
 await act(async () => fast()!.click());
 await act(async () => notifySettingsSaved("models"));
 await act(async () => newerRead.resolve(Response.json({ settings: { models: { strong: { model: second } } } })));
 assert.equal(selected, "chatgpt:second-model");
 await act(async () => put.resolve(Response.json({ settings: { models: { strong: { model: first, fastMode: true } } } })));
 assert.equal(selected, "chatgpt:second-model");
 assert.equal(fast(), null);
});

test("toggling Fast keeps a legacy chat on its inherited model", async () => {
 let id = "first-model";
 let settings = {};
 const model = () => ({ provider: "chatgpt", id });
 globalThis.fetch = async (input, init) => {
  if (input === "/api/models") {
   const catalog = body(id);
   catalog.models[0]!.fastServiceTier = "priority";
   return Response.json(catalog);
  }
  if (input === "/api/settings") return Response.json({ settings: { models: { strong: { model: model(), fastMode: true } } } });
  if (input === "/api/chats/legacy") return Response.json({ settings });
  if (input === "/api/chats/legacy/settings" && init?.method === "PUT") {
   settings = JSON.parse(String(init.body));
   return Response.json({ settings });
  }
  throw new Error(`Unexpected request: ${input}`);
 };
 let selected: string | undefined;
 await mount(<ModelControl chatId="legacy" onModelChange={(value) => { selected = value; }} />);
 const toggle = host!.querySelector<HTMLButtonElement>('button[aria-label="Fast Mode"]')!;
 assert.equal(toggle.getAttribute("aria-pressed"), "false");
 await act(async () => toggle.click());
 assert.deepEqual(settings, { fastMode: true });
 assert.equal(toggle.getAttribute("aria-pressed"), "true");
 id = "second-model";
 await act(async () => notifySettingsSaved("models"));
 assert.equal(selected, "chatgpt:second-model");
});

test("the Fast toggle sends only its own field from a stale tab", async () => {
 const model = { provider: "chatgpt", id: "tier-model" };
 const persisted = { model, thinkingLevel: "off", fastMode: true };
 let write: unknown;
 globalThis.fetch = async (input, init) => {
  if (input === "/api/models") {
   const catalog = body(model.id);
   catalog.models[0]!.fastServiceTier = "priority";
   return Response.json(catalog);
  }
  if (input === "/api/settings") return Response.json({ settings: null });
  if (input === "/api/chats/fixture") return Response.json({ settings: { model, thinkingLevel: "high" } });
  if (input === "/api/chats/fixture/settings") {
   write = JSON.parse(String(init?.body));
   return Response.json({ settings: persisted });
  }
  throw new Error(`Unexpected request: ${input}`);
 };
 await mount(<ModelControl chatId="fixture" />);
 const toggle = host!.querySelector<HTMLButtonElement>('button[aria-label="Fast Mode"]')!;
 await act(async () => toggle.click());
 assert.deepEqual(write, { fastMode: true });
 assert.equal(toggle.getAttribute("aria-pressed"), "true");
 assert.match(host!.querySelector('[data-testid="stats-thinking"]')!.textContent ?? "", /off/i);
 await act(async () => window.dispatchEvent(new CustomEvent("lh:kbd-cycle-thinking")));
 assert.deepEqual(write, { model, thinkingLevel: "off" });
});

test("ordinary effort writes can overlap and only Fast writes hold the composer", async () => {
 const model = { provider: "chatgpt", id: "tier-model" };
 const requests: ReturnType<typeof deferred<Response>>[] = [];
 const modelSettingsRef = { current: {} as ComposerModelSettings };
 globalThis.fetch = async (input, init) => {
  if (input === "/api/models") {
   const catalog = body(model.id);
   catalog.models[0]!.fastServiceTier = "priority";
   return Response.json(catalog);
  }
  if (input === "/api/settings/models" && init?.method === "PUT") {
   const request = deferred<Response>();
   requests.push(request);
   return request.promise;
  }
  assert.equal(input, "/api/settings");
  return Response.json({ settings: { models: { strong: { model } } } });
 };
 await mount(<ModelControl modelSettingsRef={modelSettingsRef} />);
 const fast = host!.querySelector<HTMLButtonElement>('button[aria-label="Fast Mode"]')!;
 const effort = host!.querySelector<HTMLButtonElement>('[data-testid="stats-thinking"]')!;
 const cycleEffort = () => window.dispatchEvent(new CustomEvent("lh:kbd-cycle-thinking"));

 await act(async () => { cycleEffort(); cycleEffort(); });
 assert.equal(requests.length, 2);
 assert.equal(effort.disabled, false);
 assert.equal(fast.disabled, true);
 assert.equal(modelSettingsRef.current.pendingSave, undefined);
 await act(async () => requests[0]!.resolve(new Response(null, { status: 503 })));
 assert.equal(fast.disabled, true);
 await act(async () => requests[1]!.resolve(new Response(null, { status: 503 })));
 assert.equal(fast.disabled, false);
 assert.equal(Boolean(host!.querySelector('[role="alert"]')), false, "a closed menu keeps ordinary effort errors hidden");

 await act(async () => { fast.click(); cycleEffort(); });
 assert.equal(requests.length, 4);
 assert.equal(effort.disabled, false);
 assert.equal(host!.querySelector<HTMLButtonElement>('[data-testid="stats-model"]')?.disabled, false);
 const pendingFast = modelSettingsRef.current.pendingSave;
 assert.ok(pendingFast);
 await act(async () => requests[3]!.resolve(new Response(null, { status: 503 })));
 assert.equal(modelSettingsRef.current.pendingSave, pendingFast);
 assert.equal(Boolean(host!.querySelector('[role="alert"]')), false);
 await act(async () => requests[2]!.resolve(new Response(null, { status: 503 })));
 assert.equal(await pendingFast, false);
 assert.equal(modelSettingsRef.current.pendingSave, undefined);
 assert.equal(fast.disabled, false);
 assert.equal(host!.querySelector('[role="alert"]')?.textContent, "settings rejected (503)");
});

test("plan plus unknown graph rows keep the existing unknown suffix without fabricating API dollars", async () => {
 const step = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
 const plan = { model: "chatgpt:gpt-5", steps: [step] };
 const unknown = { model: "unknown:missing", steps: [step] };
 const costs = graphCostSummary({ chats: [{ title: "Scratch", extractions: [{ startedAt: 1, at: "2026-10-24T00:00:00Z", durationMs: 1, stages: { extractor: plan, auditor: unknown } }, { startedAt: 2, at: "2026-10-24T00:00:00Z", durationMs: 1, stages: { extractor: unknown, auditor: plan } }] }], sources: [] });
 await mount(<GraphCostControl costs={costs} />);
 await act(async () => { document.querySelector("button")!.click(); });
 const recent = [...document.querySelectorAll(".border-t .shrink-0.tabular-nums")];
 assert.equal(recent.length, 2);
 for (const row of recent) assert.equal(row.textContent, "ChatGPT +1 unpriced", "both recent two-stage runs disclose their unknown stage");
 assert.equal((document.body.textContent?.match(/\+1 unpriced/g) ?? []).length, 4, "both mixed stage rows also retain their unknown suffix");
 assert(!document.body.textContent?.includes("$0.00"));
});

test("root-lifetime safe bridge publishes with Connections unmounted; commands/panel pushes do not duplicate global signals", async () => {
 let pushes: (() => void)[] = [], subscriptions = 0, unsubscriptions = 0, fetches = 0;
 const safe: ChatGPTStatus = { available: true, pending: false, allowBackgroundUse: false, activeId: "a", accounts: [{ id: "a", email: "dummy@example.invalid", registration: "oaiapp_dummy", connected: true, planEnabled: true }], error: null };
 window.lh = { expandWindow() {}, chatgpt: { status: async () => safe, login: async () => safe, cancel: async () => safe, select: async () => safe, disconnect: async () => safe, logout: async () => safe, consent: async () => safe, onChange: (cb) => { subscriptions++; pushes.push(cb); return () => { unsubscriptions++; pushes = pushes.filter((c) => c !== cb); }; } } };
 globalThis.fetch = async (input) => { assert.equal(input, "/api/models"); fetches++; return Response.json(body(`model-${fetches}`)); };
 await mount(<SidebarProvider><Reader id="root" /></SidebarProvider>);
 assert.equal(subscriptions, 1);
 const before = fetches;
 await act(async () => { for (const callback of pushes) callback(); });
 assert.equal(fetches, before + 1);
 await act(async () => root!.render(<InteractionLayersProvider><SidebarProvider><Reader id="root" /><ChatGPTUIProvider><ChatGPTConnection /></ChatGPTUIProvider></SidebarProvider></InteractionLayersProvider>));
 assert.equal(subscriptions, 2);
 const mounted = fetches;
 await act(async () => { for (const callback of pushes) callback(); });
 assert.equal(fetches, mounted + 1, "one global publisher even when panel also reads pushed status");
 await act(async () => root!.render(<InteractionLayersProvider><SidebarProvider><Reader id="root" /></SidebarProvider></InteractionLayersProvider>));
 assert.equal(unsubscriptions, 1);
 await act(async () => { for (const callback of pushes) callback(); });
 assert.equal(fetches, mounted + 2);
});
