"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { ChatSettings, ModelCatalogEntry, ModelCatalogResponse, ModelsSettings, UserSettings } from "@/src/core";
import { resolveConversationSpec, resolveSlot } from "@/src/core";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { prettyModel } from "@/components/usage-format";
import { ModelMenuList, ThinkingMenuList } from "@/components/settings/model-menu";
import { composeSlotModel } from "@/components/settings/agent-section";
import { MenuShell } from "@/components/menu-shell";
import { useInteractionLayers } from "@/components/interaction-layers";
import { isInputShortcutScopeEligible } from "@/components/plugin-input-focus";
import { ModelPickerPill } from "@/components/model-picker-pill";
import { Hint } from "@/components/ui/hint";
import { notifySettingsSaved, useSettingsSaved } from "@/components/settings-signal";
import { useModelCatalog } from "@/components/model-catalog";
export { useModelCatalog } from "@/components/model-catalog";
import { defaultOrderLevel, populateLevel, THINKING_LABEL } from "@/components/thinking-default";

export interface ComposerModelSettings {
	pendingSave?: Promise<boolean>;
}

export const strongFastSaveRef: RefObject<ComposerModelSettings> = { current: {} };

export function waitForFastSave(settings: ComposerModelSettings, pending = settings.pendingSave): Promise<boolean> | undefined {
	return pending?.then(saved => saved && (settings.pendingSave ?? true));
}

/** provider:id → known contextWindow over the cached catalog, mirroring
 * the server's catalogContextLimits join. CLI aliases have no global
 * denominator: the stats bar uses that session's actual CLI report instead.
 * Missing limits always render usage-only, without a hardcoded fallback. */
export function catalogLimits(catalog: Pick<ModelCatalogResponse, "models">): Map<string, number> {
	return new Map(catalog.models.flatMap((m) => m.contextWindow === null ? [] : [[`${m.provider}:${m.id}`, m.contextWindow] as const]));
}

/**
 * With a chatId, bind the session record and use resolveConversationSpec
 * so the picker and engine agree about inherited settings. Without a
 * chatId, bind the raw Strong slot used when creating sessions.
 */
export function ModelControl({ chatId, onModelChange, modelSettingsRef }: {
	chatId?: string;
	onModelChange?: (model: string | undefined) => void;
	modelSettingsRef?: RefObject<ComposerModelSettings>;
}) {
	const { catalog, refresh } = useModelCatalog();
	const [models, setModels] = useState<ModelsSettings | undefined>();
	// A successful read with no settings is a legacy session; undefined
	// means no session record is known yet, not permission to inherit Strong.
	const [session, setSession] = useState<{ settings?: ChatSettings }>();
	const [open, setOpen] = useState<"model" | "thinking" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [fastError, setFastError] = useState<string | null>(null);
	const [fastRefreshFailed, setFastRefreshFailed] = useState(false);
	const [savingFast, setSavingFast] = useState(false);
	const [savingModel, setSavingModel] = useState(false);
	const modelSavesInFlight = useRef(0);
	const fastNeedsRefresh = useRef(false);
	const localModelSettings = useRef<ComposerModelSettings>({});
	const saveState = modelSettingsRef ?? localModelSettings;
	const sessionRead = useRef(0);
	const modelsRead = useRef(0);
	const containerRef = useRef<HTMLDivElement>(null);
	const interactions = useInteractionLayers();
	const canConfirmFast = useCallback(() => (
		fastNeedsRefresh.current && !saveState.current.pendingSave && modelSavesInFlight.current === 0
	), [saveState]);
	const finishFastRefresh = useCallback((confirmed: boolean) => {
		if (!canConfirmFast()) return;
		setFastRefreshFailed(!confirmed);
		if (confirmed) {
			fastNeedsRefresh.current = false;
			setSavingFast(false);
		}
	}, [canConfirmFast]);
	const readSession = useCallback(() => {
		if (!chatId) return;
		const read = ++sessionRead.current;
		const confirmingFast = canConfirmFast();
		if (confirmingFast) setFastRefreshFailed(false);
		fetch(`/api/chats/${chatId}`)
			.then((r) => { if (!r.ok) throw new Error(`session read failed: ${r.status}`); return r.json() as Promise<{ settings?: ChatSettings }>; })
			.then((body) => {
				if (read !== sessionRead.current) return;
				setSession({ settings: body.settings });
				if (confirmingFast) finishFastRefresh(true);
			})
			.catch(() => {
				if (confirmingFast && read === sessionRead.current) finishFastRefresh(false);
			});
	}, [chatId, canConfirmFast, finishFastRefresh]);
	const readModels = useCallback(() => {
		const read = ++modelsRead.current;
		const confirmingFast = !chatId && canConfirmFast();
		if (confirmingFast) setFastRefreshFailed(false);
		fetch("/api/settings")
			.then((r) => { if (!r.ok) throw new Error(`models read failed: ${r.status}`); return r.json() as Promise<{ settings: { models?: ModelsSettings } | null }>; })
			.then((body) => {
				if (read !== modelsRead.current) return;
				setModels(body.settings?.models);
				if (confirmingFast) finishFastRefresh(true);
			})
			.catch(() => {
				if (confirmingFast && read === modelsRead.current) finishFastRefresh(false);
			});
	}, [chatId, canConfirmFast, finishFastRefresh]);
	const readFastSettings = chatId ? readSession : readModels;

	// The record read — BOTH mount and the cross-surface signal land
	// here (fix wave: another surface's models write re-reads into the
	// pill live; own writes also notify, and the refetch is idempotent).
	// Dual-bound: chat mode reads BOTH the session record (the source of
	// truth) and the models section (the display fallback for a legacy
	// unstamped session — exactly what the engine resolves); draft mode
	// reads the models section alone.
	const readRecord = useCallback(() => {
		readSession();
		readModels();
	}, [readSession, readModels]);

	useEffect(() => {
		let active = true;
		const pendingStrongSave = chatId ? undefined : saveState.current.pendingSave;
		if (pendingStrongSave) fastNeedsRefresh.current = true;
		if (!chatId) setSavingFast(fastNeedsRefresh.current);
		readRecord();
		if (pendingStrongSave) void pendingStrongSave.then(() => {
			if (active && canConfirmFast()) readModels();
		});
		return () => {
			active = false;
			++sessionRead.current;
			++modelsRead.current;
		};
	}, [chatId, canConfirmFast, readModels, readRecord, saveState]);

	useSettingsSaved((section) => {
		if (section === "models") readRecord();
	});

	// Dual-bound truth: chat mode displays the session's own record,
	// falling back to Strong only for a successfully read legacy unstamped
	// session — EXACTLY what resolveConversationSpec runs. An unresolved or
	// failed record read must not report a provisional global preference as
	// this session's identity (including to the Send guard). Draft mode is
	// the strong slot itself.
	const strong = models?.strong;
	const conversation = session && resolveConversationSpec(session.settings, resolveSlot(strong));
	const override: ChatSettings | undefined = chatId
		? conversation ? {
				model: { provider: conversation.provider, id: conversation.id },
				thinkingLevel: conversation.thinkingLevel,
				fastMode: conversation.fastMode,
			} : undefined
		: strong;
	const effectiveId = override?.model?.id;
	const effectiveProvider = override?.model?.provider;
	useEffect(() => {
		onModelChange?.(effectiveProvider && effectiveId ? `${effectiveProvider}:${effectiveId}` : undefined);
	}, [effectiveProvider, effectiveId, onModelChange]);
	const storedLevel = override?.thinkingLevel;
	const entry = catalog?.models.find(
		(m) => m.id === effectiveId && m.provider === effectiveProvider,
	);
	const fastAvailable = entry?.provider === "chatgpt" && entry.fastServiceTier === "priority";
	const levels = entry?.supportedLevels ?? [];
	// Legacy display (chunk 2 item 4, owner): a record with a model but no
	// stored level shows the RESOLVED level — the ordering's first supported
	// — because that is exactly what the engine build would run. Display-
	// only: the record stays unset until a fresh pick populates it.
	const effectiveLevel = storedLevel ?? (entry ? defaultOrderLevel(levels) : undefined);

	// The intuitive dropdown contract (owner, stats-control round 1): any
	// click outside the open menu — or an Esc keypress — closes it. The
	// menu's own surface keeps it open: the toggle buttons live inside the
	// container, and the menu BODY lives in a portal on document.body
	// (MenuShell) — never a container descendant, so its rows are carved
	// out via [data-lh-menu] (the settings sections' discipline; without
	// it a row's pointerdown counts as outside and eats the pick —
	// live-caught in the fix wave, broken since the MenuShell migration).
	useEffect(() => {
		if (open === null) return;
		const onPointerDown = (e: PointerEvent) => {
			const popup = interactions.getTopLayer();
			if (popup?.kind !== "popup" || !containerRef.current?.contains(popup.anchorRef?.current ?? null) || !interactions.isElementEligible(popup.rootRef.current)) return;
			const t = e.target as Element;
			if (t instanceof Element && t.closest("[data-lh-menu]")) return;
			if (containerRef.current && !containerRef.current.contains(t)) {
				setOpen(null);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
		};
	}, [open, interactions]);

	// One write seam: composeSlotModel preserves the cheap/vision siblings
	// (replace-whole-section discipline) and the per-field independence of
	// model + thinkingLevel within the strong slot.
	const save = useCallback(
		async (next: ModelsSettings, changingFast: boolean) => {
			const readAtStart = modelsRead.current;
			const setSaveError = changingFast ? setFastError : setError;
			setSaveError(null);
			try {
				const res = await fetch("/api/settings/models", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(next),
				});
				if (!res.ok) {
					const body = (await res.json().catch(() => ({}))) as { error?: string };
					setSaveError(body.error ?? `settings rejected (${res.status})`);
					return false;
				}
				// Server truth, never the request body (fix wave): a pick
				// that rides an unsupported level lands CLAMPED in the record
				// — the pill must show the stored value in this interaction.
				const { settings } = await res.json() as { settings: UserSettings };
				if (!changingFast || modelsRead.current === readAtStart) {
					++modelsRead.current;
					setModels(settings.models);
				} else fastNeedsRefresh.current = true;
				if (!changingFast) {
					setOpen(null);
					notifySettingsSaved("models");
				}
				return true;
			} catch {
				setSaveError("Could not reach the server — try again.");
				return false;
			}
		},
		[],
	);

	// The session write seam (chat mode): PUT the per-chat settings route
	// — validated + level-clamped server-side; the response is the stored
	// truth (a pick riding an unsupported level lands CLAMPED — the pill
	// shows the stored value). No notifySettingsSaved: the write touches
	// one session's record, not the slots — no other surface reads it.
	const saveChat = useCallback(
		async (next: ChatSettings, changingFast: boolean) => {
			const setSaveError = changingFast ? setFastError : setError;
			setSaveError(null);
			try {
				const res = await fetch(`/api/chats/${chatId}/settings`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(next),
				});
				if (!res.ok) {
					const body = (await res.json().catch(() => ({}))) as { error?: string };
					setSaveError(body.error ?? `settings rejected (${res.status})`);
					return false;
				}
				const { settings } = await res.json() as { settings: ChatSettings };
				if (!changingFast || !fastNeedsRefresh.current) {
					++sessionRead.current;
					setSession({ settings });
				}
				if (!changingFast) setOpen(null);
				return true;
			} catch {
				setSaveError("Could not reach the server — try again.");
				return false;
			}
		},
		[chatId],
	);

	// One apply seam over both write paths: a pick names provider + id +
	// level; chat mode writes the session's own record,
	// draft mode composes the strong slot (siblings preserved,
	// replace-whole-section discipline).
	const apply = useCallback(
		(provider: string, id: string, level: ThinkingLevel | undefined, fastMode?: boolean) => {
			const changingFast = fastMode !== undefined;
			if (changingFast && (saveState.current.pendingSave || modelSavesInFlight.current > 0 || fastNeedsRefresh.current)) return;
			if (changingFast) setSavingFast(true);
			else {
				if (chatId && saveState.current.pendingSave) fastNeedsRefresh.current = true;
				modelSavesInFlight.current++;
				setSavingModel(true);
			}
			let pendingSave: Promise<boolean>;
			if (chatId) {
				pendingSave = saveChat(changingFast
					? { fastMode }
					: { model: { provider, id }, thinkingLevel: level }, changingFast);
			} else {
				pendingSave = save(changingFast
					? { strong: { fastMode } }
					: composeSlotModel(models, "strong", provider, id, level ?? ""), changingFast);
			}
			const settled = pendingSave.finally(() => {
				if (changingFast) {
					saveState.current.pendingSave = undefined;
					if (!fastNeedsRefresh.current) setSavingFast(false);
				} else if (--modelSavesInFlight.current === 0) {
					setSavingModel(false);
				}
				if (containerRef.current && canConfirmFast()) readFastSettings();
			});
			if (changingFast) saveState.current.pendingSave = settled;
		},
		[chatId, models, canConfirmFast, readFastSettings, save, saveChat, saveState],
	);

	// Shortcut seams (keyboard wave A): ⌘K opens the model menu (the
	// universal command convention); Shift+Tab cycles the thinking level
	// up the ladder (wrapping) — the owner's replacement for browser
	// tab-focus. Both work from any focus, including mid-typing.
	useEffect(() => {
		const onOpenPicker = () => {
			if (!isInputShortcutScopeEligible(containerRef.current, interactions)) return;
			setOpen("model");
			setError(null);
			refresh(); // mid-session key changes widen the menu (cache fix)
		};
		window.addEventListener("lh:kbd-open-model-picker", onOpenPicker);
		return () => window.removeEventListener("lh:kbd-open-model-picker", onOpenPicker);
	}, [refresh, interactions]);

	useEffect(() => {
		const onCycleThinking = () => {
			if (!isInputShortcutScopeEligible(containerRef.current, interactions)) return;
			if (levels.length === 0) return;
			const idx = effectiveLevel === undefined ? -1 : levels.indexOf(effectiveLevel);
			const next = levels[(idx + 1) % levels.length];
			if (next === undefined) return;
			apply(effectiveProvider ?? "", effectiveId ?? "", next);
		};
		window.addEventListener("lh:kbd-cycle-thinking", onCycleThinking);
		return () => window.removeEventListener("lh:kbd-cycle-thinking", onCycleThinking);
	}, [levels, effectiveLevel, effectiveProvider, effectiveId, apply, interactions]);

	// Selecting a model (click and Enter share one path): keep the
	// thinking level only when the new model supports it — otherwise
	// drop it (a carry-over would 400 at the server's catalog gate).
	const pickModel = (m: ModelCatalogEntry) => {
		// Auto-populate (chunk 2, owner: "populate everywhere"): a fresh pick
		// ALWAYS writes a level — the STORED one rides as-is (the write clamps
		// server-side when the new model doesn't support it; the signal
		// re-reads and the clamped truth displays), and a record with no
		// stored level populates the ordering's level. The unset state can
		// never re-enter through this door. (The DERIVED display level never
		// rides — it belongs to the OLD model; the fresh pick's level comes
		// from the fresh model's own ladder.)
		const nextLevel = populateLevel(storedLevel, m.supportedLevels);
		apply(m.provider, m.id, nextLevel);
	};

	// Stale-while-revalidate on manual open too (⌘K covers the keyboard
	// path above): the cached list shows instantly, the fresh federation
	// swaps in when it lands.
	const openMenu = (kind: "model" | "thinking") => {
		setOpen((o) => (o === kind ? null : kind));
		setError(null);
		if (kind === "model") refresh();
	};
	const fastMode = fastAvailable ? {
		checked: override?.fastMode === true,
		disabled: savingFast || savingModel,
		onToggle: () => {
			setOpen(null);
			apply(entry.provider, entry.id, storedLevel, override?.fastMode !== true);
		},
	} : undefined;
	const fastFeedback = (fastError || fastRefreshFailed) && <>
		{fastError && <div>{fastError}</div>}
		{fastRefreshFailed && <div>Could not confirm Fast Mode.</div>}
	</>;

	return (
		<div
			ref={containerRef}
			className="relative flex min-w-0 items-center gap-1.5 narrow:max-w-1/2"
			data-testid="model-control"
		>
			<Hint
				label={effectiveId ? `${effectiveProvider ? `${effectiveProvider}:` : ""}${effectiveId}` : "Model selector"}
				action="open-model-picker"
				side="bottom"
			>
				<ModelPickerPill
					data-testid="stats-model"
					className="min-w-0 [&>span:first-child]:min-w-0 [&>span:first-child]:truncate narrow:min-h-11 narrow:min-w-11"
					onClick={() => openMenu("model")}
					aria-expanded={open === "model"}
				>{effectiveId ? prettyModel(effectiveId) : "—"}</ModelPickerPill>
			</Hint>
			<Hint
				// "Thinking" + its real shortcut via the registry (owner interlude
				// 2026-09-25): ⇧⇥ cycles the level, so "Thinking (⇧⇥)" —
				// rebind-live like every Hint suffix.
				label="Thinking"
				action="cycle-thinking"
				side="bottom"
			>
				<ModelPickerPill
					data-testid="stats-thinking"
					className="shrink-0 narrow:min-h-11 narrow:min-w-11"
					onClick={() => {
						if (entry === undefined) return;
						openMenu("thinking");
					}}
					aria-expanded={open === "thinking"}
				>{effectiveLevel === undefined ? "—" : (THINKING_LABEL[effectiveLevel] ?? effectiveLevel)}</ModelPickerPill>
			</Hint>

			{open === null && fastFeedback && <div role="alert" className="absolute right-0 bottom-full mb-1 w-max max-w-[calc(100vw-3rem)] rounded-md border bg-card p-2 text-xs text-destructive">{fastFeedback}</div>}

			{/* The shared dropdown body (extracted 2026-09-20): the agent
			    settings' slot selects and the setup dialog use the exact same
			    one. */}
			{open === "model" && (
				<MenuShell
					anchorRef={containerRef}
					testid="model-menu" onClose={() => { setOpen(null); return "closed"; }}
					preferredSide="up"
					menuClass="flex w-[22rem] flex-col rounded-xl border bg-card p-2 text-xs shadow-xl narrow:max-w-[calc(100vw-3rem)]"
				>
					{fastFeedback && <div role="alert" className="mb-1.5 text-destructive">{fastFeedback}</div>}
					{error && <div className="mb-1.5 text-destructive">{error}</div>}
					<ModelMenuList
						models={catalog?.models}
						effectiveId={effectiveId}
						effectiveProvider={effectiveProvider}
						onPick={pickModel}
						fastMode={fastMode}
						footer={
							catalog && catalog.models.length === 0
								? "No models — add a provider key in Keys"
								: chatId
									? "This session's model"
									: "Strong tier — the default for new sessions"
						}
					/>
				</MenuShell>
			)}

			{open === "thinking" && (
				<MenuShell
					anchorRef={containerRef}
					testid="thinking-menu" onClose={() => { setOpen(null); return "closed"; }}
					preferredSide="up"
					menuClass="flex w-44 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl"
				>
					<ThinkingMenuList
						levels={catalog ? levels : []}
						effectiveLevel={effectiveLevel}
						onPick={(level) => apply(effectiveProvider ?? "", effectiveId ?? "", level as ThinkingLevel)}
						empty={catalog ? (effectiveId ? `${prettyModel(effectiveId)} has no thinking levels.` : "Pick a model first.") : "Loading…"}
						footer="Levels this model actually supports"
					/>
					{fastFeedback && <div role="alert" className="mt-1 text-destructive">{fastFeedback}</div>}
					{error && <div className="mt-1 text-destructive">{error}</div>}
				</MenuShell>
			)}
		</div>
	);
}
