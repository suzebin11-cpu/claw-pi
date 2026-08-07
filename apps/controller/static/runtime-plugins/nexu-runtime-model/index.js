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
const llmRuns = new Map();

const BASE_RELOAD_RULES = [
  ["gateway.remote", "none"],
  ["gateway.reload", "none"],
  ["gateway.channelHealthCheckMinutes", "hot"],
  ["gateway.channelStaleEventThresholdMinutes", "hot"],
  ["gateway.channelMaxRestartsPerHour", "hot"],
  ["diagnostics.stuckSessionWarnMs", "none"],
  ["hooks", "hot"],
  ["agents.defaults.heartbeat", "hot"],
  ["agents.defaults.models", "hot"],
  ["agents.defaults.model", "hot"],
  ["models", "hot"],
  ["agents.list", "hot"],
  ["agent.heartbeat", "hot"],
  ["cron", "hot"],
  ["channels", "hot"],
  ["meta", "none"],
  ["identity", "none"],
  ["wizard", "none"],
  ["logging", "none"],
  ["agents", "none"],
  ["tools", "none"],
  ["bindings", "none"],
  ["audio", "none"],
  ["agent", "none"],
  ["routing", "none"],
  ["messages", "none"],
  ["session", "none"],
  ["talk", "none"],
  ["skills", "none"],
  ["secrets", "none"],
  ["plugins", "restart"],
  ["ui", "none"],
  ["gateway", "restart"],
  ["discovery", "restart"],
  ["canvasHost", "restart"],
];

function classifyReloadPath(path) {
  for (const [prefix, kind] of BASE_RELOAD_RULES) {
    if (path === prefix || path.startsWith(`${prefix}.`)) {
      return kind;
    }
  }
  return "restart";
}

function buildConfigPlan(params) {
  const changedPaths = Array.isArray(params?.changedPaths)
    ? params.changedPaths.filter((path) => typeof path === "string")
    : [];
  const hotReloadPaths = [];
  const restartRequiredPaths = [];
  const noopPaths = [];
  for (const path of changedPaths) {
    const kind = classifyReloadPath(path);
    if (kind === "hot") hotReloadPaths.push(path);
    else if (kind === "none") noopPaths.push(path);
    else restartRequiredPaths.push(path);
  }
  return {
    changedPaths,
    hotReloadPaths,
    restartRequiredPaths,
    noopPaths,
    restartRequired: restartRequiredPaths.length > 0,
    configRevision:
      typeof params?.configRevision === "string" ? params.configRevision : "",
  };
}

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

function toModelOverride(modelRef) {
  const slashIndex = modelRef.indexOf("/");
  if (slashIndex <= 0) {
    return {
      modelOverride: modelRef,
    };
  }
  return {
    providerOverride: modelRef.slice(0, slashIndex),
    modelOverride: modelRef.slice(slashIndex + 1),
  };
}

const plugin = {
  id: "nexu-runtime-model",
  name: "Nexu Runtime Model",
  description:
    "Injects Nexu runtime model selection into model routing and prompt context.",
  register(api) {
    // Controller-facing planning RPC. It runs inside Gateway/plugin activation
    // context, keeping reload classification out of controller business logic.
    api.registerGatewayMethod(
      "nexu.config.plan",
      ({ params, respond }) => respond(true, buildConfigPlan(params)),
      { scope: "operator.admin" },
    );

    api.on("before_model_resolve", async () => {
      const state = loadState();
      if (!state) {
        return;
      }
      if (!isSelectionAvailable(state)) {
        return;
      }
      return toModelOverride(state.selectedModelRef);
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

    api.on("llm_input", async (event, ctx) => {
      const runId = event?.runId || ctx?.runId || "";
      if (runId) {
        llmRuns.set(runId, Date.now());
      }
      const promptChars =
        typeof event?.prompt === "string" ? event.prompt.length : 0;
      const systemPromptChars =
        typeof event?.systemPrompt === "string" ? event.systemPrompt.length : 0;
      const historyMessages = Array.isArray(event?.historyMessages)
        ? event.historyMessages.length
        : 0;
      console.info(
        `[nexu-runtime-model] llm-input runId=${runId || "n/a"} provider=${event?.provider ?? "n/a"} model=${event?.model ?? "n/a"} channel=${ctx?.channelId ?? ctx?.messageProvider ?? "n/a"} sessionKey=${ctx?.sessionKey ?? "n/a"} promptChars=${promptChars} systemPromptChars=${systemPromptChars} historyMessages=${historyMessages} images=${event?.imagesCount ?? 0}`,
      );
    });

    api.on("llm_output", async (event, ctx) => {
      const runId = event?.runId || ctx?.runId || "";
      const startedAt = runId ? llmRuns.get(runId) : null;
      if (runId) {
        llmRuns.delete(runId);
      }
      const outputDelayMs = startedAt ? Date.now() - startedAt : null;
      const assistantTextChars = Array.isArray(event?.assistantTexts)
        ? event.assistantTexts.join("").length
        : 0;
      console.info(
        `[nexu-runtime-model] llm-output runId=${runId || "n/a"} provider=${event?.provider ?? "n/a"} model=${event?.model ?? "n/a"} channel=${ctx?.channelId ?? ctx?.messageProvider ?? "n/a"} outputDelayMs=${outputDelayMs ?? "n/a"} assistantTextChars=${assistantTextChars} usage=${JSON.stringify(event?.usage ?? {})}`,
      );
    });
  },
};

export default plugin;
