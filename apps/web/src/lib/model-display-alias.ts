/**
 * Display-only model aliases (占位模型).
 *
 * Some marketplace models are shown under a newer display name while they run
 * on an existing backend model. GPT-5.6 is such a placeholder: it has no model
 * of its own and runs on the real `gpt-5.5`. Both a "GPT-5.5" and a "GPT-5.6"
 * card are shown, and picking either resolves to the same backend model.
 *
 * Because the backend cannot tell the two apart (they share one model id), the
 * user's *display* choice is remembered on the client and shared across every
 * page that shows or switches the current model (龙虾窝 / 问答 / 模型广场).
 *
 * Retire a placeholder by deleting its entry from MODEL_DISPLAY_ALIASES.
 */

export interface ModelDisplayAlias {
  /** Synthetic id used only in the UI, e.g. `link/gpt-5.6`. */
  displayId: string;
  /** Bare label shown to the user, e.g. `GPT-5.6`. */
  displayName: string;
  /** Bare id (no `link/` scope) of the real backend model, e.g. `gpt-5.5`. */
  backingBareId: string;
}

export const MODEL_DISPLAY_ALIASES: readonly ModelDisplayAlias[] = [
  {
    displayId: "link/gpt-5.6",
    displayName: "GPT-5.6",
    backingBareId: "gpt-5.5",
  },
];

const PREFERENCE_STORAGE_KEY = "claw-pi.model.displayAlias.v1";
const PREFERENCE_EVENT = "claw-pi:model-display-alias";

/** Strip a leading `link/` (or `link-openai/`) scope to compare bare ids. */
function toBareId(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash >= 0 ? modelId.slice(slash + 1) : modelId;
}

/** Find the alias whose backing model matches `modelId` (scoped or bare). */
function findAliasByBacking(modelId: string): ModelDisplayAlias | undefined {
  const bare = toBareId(modelId);
  return MODEL_DISPLAY_ALIASES.find((alias) => alias.backingBareId === bare);
}

/** Find the alias matching a synthetic display id (scoped or bare). */
function findAliasByDisplayId(modelId: string): ModelDisplayAlias | undefined {
  const bare = toBareId(modelId);
  return MODEL_DISPLAY_ALIASES.find(
    (alias) =>
      alias.displayId === modelId || toBareId(alias.displayId) === bare,
  );
}

/** True when `modelId` is a synthetic placeholder display id. */
export function isAliasDisplayId(modelId: string): boolean {
  return findAliasByDisplayId(modelId) !== undefined;
}

// ---------------------------------------------------------------------------
// Client-side preference: which display identity the user last picked for a
// given backing model. Maps backing bare id -> chosen display id.
// ---------------------------------------------------------------------------

type AliasPreference = Record<string, string>;

function readPreference(): AliasPreference {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(PREFERENCE_STORAGE_KEY) ?? "null",
    );
    if (!parsed || typeof parsed !== "object") return {};
    const result: AliasPreference = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

function writePreference(next: AliasPreference): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(PREFERENCE_STORAGE_KEY, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent(PREFERENCE_EVENT));
}

/**
 * Record which display identity the user picked. The preference maps a backing
 * bare id to the display id the user last chose for it. When there is NO record
 * for a backing model, it defaults to showing the placeholder identity (e.g. a
 * fresh install shows GPT-5.6). The real backing identity is only shown after
 * the user explicitly picks the real card, which stores the backing id itself.
 */
export function rememberModelDisplayChoice(selectedDisplayId: string): void {
  const alias = findAliasByDisplayId(selectedDisplayId);
  const backingAlias = findAliasByBacking(selectedDisplayId);
  const preference = readPreference();

  if (alias) {
    // User picked the placeholder card → show it as the placeholder.
    preference[alias.backingBareId] = alias.displayId;
    writePreference(preference);
    return;
  }
  if (backingAlias) {
    // User explicitly picked the real backing card → pin the real identity.
    // (Storing the backing id, not deleting, so it overrides the placeholder
    // default that applies when no record exists.)
    preference[backingAlias.backingBareId] = backingAlias.backingBareId;
    writePreference(preference);
  }
}

export function subscribeModelDisplayChoice(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handle = () => listener();
  const handleStorage = (event: StorageEvent) => {
    if (event.key === PREFERENCE_STORAGE_KEY) listener();
  };
  window.addEventListener(PREFERENCE_EVENT, handle);
  window.addEventListener("storage", handleStorage);
  return () => {
    window.removeEventListener(PREFERENCE_EVENT, handle);
    window.removeEventListener("storage", handleStorage);
  };
}

// ---------------------------------------------------------------------------
// List + current-model transforms shared by every model-aware page.
// ---------------------------------------------------------------------------

export interface AliasModelLike {
  id: string;
  name: string;
  provider: string;
  vendor?: string;
  isDefault?: boolean;
  description?: string;
}

/**
 * Expand an API model list with a placeholder card for every alias whose
 * backing model is present. The placeholder clones the backing entry but keeps
 * the synthetic display id/name. The real backing card is preserved, so both
 * appear in the marketplace and picker.
 */
export function withDisplayAliasModels<T extends AliasModelLike>(
  models: readonly T[],
): T[] {
  const result = [...models];
  for (const alias of MODEL_DISPLAY_ALIASES) {
    const backingIndex = result.findIndex(
      (model) => toBareId(model.id) === alias.backingBareId,
    );
    if (backingIndex === -1) continue;
    if (result.some((model) => model.id === alias.displayId)) continue;
    const backing = result[backingIndex];
    if (!backing) continue;
    // Insert the placeholder right before its backing card.
    result.splice(backingIndex, 0, {
      ...backing,
      id: alias.displayId,
      name: alias.displayName,
      isDefault: false,
    });
  }
  return result;
}

/**
 * Map a real (backend) current-model id onto the id that should be shown as
 * selected in the UI. If the user last chose the placeholder identity for this
 * backing model, return the placeholder display id; otherwise return it as-is.
 */
export function resolveDisplayModelId(currentModelId: string): string {
  if (!currentModelId) return currentModelId;
  // If the current id is already a placeholder display id, keep it.
  if (isAliasDisplayId(currentModelId)) return currentModelId;
  const alias = findAliasByBacking(currentModelId);
  if (!alias) return currentModelId;
  const preferred = readPreference()[alias.backingBareId];
  // Default (no stored choice) shows the placeholder identity — a fresh install
  // presents GPT-5.6. Only an explicit pick of the real card (which stores the
  // backing id) shows the real identity.
  return preferred === alias.backingBareId ? currentModelId : alias.displayId;
}

/**
 * Map a UI-selected model id back onto the real backend id to send to the API.
 * Placeholder display ids resolve to their backing model; everything else is
 * returned unchanged. Also records the display choice so other pages stay in
 * sync.
 */
export function resolveBackendModelId(selectedDisplayId: string): string {
  rememberModelDisplayChoice(selectedDisplayId);
  const alias = findAliasByDisplayId(selectedDisplayId);
  if (!alias) return selectedDisplayId;
  const scoped = selectedDisplayId.startsWith("link/");
  return scoped ? `link/${alias.backingBareId}` : alias.backingBareId;
}
