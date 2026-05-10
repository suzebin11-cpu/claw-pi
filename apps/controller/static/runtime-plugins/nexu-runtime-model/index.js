import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginDir = path.dirname(fileURLToPath(import.meta.url));
const statePath = path.resolve(
  pluginDir,
  "..",
  "..",
  "nexu-runtime-model.json",
);

let cachedRaw = null;
let cachedMtimeMs = null;
let cachedState = null;

function loadState() {
  try {
    const nextMtimeMs = statSync(statePath).mtimeMs;
    if (cachedState && cachedMtimeMs === nextMtimeMs) {
      return cachedState;
    }
    const raw = readFileSync(statePath, "utf8");
    if (cachedState && cachedRaw === raw) {
      cachedMtimeMs = nextMtimeMs;
      return cachedState;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    // The fallback initializer writes `{ updatedAt }` only when no real
    // selection has ever been recorded; treat that as "no override" so the
    // runtime falls back to agents.defaults.model.primary in openclaw.json.
    const hasSelectedRef = typeof parsed.selectedModelRef === "string";
    const hasPromptNotice = typeof parsed.promptNotice === "string";
    if (!hasSelectedRef && !hasPromptNotice) {
      cachedRaw = raw;
      cachedMtimeMs = nextMtimeMs;
      cachedState = null;
      return null;
    }
    if (!hasSelectedRef || !hasPromptNotice) {
      return null;
    }
    cachedRaw = raw;
    cachedMtimeMs = nextMtimeMs;
    cachedState = parsed;
    return parsed;
  } catch {
    return cachedState;
  }
}

function isSelectionAvailable(state) {
  if (!Array.isArray(state.availableModelRefs)) {
    // Older controller writes did not include the whitelist; preserve the
    // previous "always override" behavior in that case so we don't regress
    // existing installations on first boot of a new build.
    return true;
  }
  if (state.availableModelRefs.length === 0) {
    // Controller computed an empty available list (e.g. cloud catalogue not
    // yet hydrated). Refuse to override so the agent uses its configured
    // primary model rather than risking an "Unknown model" failover.
    return false;
  }
  return state.availableModelRefs.includes(state.selectedModelRef);
}

const plugin = {
  id: "nexu-runtime-model",
  name: "Nexu Runtime Model",
  description:
    "Injects Nexu runtime model selection into model routing and prompt context.",
  register(api) {
    api.on("before_model_resolve", async () => {
      const state = loadState();
      if (!state) {
        return;
      }
      if (!isSelectionAvailable(state)) {
        return;
      }
      const slashIndex = state.selectedModelRef.indexOf("/");
      if (slashIndex <= 0) {
        return {
          modelOverride: state.selectedModelRef,
        };
      }
      const providerOverride = state.selectedModelRef.slice(0, slashIndex);
      const modelOverride = state.selectedModelRef.slice(slashIndex + 1);
      return {
        providerOverride,
        modelOverride,
      };
    });

    api.on("before_prompt_build", async () => {
      const state = loadState();
      if (!state?.promptNotice) {
        return;
      }
      if (!isSelectionAvailable(state)) {
        return;
      }
      return {
        prependSystemContext: state.promptNotice,
      };
    });
  },
};

export default plugin;
