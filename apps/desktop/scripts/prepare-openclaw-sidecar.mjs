import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  electronRoot,
  getSidecarRoot,
  linkOrCopyDirectory,
  pathExists,
  removePathIfExists,
  repoRoot,
  resetDir,
  shouldCopyRuntimeDependencies,
} from "./lib/sidecar-paths.mjs";

const require = createRequire(import.meta.url);

const openclawRuntimeRoot = resolve(repoRoot, "openclaw-runtime");
const openclawRuntimeNodeModules = resolve(openclawRuntimeRoot, "node_modules");
const openclawRoot = resolve(openclawRuntimeNodeModules, "openclaw");
const openclawRuntimePatchesRoot = resolve(
  repoRoot,
  "openclaw-runtime-patches",
);
const openclawPackagePatchRoot = resolve(
  openclawRuntimePatchesRoot,
  "openclaw",
);
const REPLY_OUTCOME_HELPER_SEARCH = `
const sessionKey = ctx.SessionKey;
	const startTime = diagnosticsEnabled ? Date.now() : 0;
`.trim();
const REPLY_OUTCOME_HELPER_REPLACEMENT = `
const sessionKey = ctx.SessionKey;
	const emitReplyOutcome = (status, reasonCode, error) => {
		try {
			console.log("NEXU_EVENT channel.reply_outcome " + JSON.stringify({
				channel,
				status,
				reasonCode,
				accountId: ctx.AccountId,
				to: chatId,
				chatId,
				threadId: ctx.MessageThreadId,
				replyToMessageId: messageId,
				sessionKey,
				messageId,
				error,
				ts: (/* @__PURE__ */ new Date()).toISOString()
			}));
		} catch {}
	};
	const startTime = diagnosticsEnabled ? Date.now() : 0;
`.trim();
const REPLY_OUTCOME_SILENT_SEARCH = `
const counts = dispatcher.getQueuedCounts();
		counts.final += routedFinalCount;
		recordProcessed("completed", pluginFallbackReason
`.trim();
const REPLY_OUTCOME_SILENT_REPLACEMENT = `
const counts = dispatcher.getQueuedCounts();
		counts.final += routedFinalCount;
		if (!queuedFinal) emitReplyOutcome("silent", "no_final_reply");
		recordProcessed("completed", pluginFallbackReason
`.trim();
const REPLY_OUTCOME_ERROR_SEARCH = `
recordProcessed("error", { error: String(err) });
		markIdle("message_error");
`.trim();
const REPLY_OUTCOME_ERROR_REPLACEMENT = `
emitReplyOutcome("failed", "dispatch_threw", err instanceof Error ? err.message : String(err));
		recordProcessed("error", { error: String(err) });
		markIdle("message_error");
`.trim();
const FEISHU_ERROR_REPLY_SUPPRESS_GUARD_SEARCH = `
const genericErrorText = "The AI service returned an error. Please try again.";
	const suppressErrorTextReply = params.messageChannel === "feishu" && lastAssistantErrored;
	if (errorText && !suppressErrorTextReply) replyItems.push({
`.trim();
const FEISHU_ERROR_REPLY_SUPPRESS_GUARD_REPLACEMENT = `
const genericErrorText = "The AI service returned an error. Please try again.";
	const suppressErrorTextReply = (params.messageChannel === "feishu" || params.messageProvider === "feishu") && lastAssistantErrored;
	if (errorText && !suppressErrorTextReply) replyItems.push({
`.trim();
const CORE_EMBEDDED_PAYLOAD_MESSAGE_CHANNEL_SEARCH = `
toolResultFormat: resolvedToolResultFormat,
					messageChannel: params.messageChannel,
					suppressToolErrorWarnings: params.suppressToolErrorWarnings,
					inlineToolResultsAllowed: false,
`.trim();
const CORE_EMBEDDED_PAYLOAD_MESSAGE_CHANNEL_REPLACEMENT = `
toolResultFormat: resolvedToolResultFormat,
					messageChannel: params.messageChannel,
					messageProvider: params.messageProvider,
					suppressToolErrorWarnings: params.suppressToolErrorWarnings,
					inlineToolResultsAllowed: false,
`.trim();
const FEISHU_PRE_REPLY_FINAL_SEARCH = [
  "defaultRuntime.error(`Embedded agent failed before reply: ${message}`);",
  '\t\tconst trimmedMessage = (isTransientHttp ? sanitizeUserFacingText(message, { errorContext: true }) : message).replace(/\\.\\s*$/, "");',
  "\t\treturn {",
  '\t\t\tkind: "final",',
  '\t\t\tpayload: { text: isContextOverflow ? "⚠️ Context overflow — prompt too large for this model. Try a shorter message or a larger-context model." : isRoleOrderingError ? "⚠️ Message ordering conflict - please try again. If this persists, use /new to start a fresh session." : `⚠️ Agent failed before reply: ${trimmedMessage}.\\nLogs: openclaw logs --follow` }',
  "\t\t};",
].join("\n");
const FEISHU_PRE_REPLY_FINAL_REPLACEMENT = [
  "defaultRuntime.error(`Embedded agent failed before reply: ${message}`);",
  '\t\tconst trimmedMessage = (isTransientHttp ? sanitizeUserFacingText(message, { errorContext: true }) : message).replace(/\\.\\s*$/, "");',
  '\t\tif (resolveMessageChannel(params.sessionCtx.Surface, params.sessionCtx.Provider) === "feishu") return {',
  '\t\t\tkind: "success",',
  "\t\t\trunId,",
  "\t\t\trunResult: { payloads: [] },",
  "\t\t\tfallbackProvider,",
  "\t\t\tfallbackModel,",
  "\t\t\tfallbackAttempts,",
  "\t\t\tdidLogHeartbeatStrip,",
  "\t\t\tautoCompactionCompleted,",
  "\t\t\tdirectlySentBlockKeys: directlySentBlockKeys.size > 0 ? directlySentBlockKeys : void 0",
  "\t\t};",
  "\t\treturn {",
  '\t\t\tkind: "final",',
  '\t\t\tpayload: { text: isContextOverflow ? "⚠️ Context overflow — prompt too large for this model. Try a shorter message or a larger-context model." : isRoleOrderingError ? "⚠️ Message ordering conflict - please try again. If this persists, use /new to start a fresh session." : `⚠️ Agent failed before reply: ${trimmedMessage}.\\nLogs: openclaw logs --follow` }',
  "\t\t};",
].join("\n");
const PI_EMBEDDED_BUNDLE_PATTERN = /^pi-embedded-.*\.js$/u;
const GEMINI_SANITIZE_COMPACTION_SEARCH = [
  "\tconst toolsEnabled = supportsModelTools(runtimeModel);",
  "\t\tconst tools = sanitizeToolsForGoogle({",
  "\t\t\ttools: toolsEnabled ? toolsRaw : [],",
  "\t\t\tprovider",
  "\t\t});",
].join("\n");
const GEMINI_SANITIZE_COMPACTION_REPLACEMENT = [
  "\tconst toolsEnabled = supportsModelTools(runtimeModel);",
  "\t\tconst tools = sanitizeToolsForGoogle({",
  "\t\t\ttools: toolsEnabled ? toolsRaw : [],",
  '\t\t\tprovider: /gemini/i.test(modelId) ? "google-gemini-cli" : provider',
  "\t\t});",
].join("\n");
const GEMINI_SANITIZE_EMBEDDED_SEARCH = [
  "\tconst toolsEnabled = supportsModelTools(params.model);",
  "\t\tconst tools = sanitizeToolsForGoogle({",
  "\t\t\ttools: toolsEnabled ? toolsRaw : [],",
  "\t\t\tprovider: params.provider",
  "\t\t});",
].join("\n");
const GEMINI_SANITIZE_EMBEDDED_REPLACEMENT = [
  "\tconst toolsEnabled = supportsModelTools(params.model);",
  "\t\tconst tools = sanitizeToolsForGoogle({",
  "\t\t\ttools: toolsEnabled ? toolsRaw : [],",
  '\t\t\tprovider: /gemini/i.test(params.modelId ?? "") ? "google-gemini-cli" : params.provider',
  "\t\t});",
].join("\n");
const GEMINI_TYPE_ARRAY_SEARCH =
  "cleaned.type = types.length === 1 ? types[0] : types;";
const GEMINI_TYPE_ARRAY_REPLACEMENT =
  'cleaned.type = types.length >= 1 ? types[0] : "string";';
const CONTROL_UI_BUNDLE_PATTERN = /^index-.*\.js$/u;
const CONTROL_UI_IMAGE_EXTRACTOR_SEARCH =
  'function ey(e){let t=e.content,n=[];if(Array.isArray(t))for(let e of t){if(typeof e!=`object`||!e)continue;let t=e;if(t.type===`image`){let e=t.source;if(e?.type===`base64`&&typeof e.data==`string`){let t=e.data,r=e.media_type||`image/png`,i=t.startsWith(`data:`)?t:`data:${r};base64,${t}`;n.push({url:i})}else typeof t.url==`string`&&n.push({url:t.url})}else if(t.type===`image_url`){let e=t.image_url;typeof e?.url==`string`&&n.push({url:e.url})}}return n}';
const CONTROL_UI_IMAGE_EXTRACTOR_REPLACEMENT =
  'function ey(e){let t=e.content,n=[];let r=e=>{if(typeof e!=`string`)return;let t=e.trim();if(!t)return;if(!(/^https?:\\/\\//i.test(t)||/^data:image\\//i.test(t)||t.startsWith(`/`)))return;if(!n.some(e=>e.url===t))n.push({url:t,alt:`生成图片`})};let i=e=>{if(!e||typeof e!=`object`)return;let t=e;typeof t.mediaUrl==`string`&&r(t.mediaUrl);Array.isArray(t.mediaUrls)&&t.mediaUrls.forEach(r);typeof t.url==`string`&&r(t.url);typeof t.fileUrl==`string`&&r(t.fileUrl);t.media&&typeof t.media==`object`&&i(t.media)};if(Array.isArray(t))for(let e of t){if(typeof e!=`object`||!e)continue;let t=e;if(t.type===`image`){let e=t.source;if(e?.type===`base64`&&typeof e.data==`string`){let t=e.data,r=e.media_type||`image/png`,i=t.startsWith(`data:`)?t:`data:${r};base64,${t}`;n.push({url:i})}else typeof t.url==`string`&&r(t.url)}else if(t.type===`image_url`){let e=t.image_url;typeof e?.url==`string`&&r(e.url)}}i(e.details);return n}';
const CONTROL_UI_TOOL_OUTPUT_DETAILS_SEARCH =
  '<details class="chat-tool-msg-collapse">';
const CONTROL_UI_TOOL_OUTPUT_DETAILS_REPLACEMENT =
  '<details class="chat-tool-msg-collapse" ?open=${f||m}>';
const CONTROL_UI_NODE_LIST_POLL_SEARCH =
  "function Ir(e){e.nodesPollInterval??=window.setInterval(()=>void Fr(e,{quiet:!0}),5e3)}";
const CONTROL_UI_NODE_LIST_POLL_60S_SEARCH =
  "function Ir(e){e.nodesPollInterval??=window.setInterval(()=>void Fr(e,{quiet:!0}),6e4)}";
const CONTROL_UI_NODE_LIST_POLL_REPLACEMENT =
  CONTROL_UI_NODE_LIST_POLL_SEARCH;
const CONTROL_UI_CSP_IMAGE_SRC_SEARCH = '"img-src \'self\' data: https:",';
const CONTROL_UI_CSP_IMAGE_SRC_REPLACEMENT =
  '"img-src \'self\' data: https: http://127.0.0.1:* http://localhost:*",';
const CONTROL_UI_NODE_LIST_HANDLER_SEARCH = [
  '\t"node.list": async ({ params, respond, context }) => {',
  "\t\tif (!validateNodeListParams(params)) {",
  "\t\t\trespondInvalidParams({",
  "\t\t\t\trespond,",
  '\t\t\t\tmethod: "node.list",',
  "\t\t\t\tvalidator: validateNodeListParams",
  "\t\t\t});",
  "\t\t\treturn;",
  "\t\t}",
  "\t\tawait respondUnavailableOnThrow(respond, async () => {",
  "\t\t\tconst [devicePairing, nodePairing] = await Promise.all([listDevicePairing(), listNodePairing()]);",
  "\t\t\tconst nodes = listKnownNodes(createKnownNodeCatalog({",
  "\t\t\t\tpairedDevices: devicePairing.paired,",
  "\t\t\t\tpairedNodes: nodePairing.paired,",
  "\t\t\t\tconnectedNodes: context.nodeRegistry.listConnected()",
  "\t\t\t}));",
  "\t\t\trespond(true, {",
  "\t\t\t\tts: Date.now(),",
  "\t\t\t\tnodes",
  "\t\t\t}, void 0);",
  "\t\t});",
  "\t},",
].join("\n");
const PI_EMBEDDED_RUN_QUEUE_TIMING_SEARCH = [
  "\treturn enqueueSession(() => {",
  "\t\tthrowIfAborted();",
  "\t\treturn enqueueGlobal(async () => {",
  "\t\t\tthrowIfAborted();",
  "\t\t\tconst started = Date.now();",
].join("\n");
const PI_EMBEDDED_RUN_QUEUE_TIMING_REPLACEMENT = [
  "\tconst __clawpiRunQueuedAt = Date.now();",
  '\tconst __clawpiRunTimingId = params.runId ?? params.sessionId ?? params.sessionKey ?? "unknown";',
  "\treturn enqueueSession(() => {",
  "\t\tconst __clawpiSessionDequeuedAt = Date.now();",
  '\t\tconsole.info(`[clawpi-run-timing] runId=${__clawpiRunTimingId} stage=session-dequeued waitMs=${__clawpiSessionDequeuedAt - __clawpiRunQueuedAt} sessionKey=${params.sessionKey ?? ""} lane=${sessionLane}`);',
  "\t\tthrowIfAborted();",
  "\t\treturn enqueueGlobal(async () => {",
  "\t\t\tconst __clawpiGlobalDequeuedAt = Date.now();",
  '\t\t\tconsole.info(`[clawpi-run-timing] runId=${__clawpiRunTimingId} stage=global-dequeued sessionWaitMs=${__clawpiSessionDequeuedAt - __clawpiRunQueuedAt} globalWaitMs=${__clawpiGlobalDequeuedAt - __clawpiSessionDequeuedAt} globalLane=${globalLane}`);',
  "\t\t\tthrowIfAborted();",
  "\t\t\tconst started = Date.now();",
].join("\n");
const PI_EMBEDDED_RUN_STAGE_MARK_SEARCH = [
  "\t\t\tconst started = Date.now();",
  "\t\t\tconst workspaceResolution = resolveRunWorkspaceDir({",
].join("\n");
const PI_EMBEDDED_RUN_STAGE_MARK_REPLACEMENT = [
  "\t\t\tconst started = Date.now();",
  "\t\t\tlet __clawpiRunStageAt = started;",
  "\t\t\tconst __clawpiMarkRunStage = (stage) => {",
  "\t\t\t\tconst __now = Date.now();",
  '\t\t\t\tconsole.info(`[clawpi-run-timing] runId=${__clawpiRunTimingId} stage=${stage} deltaMs=${__now - __clawpiRunStageAt} totalMs=${__now - started}`);',
  "\t\t\t\t__clawpiRunStageAt = __now;",
  "\t\t\t};",
  "\t\t\tconst workspaceResolution = resolveRunWorkspaceDir({",
].join("\n");
const PI_EMBEDDED_WORKSPACE_MARK_SEARCH =
  '\t\t\tif (workspaceResolution.usedFallback) log$16.warn(`[workspace-fallback] caller=runEmbeddedPiAgent reason=${workspaceResolution.fallbackReason} run=${params.runId} session=${redactedSessionId} sessionKey=${redactedSessionKey} agent=${workspaceResolution.agentId} workspace=${redactedWorkspace}`);\n\t\t\tensureRuntimePluginsLoaded({';
const PI_EMBEDDED_WORKSPACE_MARK_REPLACEMENT =
  '\t\t\tif (workspaceResolution.usedFallback) log$16.warn(`[workspace-fallback] caller=runEmbeddedPiAgent reason=${workspaceResolution.fallbackReason} run=${params.runId} session=${redactedSessionId} sessionKey=${redactedSessionKey} agent=${workspaceResolution.agentId} workspace=${redactedWorkspace}`);\n\t\t\t__clawpiMarkRunStage("workspace-resolved");\n\t\t\t__clawpiMarkRunStage("runtime-plugins-load-start");\n\t\t\tensureRuntimePluginsLoaded({';
const PI_EMBEDDED_RUNTIME_PLUGINS_MARK_SEARCH = [
  "\t\t\tensureRuntimePluginsLoaded({",
  "\t\t\t\tconfig: params.config,",
  "\t\t\t\tworkspaceDir: resolvedWorkspace,",
  "\t\t\t\tallowGatewaySubagentBinding: params.allowGatewaySubagentBinding",
  "\t\t\t});",
  "\t\t\tlet provider = (params.provider ?? \"openai\").trim() || \"openai\";",
].join("\n");
const PI_EMBEDDED_RUNTIME_PLUGINS_MARK_REPLACEMENT = [
  "\t\t\tensureRuntimePluginsLoaded({",
  "\t\t\t\tconfig: params.config,",
  "\t\t\t\tworkspaceDir: resolvedWorkspace,",
  "\t\t\t\tallowGatewaySubagentBinding: params.allowGatewaySubagentBinding",
  "\t\t\t});",
  '\t\t\t__clawpiMarkRunStage("runtime-plugins-loaded");',
  "\t\t\tlet provider = (params.provider ?? \"openai\").trim() || \"openai\";",
].join("\n");
const PI_EMBEDDED_MODELS_JSON_MARK_SEARCH =
  "\t\t\tawait ensureOpenClawModelsJson(params.config, agentDir);\n\t\t\tconst resolvedSessionKey = normalizedSessionKey;";
const PI_EMBEDDED_MODELS_JSON_MARK_REPLACEMENT =
  '\t\t\t__clawpiMarkRunStage("models-json-start");\n\t\t\tconst __clawpiModelsJsonPath = path.join(agentDir, "models.json");\n\t\t\tconst __clawpiModelsJsonSentinelPath = path.join(agentDir, ".clawpi-models-json.key");\n\t\t\tconst __clawpiProviders = params.config?.models?.providers;\n\t\t\tconst __clawpiModelsJsonKey = stableStringify$1({ providers: __clawpiProviders, secrets: params.config?.secrets?.defaults });\n\t\t\tconst __clawpiModelsJsonCachedKey = await fs$1.readFile(__clawpiModelsJsonSentinelPath, "utf8").catch(() => "");\n\t\t\tlet __clawpiModelsJsonStage = "models-json-cache-hit";\n\t\t\tlet __clawpiModelsJsonUsable = false;\n\t\t\tif (__clawpiModelsJsonCachedKey === __clawpiModelsJsonKey) {\n\t\t\t\t__clawpiModelsJsonUsable = await fs$1.stat(__clawpiModelsJsonPath).then((stat) => stat.isFile() && stat.size > 0).catch(() => false);\n\t\t\t}\n\t\t\tif (!__clawpiModelsJsonUsable) {\n\t\t\t\tconst __clawpiProviderEntries = __clawpiProviders && typeof __clawpiProviders === "object" && !Array.isArray(__clawpiProviders) ? Object.entries(__clawpiProviders) : [];\n\t\t\t\tconst __clawpiHasRunnableConfiguredProvider = __clawpiProviderEntries.some(([, providerConfig]) => providerConfig && typeof providerConfig === "object" && !Array.isArray(providerConfig) && Array.isArray(providerConfig.models) && providerConfig.models.length > 0 && (typeof providerConfig.api === "string" || typeof providerConfig.baseUrl === "string"));\n\t\t\t\tif (__clawpiHasRunnableConfiguredProvider) {\n\t\t\t\t\tawait fs$1.mkdir(agentDir, { recursive: true, mode: 448 }).catch(() => {});\n\t\t\t\t\tawait fs$1.writeFile(__clawpiModelsJsonPath, `${JSON.stringify({ providers: __clawpiProviders }, null, 2)}\\n`, { mode: 384 });\n\t\t\t\t\tawait fs$1.chmod(__clawpiModelsJsonPath, 384).catch(() => {});\n\t\t\t\t\t__clawpiModelsJsonStage = "models-json-direct-write";\n\t\t\t\t} else {\n\t\t\t\t\tawait ensureOpenClawModelsJson(params.config, agentDir);\n\t\t\t\t\t__clawpiModelsJsonStage = "models-json-ready";\n\t\t\t\t}\n\t\t\t\tawait fs$1.writeFile(__clawpiModelsJsonSentinelPath, __clawpiModelsJsonKey, "utf8").catch(() => {});\n\t\t\t}\n\t\t\t__clawpiMarkRunStage(__clawpiModelsJsonStage);\n\t\t\tconst resolvedSessionKey = normalizedSessionKey;';
const PI_EMBEDDED_HOOK_SELECTION_MARK_SEARCH =
  "\t\t\tconst hookSelection = await resolveHookModelSelection({";
const PI_EMBEDDED_HOOK_SELECTION_MARK_REPLACEMENT =
  '\t\t\t__clawpiMarkRunStage("hook-model-selection-start");\n\t\t\tconst hookSelection = await resolveHookModelSelection({';
const PI_EMBEDDED_RESOLVE_MODEL_MARK_SEARCH =
  "\t\t\tconst { model, error, authStorage, modelRegistry } = await resolveModelAsync(provider, modelId, agentDir, params.config);";
const PI_EMBEDDED_RESOLVE_MODEL_MARK_REPLACEMENT =
  '\t\t\t__clawpiMarkRunStage("hook-model-selection-ready");\n\t\t\t__clawpiMarkRunStage("resolve-model-start");\n\t\t\tconst __clawpiResolveModelCache = globalThis.__clawpiResolveModelCache ??= new Map();\n\t\t\tconst __clawpiProviderConfigForCache = params.config?.models?.providers?.[provider];\n\t\t\tconst __clawpiCanCacheResolvedModel = __clawpiProviderConfigForCache && typeof __clawpiProviderConfigForCache === "object" && !Array.isArray(__clawpiProviderConfigForCache) && Array.isArray(__clawpiProviderConfigForCache.models) && __clawpiProviderConfigForCache.models.length > 0;\n\t\t\tconst __clawpiResolvedModelCacheKey = __clawpiCanCacheResolvedModel ? `${__clawpiModelsJsonKey}:${provider}:${modelId}` : "";\n\t\t\tlet __clawpiResolvedModel = __clawpiResolvedModelCacheKey ? __clawpiResolveModelCache.get(__clawpiResolvedModelCacheKey) : void 0;\n\t\t\tconst __clawpiResolvedModelCacheHit = Boolean(__clawpiResolvedModel);\n\t\t\tif (!__clawpiResolvedModel) {\n\t\t\t\t__clawpiResolvedModel = await resolveModelAsync(provider, modelId, agentDir, params.config);\n\t\t\t\tif (__clawpiResolvedModelCacheKey && __clawpiResolvedModel?.model) {\n\t\t\t\t\tif (__clawpiResolveModelCache.size > 16) __clawpiResolveModelCache.clear();\n\t\t\t\t\t__clawpiResolveModelCache.set(__clawpiResolvedModelCacheKey, __clawpiResolvedModel);\n\t\t\t\t}\n\t\t\t}\n\t\t\tconst { model, error, authStorage, modelRegistry } = __clawpiResolvedModel;\n\t\t\t__clawpiMarkRunStage(__clawpiResolvedModelCacheHit ? "resolve-model-cache-hit" : "resolve-model-ready");';
const PI_EMBEDDED_INIT_AUTH_MARK_SEARCH =
  "\t\t\tawait initializeAuthProfile();";
const PI_EMBEDDED_INIT_AUTH_MARK_REPLACEMENT =
  '\t\t\t__clawpiMarkRunStage("auth-profile-init-start");\n\t\t\tawait initializeAuthProfile();\n\t\t\t__clawpiMarkRunStage("auth-profile-init-ready");';
const PI_EMBEDDED_CONTEXT_ENGINE_MARK_SEARCH =
  "\t\t\tensureContextEnginesInitialized();\n\t\t\tconst contextEngine = await resolveContextEngine(params.config);";
const PI_EMBEDDED_CONTEXT_ENGINE_MARK_REPLACEMENT =
  '\t\t\t__clawpiMarkRunStage("context-engines-init-start");\n\t\t\tensureContextEnginesInitialized();\n\t\t\t__clawpiMarkRunStage("context-engines-init-ready");\n\t\t\t__clawpiMarkRunStage("context-engine-resolve-start");\n\t\t\tconst contextEngine = await resolveContextEngine(params.config);\n\t\t\t__clawpiMarkRunStage("context-engine-resolve-ready");';
const PI_EMBEDDED_ATTEMPT_MARK_SEARCH =
  "\t\t\t\t\tconst attempt = await runEmbeddedAttempt({";
const PI_EMBEDDED_ATTEMPT_MARK_REPLACEMENT =
  '\t\t\t\t\t__clawpiMarkRunStage("embedded-attempt-start");\n\t\t\t\t\tconst attempt = await runEmbeddedAttempt({';
const PI_EMBEDDED_ATTEMPT_READY_MARK_SEARCH =
  "\t\t\t\t\tconst { aborted, promptError, promptErrorSource, preflightRecovery, timedOut, timedOutDuringCompaction, sessionIdUsed, lastAssistant } = attempt;";
const PI_EMBEDDED_ATTEMPT_READY_MARK_REPLACEMENT =
  '\t\t\t\t\t__clawpiMarkRunStage("embedded-attempt-ready");\n\t\t\t\t\tconst { aborted, promptError, promptErrorSource, preflightRecovery, timedOut, timedOutDuringCompaction, sessionIdUsed, lastAssistant } = attempt;';
const CONTROL_UI_NODE_LIST_HANDLER_REPLACEMENT = [
  '\t"node.list": async ({ params, respond, context }) => {',
  "\t\tif (!validateNodeListParams(params)) {",
  "\t\t\trespondInvalidParams({",
  "\t\t\t\trespond,",
  '\t\t\t\tmethod: "node.list",',
  "\t\t\t\tvalidator: validateNodeListParams",
  "\t\t\t});",
  "\t\t\treturn;",
  "\t\t}",
  "\t\tawait respondUnavailableOnThrow(respond, async () => {",
  "\t\t\tconst cache = globalThis.__clawpiNodeListCache ??= {",
  "\t\t\t\tpairedDevices: [],",
  "\t\t\t\tpairedNodes: [],",
  "\t\t\t\trefreshing: false",
  "\t\t\t};",
  "\t\t\trespond(true, {",
  "\t\t\t\tts: Date.now(),",
  "\t\t\t\tnodes: listKnownNodes(createKnownNodeCatalog({",
  "\t\t\t\t\tpairedDevices: cache.pairedDevices,",
  "\t\t\t\t\tpairedNodes: cache.pairedNodes,",
  "\t\t\t\t\tconnectedNodes: context.nodeRegistry.listConnected()",
  "\t\t\t\t}))",
  "\t\t\t}, void 0);",
  "\t\t\tif (!cache.refreshing) {",
  "\t\t\t\tcache.refreshing = true;",
  "\t\t\t\tPromise.all([listDevicePairing(), listNodePairing()]).then(([devicePairing, nodePairing]) => {",
  "\t\t\t\t\tcache.pairedDevices = devicePairing.paired;",
  "\t\t\t\t\tcache.pairedNodes = nodePairing.paired;",
  "\t\t\t\t}).catch(() => {}).finally(() => {",
  "\t\t\t\t\tcache.refreshing = false;",
  "\t\t\t\t});",
  "\t\t\t}",
  "\t\t});",
  "\t},",
].join("\n");
const CONTROL_UI_DEVICE_PAIR_LIST_HANDLER_SEARCH = [
  '\t"device.pair.list": async ({ params, respond }) => {',
  "\t\tif (!validateDevicePairListParams(params)) {",
  "\t\t\trespond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid device.pair.list params: ${formatValidationErrors(validateDevicePairListParams.errors)}`));",
  "\t\t\treturn;",
  "\t\t}",
  "\t\tconst list = await listDevicePairing();",
  "\t\trespond(true, {",
  "\t\t\tpending: list.pending,",
  "\t\t\tpaired: list.paired.map((device) => redactPairedDevice(device))",
  "\t\t}, void 0);",
  "\t},",
].join("\n");
const CONTROL_UI_DEVICE_PAIR_LIST_HANDLER_REPLACEMENT = [
  '\t"device.pair.list": async ({ params, respond }) => {',
  "\t\tif (!validateDevicePairListParams(params)) {",
  "\t\t\trespond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid device.pair.list params: ${formatValidationErrors(validateDevicePairListParams.errors)}`));",
  "\t\t\treturn;",
  "\t\t}",
  "\t\tconst cache = globalThis.__clawpiDevicePairListCache ??= { pending: [], paired: [], refreshing: false, promise: null };",
  "\t\tconst refresh = () => {",
  "\t\t\tif (!cache.promise) {",
  "\t\t\t\tcache.refreshing = true;",
  "\t\t\t\tcache.promise = listDevicePairing().then((list) => {",
  "\t\t\t\t\tcache.pending = list.pending;",
  "\t\t\t\t\tcache.paired = list.paired.map((device) => redactPairedDevice(device));",
  "\t\t\t\t\treturn { pending: cache.pending, paired: cache.paired };",
  "\t\t\t\t}).finally(() => {",
  "\t\t\t\t\tcache.refreshing = false;",
  "\t\t\t\t\tcache.promise = null;",
  "\t\t\t\t});",
  "\t\t\t}",
  "\t\t\treturn cache.promise;",
  "\t\t};",
  "\t\tconst fresh = await Promise.race([",
  "\t\t\trefresh(),",
  "\t\t\tnew Promise((resolve) => setTimeout(() => resolve(null), 500))",
  "\t\t]);",
  "\t\tif (fresh) {",
  "\t\t\trespond(true, fresh, void 0);",
  "\t\t\treturn;",
  "\t\t}",
  "\t\trespond(true, { pending: cache.pending, paired: cache.paired }, void 0);",
  "\t\trefresh().catch(() => {});",
  "\t},",
].join("\n");
const CONTROL_UI_MODELS_LIST_HANDLER_SEARCH = [
  'const modelsHandlers = { "models.list": async ({ params, respond, context }) => {',
  "\tif (!validateModelsListParams(params)) {",
  "\t\trespond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid models.list params: ${formatValidationErrors(validateModelsListParams.errors)}`));",
  "\t\treturn;",
  "\t}",
  "\ttry {",
  "\t\tconst catalog = await context.loadGatewayModelCatalog();",
  "\t\tconst { allowedCatalog } = buildAllowedModelSet({",
  "\t\t\tcfg: loadConfig(),",
  "\t\t\tcatalog,",
  "\t\t\tdefaultProvider: DEFAULT_PROVIDER",
  "\t\t});",
  "\t\trespond(true, { models: allowedCatalog.length > 0 ? allowedCatalog : catalog }, void 0);",
  "\t} catch (err) {",
  "\t\trespond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, String(err)));",
  "\t}",
  "} };",
].join("\n");
const CONTROL_UI_MODELS_LIST_HANDLER_REPLACEMENT = [
  'const modelsHandlers = { "models.list": async ({ params, respond, context }) => {',
  "\tif (!validateModelsListParams(params)) {",
  "\t\trespond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid models.list params: ${formatValidationErrors(validateModelsListParams.errors)}`));",
  "\t\treturn;",
  "\t}",
  "\ttry {",
  "\t\tconst cfg = loadConfig();",
  "\t\tconst cache = globalThis.__clawpiModelsListCache ??= { models: [], refreshing: false };",
  "\t\tconst configuredModels = Object.entries(cfg?.agents?.defaults?.models ?? {}).map(([key, value]) => {",
  "\t\t\tconst slashIndex = key.indexOf(\"/\");",
  "\t\t\tconst provider = slashIndex > 0 ? key.slice(0, slashIndex) : DEFAULT_PROVIDER;",
  "\t\t\tconst id = slashIndex > 0 ? key.slice(slashIndex + 1) : key;",
  "\t\t\treturn {",
  "\t\t\t\tprovider,",
  "\t\t\t\tid,",
  "\t\t\t\tname: typeof value?.alias === \"string\" && value.alias.trim() ? value.alias : id,",
  "\t\t\t\tcontextWindow: typeof value?.contextWindow === \"number\" ? value.contextWindow : void 0,",
  "\t\t\t\treasoning: typeof value?.reasoning === \"boolean\" ? value.reasoning : void 0,",
  "\t\t\t\tinput: Array.isArray(value?.input) ? value.input : [\"text\", \"image\"]",
  "\t\t\t};",
  "\t\t});",
  "\t\tconst immediateModels = configuredModels.length > 0 ? configuredModels : cache.models;",
  "\t\tif (immediateModels.length > 0) {",
  "\t\t\trespond(true, { models: immediateModels }, void 0);",
  "\t\t\treturn;",
  "\t\t} else {",
  "\t\t\tconst catalog = await context.loadGatewayModelCatalog();",
  "\t\t\tconst { allowedCatalog } = buildAllowedModelSet({",
  "\t\t\t\tcfg,",
  "\t\t\t\tcatalog,",
  "\t\t\t\tdefaultProvider: DEFAULT_PROVIDER",
  "\t\t\t});",
  "\t\t\tcache.models = allowedCatalog.length > 0 ? allowedCatalog : catalog;",
  "\t\t\trespond(true, { models: cache.models }, void 0);",
  "\t\t\treturn;",
  "\t\t}",
  "\t} catch (err) {",
  "\t\trespond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, String(err)));",
  "\t}",
  "} };",
].join("\n");
const CONTROL_UI_CHAT_HISTORY_THINKING_SEARCH = [
  "\t\tlet thinkingLevel = entry?.thinkingLevel;",
  "\t\tif (!thinkingLevel) {",
  "\t\t\tconst resolvedModel = resolveSessionModelRef(cfg, entry, resolveSessionAgentId({",
  "\t\t\t\tsessionKey,",
  "\t\t\t\tconfig: cfg",
  "\t\t\t}));",
  "\t\t\tconst catalog = await context.loadGatewayModelCatalog();",
  "\t\t\tthinkingLevel = resolveThinkingDefault({",
  "\t\t\t\tcfg,",
  "\t\t\t\tprovider: resolvedModel.provider,",
  "\t\t\t\tmodel: resolvedModel.model,",
  "\t\t\t\tcatalog",
  "\t\t\t});",
  "\t\t}",
].join("\n");
const CONTROL_UI_CHAT_HISTORY_THINKING_REPLACEMENT = [
  "\t\tlet thinkingLevel = entry?.thinkingLevel;",
  "\t\tif (!thinkingLevel) {",
  "\t\t\tconst resolvedModel = resolveSessionModelRef(cfg, entry, resolveSessionAgentId({",
  "\t\t\t\tsessionKey,",
  "\t\t\t\tconfig: cfg",
  "\t\t\t}));",
  "\t\t\tthinkingLevel = resolveThinkingDefault({",
  "\t\t\t\tcfg,",
  "\t\t\t\tprovider: resolvedModel.provider,",
  "\t\t\t\tmodel: resolvedModel.model,",
  "\t\t\t\tcatalog: []",
  "\t\t\t});",
  "\t\t}",
].join("\n");
const CONTROL_UI_CHAT_HISTORY_DETAILS_STRIP_SEARCH = [
  '\tif ("details" in entry) {',
  "\t\tdelete entry.details;",
  "\t\tchanged = true;",
  "\t}",
].join("\n");
const CONTROL_UI_CHAT_HISTORY_DETAILS_STRIP_REPLACEMENT = [
  '\tif ("details" in entry) {',
  "\t\tconst mediaBlocks = [];",
  "\t\tconst addMediaUrl = (raw) => {",
  '\t\t\tif (typeof raw !== "string") return;',
  "\t\t\tconst url = raw.trim();",
  "\t\t\tif (!url) return;",
  '\t\t\tif (!(/^data:image\\//i.test(url) || /^https?:\\/\\/(?:127(?:\\.\\d{1,3}){3}|localhost):\\d+\\/api\\/internal\\/desktop\\/generated-images\\//i.test(url))) return;',
  "\t\t\tif (!mediaBlocks.some((block) => block?.image_url?.url === url)) {",
  '\t\t\t\tmediaBlocks.push({ type: "image_url", image_url: { url } });',
  "\t\t\t}",
  "\t\t};",
  "\t\tconst collectMedia = (value) => {",
  '\t\t\tif (!value || typeof value !== "object") return;',
  '\t\t\tif (typeof value.mediaUrl === "string") addMediaUrl(value.mediaUrl);',
  "\t\t\tif (Array.isArray(value.mediaUrls)) for (const url of value.mediaUrls) addMediaUrl(url);",
  '\t\t\tif (typeof value.url === "string") addMediaUrl(value.url);',
  '\t\t\tif (typeof value.fileUrl === "string") addMediaUrl(value.fileUrl);',
  '\t\t\tif (value.media && typeof value.media === "object") collectMedia(value.media);',
  "\t\t};",
  "\t\tcollectMedia(entry.details);",
  "\t\tif (mediaBlocks.length > 0) {",
  "\t\t\tif (Array.isArray(entry.content)) entry.content = [...entry.content, ...mediaBlocks];",
  '\t\t\telse if (typeof entry.content === "string") entry.content = [{ type: "text", text: entry.content }, ...mediaBlocks];',
  '\t\t\telse if (typeof entry.text === "string") entry.content = [{ type: "text", text: entry.text }, ...mediaBlocks];',
  "\t\t\telse entry.content = mediaBlocks;",
  "\t\t}",
  "\t\tdelete entry.details;",
  "\t\tchanged = true;",
  "\t}",
].join("\n");
const CONTROL_UI_CHAT_FINAL_BROADCAST_SEARCH = [
  "function broadcastChatFinal(params) {",
  "\tconst seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.runId);",
  "\tconst strippedEnvelopeMessage = stripEnvelopeFromMessage(params.message);",
  "\tconst payload = {",
  "\t\trunId: params.runId,",
  "\t\tsessionKey: params.sessionKey,",
  "\t\tseq,",
  '\t\tstate: "final",',
  "\t\tmessage: stripInlineDirectiveTagsFromMessageForDisplay(strippedEnvelopeMessage)",
  "\t};",
  '\tparams.context.broadcast("chat", payload);',
  '\tparams.context.nodeSendToSession(params.sessionKey, "chat", payload);',
  "\tparams.context.agentRunSeq.delete(params.runId);",
  "}",
].join("\n");
const CONTROL_UI_CHAT_FINAL_BROADCAST_REPLACEMENT = [
  CONTROL_UI_CHAT_FINAL_BROADCAST_SEARCH,
  "function broadcastChatDelta(params) {",
  '\tconst text = typeof params.text === "string" ? params.text : "";',
  "\tif (!text.trim()) return;",
  "\tconst seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.runId);",
  "\tconst message = {",
  '\t\trole: "assistant",',
  "\t\tcontent: [{",
  '\t\t\ttype: "text",',
  "\t\t\ttext",
  "\t\t}],",
  "\t\ttimestamp: Date.now()",
  "\t};",
  "\tconst payload = {",
  "\t\trunId: params.runId,",
  "\t\tsessionKey: params.sessionKey,",
  "\t\tseq,",
  '\t\tstate: "delta",',
  "\t\tmessage: stripInlineDirectiveTagsFromMessageForDisplay(message)",
  "\t};",
  '\tparams.context.broadcast("chat", payload);',
  '\tparams.context.nodeSendToSession(params.sessionKey, "chat", payload);',
  "}",
].join("\n");
const CONTROL_UI_CHAT_PARTIAL_STATE_SEARCH =
  "\t\t\tlet agentRunStarted = false;";
const CONTROL_UI_CHAT_PARTIAL_STATE_REPLACEMENT = [
  "\t\t\tlet agentRunStarted = false;",
  '\t\t\tlet lastPartialText = "";',
  "\t\t\tlet lastPartialBroadcastAt = 0;",
  "\t\t\tconst broadcastWebchatPartial = (payload) => {",
  '\t\t\t\tconst text = typeof payload?.text === "string" ? payload.text : "";',
  "\t\t\t\tif (!text.trim() || text === lastPartialText) return;",
  "\t\t\t\tconst now = Date.now();",
  "\t\t\t\tconst grewEnough = text.length - lastPartialText.length >= 12;",
  "\t\t\t\tconst waitedEnough = now - lastPartialBroadcastAt >= 120;",
  "\t\t\t\tconst shouldReplace = payload?.replace === true;",
  "\t\t\t\tif (!shouldReplace && !grewEnough && !waitedEnough) return;",
  "\t\t\t\tlastPartialText = text;",
  "\t\t\t\tlastPartialBroadcastAt = now;",
  "\t\t\t\tbroadcastChatDelta({",
  "\t\t\t\t\tcontext,",
  "\t\t\t\t\trunId: clientRunId,",
  "\t\t\t\t\tsessionKey,",
  "\t\t\t\t\ttext",
  "\t\t\t\t});",
  "\t\t\t};",
].join("\n");
const CONTROL_UI_CHAT_PARTIAL_REPLY_OPTIONS_SEARCH = [
  "\t\t\t\t\timageOrder: parsedImageOrder.length > 0 ? parsedImageOrder : void 0,",
  "\t\t\t\t\tonAgentRunStart: (runId) => {",
].join("\n");
const CONTROL_UI_CHAT_PARTIAL_REPLY_OPTIONS_REPLACEMENT = [
  "\t\t\t\t\timageOrder: parsedImageOrder.length > 0 ? parsedImageOrder : void 0,",
  "\t\t\t\t\tonPartialReply: broadcastWebchatPartial,",
  "\t\t\t\t\tonAgentRunStart: (runId) => {",
].join("\n");
const MODELS_CONFIG_BUNDLE_PATTERN = /^models-config-.*\.js$/u;
const MODELS_CONFIG_FINGERPRINT_SEARCH = [
  "async function buildModelsJsonFingerprint(params) {",
  '\tconst authProfilesMtimeMs = await readFileMtimeMs(path.join(params.agentDir, "auth-profiles.json"));',
  '\tconst modelsFileMtimeMs = await readFileMtimeMs(path.join(params.agentDir, "models.json"));',
  "\tconst envShape = createConfigRuntimeEnv(params.config, {});",
  "\treturn stableStringify({",
  "\t\tconfig: params.config,",
  "\t\tsourceConfigForSecrets: params.sourceConfigForSecrets,",
  "\t\tenvShape,",
  "\t\tauthProfilesMtimeMs,",
  "\t\tmodelsFileMtimeMs",
  "\t});",
  "}",
].join("\n");
const MODELS_CONFIG_FINGERPRINT_REPLACEMENT = [
  "async function readFileRawForFingerprint(pathname) {",
  "\ttry {",
  '\t\treturn await fs.readFile(pathname, "utf8");',
  "\t} catch {",
  "\t\treturn null;",
  "\t}",
  "}",
  "async function buildModelsJsonFingerprint(params) {",
  '\tconst authProfilesRaw = await readFileRawForFingerprint(path.join(params.agentDir, "auth-profiles.json"));',
  '\tconst modelsFileRaw = await readFileRawForFingerprint(path.join(params.agentDir, "models.json"));',
  "\tconst envShape = createConfigRuntimeEnv(params.config, {});",
  "\treturn stableStringify({",
  "\t\tconfig: params.config,",
  "\t\tsourceConfigForSecrets: params.sourceConfigForSecrets,",
  "\t\tenvShape,",
  "\t\tauthProfilesRaw,",
  "\t\tmodelsFileRaw",
  "\t});",
  "}",
].join("\n");
const GEMINI_NORMALIZE_IMPORT_ANCHOR =
  'import { t as getProviderEnvVars } from "./provider-env-vars-';
const GEMINI_NORMALIZE_IMPORT_ADDITION =
  '\nimport { c as _normalizeGeminiToolSchemas } from "./provider-tools-BS6kZHpt.js";';
const GEMINI_NORMALIZE_FUNC_SEARCH = [
  "\treturn Array.isArray(pluginNormalized) ? pluginNormalized : params.tools;",
  "}",
  "/**",
  "* Logs provider-owned tool-schema diagnostics after normalization.",
].join("\n");
const GEMINI_NORMALIZE_FUNC_REPLACEMENT = [
  "\tif (Array.isArray(pluginNormalized)) return pluginNormalized;",
  '\tif (/gemini/i.test(params.modelId ?? "")) {',
  "\t\treturn _normalizeGeminiToolSchemas({ tools: params.tools });",
  "\t}",
  "\treturn params.tools;",
  "}",
  "/**",
  "* Logs provider-owned tool-schema diagnostics after normalization.",
].join("\n");
const PLUGIN_SDK_BUNDLE_PATTERNS = [/^reply-.*\.js$/u, /^dispatch-.*\.js$/u];
const CORE_DIST_REPLY_BUNDLE_PATTERNS = [
  /^reply-.*\.js$/u,
  /^dispatch-.*\.js$/u,
];
const FEISHU_MONITOR_BUNDLE_PATTERNS = [/^monitor-.*\.js$/u];
const FEISHU_MONITOR_ONERROR_SEARCH = [
  "params.runtime.error?.(`feishu[${account.accountId}] ${info.kind} reply failed: ${String(error)}`);",
  "\t\t\tawait closeStreaming();",
  "\t\t\ttypingCallbacks?.onIdle?.();",
].join("\n");
const FEISHU_MONITOR_ONERROR_REPLACEMENT = [
  "params.runtime.error?.(`feishu[${account.accountId}] ${info.kind} reply failed: ${String(error)}`);",
  '\t\t\ttry { params.runtime.log?.(`NEXU_EVENT channel.reply_outcome ${JSON.stringify({ channel: "feishu", status: "failed", reasonCode: info.kind + "_reply_failed", accountId: account.accountId, chatId, replyToMessageId, threadId: rootId, error: error instanceof Error ? error.message : String(error), ts: new Date().toISOString() })}`); } catch {}',
  "\t\t\tawait closeStreaming();",
  "\t\t\ttypingCallbacks?.onIdle?.();",
].join("\n");
const FEISHU_PRE_LLM_SINGLE_AGENT_SEARCH = `
      // --- Single-agent dispatch (existing behavior) ---
      const ctxPayload = buildCtxPayloadForAgent(
        route.sessionKey,
        route.accountId,
        ctx.mentionedBot,
      );
`.trim();
const FEISHU_SYNTHETIC_PRE_LLM_LINES = [
  "      const syntheticFailureTriggerPrefix = process.env.NEXU_FEISHU_TEST_TRIGGER_PREFIX?.trim();",
  "      if (syntheticFailureTriggerPrefix && ctx.content.includes(syntheticFailureTriggerPrefix)) {",
  "        const syntheticInput = ctx.content.slice(ctx.content.indexOf(syntheticFailureTriggerPrefix) + syntheticFailureTriggerPrefix.length).trim();",
  "        // TODO: Trace the actual runtime execution path for synthetic failures; the staged src patch is applied, but the live fallback path still appears to bypass this exact branch in some runs.",
  "        runtime.log?.(`NEXU_EVENT channel.reply_outcome ${JSON.stringify({",
  '          channel: "feishu",',
  '          status: "failed",',
  '          reasonCode: "synthetic_pre_llm_failure",',
  "          accountId: account.accountId,",
  "          chatId: ctx.chatId,",
  "          replyToMessageId: replyTargetMessageId,",
  "          threadId: ctx.rootId,",
  "          sessionKey: route.sessionKey,",
  "          syntheticInput,",
  '          error: "synthetic pre-llm failure",',
  "          ts: new Date().toISOString(),",
  "        })}`);",
  "        log(",
  "          `feishu[${account.accountId}]: synthetic pre-llm failure triggered (session=${route.sessionKey})`,",
  "        );",
  "        return;",
  "      }",
];
const FEISHU_SYNTHETIC_PRE_LLM_BLOCK =
  FEISHU_SYNTHETIC_PRE_LLM_LINES.join("\n");
const FEISHU_PRE_LLM_SINGLE_AGENT_REPLACEMENT = [
  "      // --- Single-agent dispatch (existing behavior) ---",
  "      const ctxPayload = buildCtxPayloadForAgent(",
  "        route.sessionKey,",
  "        route.accountId,",
  "        ctx.mentionedBot,",
  "      );",
  ...FEISHU_SYNTHETIC_PRE_LLM_LINES,
].join("\n");
const LEGACY_FEISHU_TRIGGER_CALLSITE = `
        accountId: account.accountId,
        syntheticFailureTriggerText: ctx.content,
        messageCreateTimeMs,
`.trim();
const LEGACY_FEISHU_TRIGGER_CALLSITE_REPLACEMENT = `
        accountId: account.accountId,
        messageCreateTimeMs,
`.trim();
const LEGACY_FEISHU_PRE_LLM_BLOCK = [
  '                if (ctx.content.includes("__fail_reply__")) {',
  "        runtime.log?.(`NEXU_EVENT channel.reply_outcome ${JSON.stringify({",
  '          channel: "feishu",',
  '          status: "failed",',
  '          reasonCode: "synthetic_pre_llm_failure",',
  "          accountId: account.accountId,",
  "          chatId: ctx.chatId,",
  "          replyToMessageId: replyTargetMessageId,",
  "          threadId: ctx.rootId,",
  "          sessionKey: route.sessionKey,",
  '          error: "synthetic pre-llm failure",',
  "          ts: new Date().toISOString(),",
  "        })}`);",
  "        log(",
  "          `feishu[${account.accountId}]: synthetic pre-llm failure triggered (session=${route.sessionKey})`,",
  "        );",
  "        return;",
  "      }",
  "",
].join("\n");
const LEGACY_FEISHU_SINGLE_AGENT_TRIGGER_BLOCK = [
  '      if (ctx.content.includes("__fail_reply__")) {',
  "        runtime.log?.(`NEXU_EVENT channel.reply_outcome ${JSON.stringify({",
  '          channel: "feishu",',
  '          status: "failed",',
  '          reasonCode: "synthetic_pre_llm_failure",',
  "          accountId: account.accountId,",
  "          chatId: ctx.chatId,",
  "          replyToMessageId: replyTargetMessageId,",
  "          threadId: ctx.rootId,",
  "          sessionKey: route.sessionKey,",
  '          error: "synthetic pre-llm failure",',
  "          ts: new Date().toISOString(),",
  "        })}`);",
  "        log(",
  "          `feishu[${account.accountId}]: synthetic pre-llm failure triggered (session=${route.sessionKey})`,",
  "        );",
  "        return;",
  "      }",
].join("\n");
const sidecarRoot = getSidecarRoot("openclaw");
const sidecarBinDir = resolve(sidecarRoot, "bin");
const sidecarNodeModules = resolve(sidecarRoot, "node_modules");
const packagedOpenclawEntry = resolve(
  sidecarNodeModules,
  "openclaw/openclaw.mjs",
);
const inheritEntitlementsPath = resolve(
  electronRoot,
  "build/entitlements.mac.inherit.plist",
);
const shouldArchiveOpenclawSidecar = (() => {
  const envVal = process.env.NEXU_DESKTOP_ARCHIVE_OPENCLAW_SIDECAR;
  if (envVal === "0" || envVal?.toLowerCase() === "false") return false;
  if (envVal === "1" || envVal?.toLowerCase() === "true") return true;
  // Archive on all platforms. On Windows, shipping ~95k raw node_modules
  // files forces NSIS to move each file individually through Defender's
  // real-time scanner, which measured ~15min for a 1GB payload on a fresh
  // install. A single LZMA2-compressed payload.7z lets us ship one sealed
  // ~200MB blob that both the installer and Defender can treat as one unit,
  // bringing end-to-end install time under 2min.
  return true;
})();
const shouldReuseExistingOpenclawSidecar =
  process.env.NEXU_DESKTOP_USE_EXISTING_OPENCLAW_SIDECAR === "1" ||
  process.env.NEXU_DESKTOP_USE_EXISTING_OPENCLAW_SIDECAR?.toLowerCase() ===
    "true";
const openclawSidecarCacheRoot = resolve(
  repoRoot,
  ".tmp",
  "sidecar-cache",
  `${process.platform}-${process.arch}`,
  "openclaw",
);

const openclawSidecarFingerprintInputs = [
  resolve(openclawRuntimeRoot, "package.json"),
  resolve(openclawRuntimeRoot, "package-lock.json"),
  resolve(openclawRuntimeRoot, ".postinstall-cache.json"),
  resolve(openclawRuntimeRoot, "postinstall.mjs"),
  resolve(openclawRuntimeRoot, "postinstall-cache.mjs"),
  resolve(openclawRuntimeRoot, "prune-runtime.mjs"),
  resolve(openclawRuntimeRoot, "prune-runtime-paths.mjs"),
  resolve(repoRoot, "apps/desktop/scripts/prepare-openclaw-sidecar.mjs"),
  resolve(repoRoot, "apps/desktop/scripts/lib/sidecar-paths.mjs"),
];

function getPackagedOpenclawEntry(targetSidecarRoot) {
  return resolve(
    targetSidecarRoot,
    "node_modules",
    "openclaw",
    "openclaw.mjs",
  );
}

function getSidecarBinDir(targetSidecarRoot) {
  return resolve(targetSidecarRoot, "bin");
}

async function hashPath(hash, absolutePath, label) {
  if (!(await pathExists(absolutePath))) {
    hash.update(label);
    hash.update("\0missing\0");
    return;
  }

  const stats = await lstat(absolutePath);
  if (stats.isDirectory()) {
    hash.update(label);
    hash.update("\0dir\0");
    const entries = (await readdir(absolutePath)).sort();
    for (const entry of entries) {
      await hashPath(hash, resolve(absolutePath, entry), `${label}/${entry}`);
    }
    return;
  }

  hash.update(label);
  hash.update("\0file\0");
  hash.update(await readFile(absolutePath));
  hash.update("\0");
}

async function computeOpenclawSidecarFingerprint() {
  const hash = createHash("sha256");
  hash.update(process.platform);
  hash.update("\0");
  hash.update(process.arch);
  hash.update("\0");

  for (const absolutePath of openclawSidecarFingerprintInputs) {
    await hashPath(hash, absolutePath, relative(repoRoot, absolutePath));
  }

  await hashPath(
    hash,
    openclawPackagePatchRoot,
    relative(repoRoot, openclawPackagePatchRoot),
  );

  return hash.digest("hex");
}

async function writeSidecarMetadataAndLaunchers(targetSidecarRoot, fingerprint) {
  const targetSidecarNodeModules = resolve(targetSidecarRoot, "node_modules");
  const targetSidecarBinDir = getSidecarBinDir(targetSidecarRoot);
  const targetPackagedOpenclawEntry = getPackagedOpenclawEntry(targetSidecarRoot);

  await mkdir(targetSidecarBinDir, { recursive: true });
  await chmod(targetPackagedOpenclawEntry, 0o755).catch(() => null);
  await writeFile(
    resolve(targetSidecarRoot, "package.json"),
    '{\n  "name": "openclaw-sidecar",\n  "private": true\n}\n',
  );
  await writeFile(
    resolve(targetSidecarRoot, "metadata.json"),
    `${JSON.stringify(
      {
        strategy: "sidecar-node-modules",
        openclawEntry: targetPackagedOpenclawEntry,
        fingerprint,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    resolve(targetSidecarBinDir, "openclaw.cmd"),
    `@echo off\r\nnode "${targetPackagedOpenclawEntry}" %*\r\n`,
  );

  const wrapperPath = resolve(targetSidecarBinDir, "openclaw");
  await writeFile(
    wrapperPath,
    `#!/bin/sh
set -eu

case "$0" in
  */*) script_parent="\${0%/*}" ;;
  *) script_parent="." ;;
esac

script_dir="$(CDPATH= cd -- "$script_parent" && pwd)"
sidecar_root="$(CDPATH= cd -- "$script_dir/.." && pwd)"
entry="$sidecar_root/node_modules/openclaw/openclaw.mjs"

if command -v node >/dev/null 2>&1; then
  exec node "$entry" "$@"
fi

if [ -n "\${OPENCLAW_ELECTRON_EXECUTABLE:-}" ] && [ -x "$OPENCLAW_ELECTRON_EXECUTABLE" ]; then
  ELECTRON_RUN_AS_NODE=1 exec "$OPENCLAW_ELECTRON_EXECUTABLE" "$entry" "$@"
fi

contents_dir="$(CDPATH= cd -- "$sidecar_root/../../.." && pwd)"
macos_dir="$contents_dir/MacOS"

if [ -d "$macos_dir" ]; then
  for candidate in "$macos_dir"/*; do
    if [ -f "$candidate" ] && [ -x "$candidate" ]; then
      ELECTRON_RUN_AS_NODE=1 exec "$candidate" "$entry" "$@"
    fi
  done
fi

echo "openclaw launcher could not find node or a bundled Electron executable" >&2
exit 127
`,
    "utf8",
  );
  await chmod(wrapperPath, 0o755).catch(() => null);
  await removePathIfExists(resolve(targetSidecarNodeModules, "electron"));
  await removePathIfExists(
    resolve(targetSidecarNodeModules, "electron-builder"),
  );
}

async function hasReusableOpenclawSidecarCache(expectedFingerprint) {
  const cacheMetadataPath = resolve(openclawSidecarCacheRoot, "metadata.json");
  const cachedOpenclawEntry = getPackagedOpenclawEntry(openclawSidecarCacheRoot);
  if (
    !(await pathExists(cacheMetadataPath)) ||
    !(await pathExists(cachedOpenclawEntry))
  ) {
    return false;
  }

  try {
    const metadata = JSON.parse(await readFile(cacheMetadataPath, "utf8"));
    return metadata?.fingerprint === expectedFingerprint;
  } catch {
    return false;
  }
}

async function hasReusableOpenclawSidecarRoot(expectedFingerprint) {
  const metadataPath = resolve(sidecarRoot, "metadata.json");
  if (
    !(await pathExists(metadataPath)) ||
    !(await pathExists(packagedOpenclawEntry))
  ) {
    return false;
  }

  try {
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    return metadata?.fingerprint === expectedFingerprint;
  } catch {
    return false;
  }
}

async function restoreCachedOpenclawSidecar(fingerprint) {
  await removePathIfExists(sidecarRoot);
  await cp(openclawSidecarCacheRoot, sidecarRoot, {
    recursive: true,
    dereference: true,
    force: true,
  });
  await writeSidecarMetadataAndLaunchers(sidecarRoot, fingerprint);
}

async function updateOpenclawSidecarCache(fingerprint) {
  await removePathIfExists(openclawSidecarCacheRoot);
  await cp(sidecarRoot, openclawSidecarCacheRoot, {
    recursive: true,
    dereference: true,
    force: true,
  });
  await writeSidecarMetadataAndLaunchers(openclawSidecarCacheRoot, fingerprint);
}

function formatDurationMs(durationMs) {
  return `${(durationMs / 1000).toFixed(2)}s`;
}

async function timedStep(stepName, fn) {
  const startedAt = performance.now();
  console.log(`[openclaw-sidecar][timing] start ${stepName}`);
  try {
    return await fn();
  } finally {
    console.log(
      `[openclaw-sidecar][timing] done ${stepName} duration=${formatDurationMs(
        performance.now() - startedAt,
      )}`,
    );
  }
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? electronRoot,
      env: options.env ?? process.env,
      stdio: "inherit",
    });

    child.once("error", rejectRun);
    child.once("exit", (code) => {
      if (code === 0) {
        resolveRun();
        return;
      }

      rejectRun(
        new Error(
          `${command} ${args.join(" ")} exited with code ${code ?? "null"}.`,
        ),
      );
    });
  });
}

async function runAndCapture(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd: options.cwd ?? electronRoot,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      if (code === 0) {
        resolveRun({ stdout, stderr });
        return;
      }

      rejectRun(
        new Error(
          `${command} ${args.join(" ")} exited with code ${code ?? "null"}. ${stderr}`,
        ),
      );
    });
  });
}

async function robustRename(source, dest) {
  try {
    await rename(source, dest);
  } catch (err) {
    if (process.platform !== "win32" || err.code !== "EPERM") throw err;
    await cp(source, dest, { recursive: true, dereference: true });
    await rm(source, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 200,
    });
  }
}

async function collectFiles(rootPath) {
  const files = [];
  const entries = await readdir(rootPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = resolve(rootPath, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(entryPath)));
      continue;
    }

    if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

async function createZipArchive(sourceRoot, archivePath) {
  const { ZipFile } = require("yazl");
  const zipFile = new ZipFile();
  const output = createWriteStream(archivePath);
  const done = new Promise((resolveZip, rejectZip) => {
    zipFile.outputStream.on("error", rejectZip);
    output.on("error", rejectZip);
    output.on("close", resolveZip);
  });

  zipFile.outputStream.pipe(output);
  for (const filePath of await collectFiles(sourceRoot)) {
    zipFile.addFile(
      filePath,
      relative(sourceRoot, filePath).replace(/\\/g, "/"),
    );
  }
  zipFile.end();

  await done;
}

/**
 * LZMA2-compressed 7z archive produced via the `7za.exe` bundled by 7zip-bin.
 * Used on Windows where a single sealed archive dramatically reduces NSIS
 * install time compared to shipping 95k raw node_modules files. See
 * prepare-openclaw-sidecar.mjs shouldArchiveOpenclawSidecar for rationale.
 */
async function create7zArchive(sourceRoot, archivePath) {
  const { path7za } = require("7zip-bin");
  // -t7z   : 7z container
  // -m0=lzma2 / -mx=7 : LZMA2 level 7 (good ratio without burning CPU for hours)
  // -mmt=on: multi-threaded compression
  // -y     : assume yes on prompts (e.g. overwrite)
  // -r     : recurse
  await run(
    path7za,
    [
      "a",
      "-t7z",
      "-m0=lzma2",
      "-mx=7",
      "-mmt=on",
      "-y",
      "-r",
      archivePath,
      "*",
    ],
    { cwd: sourceRoot },
  );
}

const nativeBinaryNamePattern = /\.(?:node|dylib|so|dll)$/u;
const nativeBinaryBasenames = new Set(["spawn-helper"]);

function isNativeBinaryCandidate(filePath) {
  const baseName = basename(filePath);
  return (
    nativeBinaryNamePattern.test(baseName) ||
    nativeBinaryBasenames.has(baseName)
  );
}

async function resolveCodesignIdentity() {
  const { stdout } = await runAndCapture("security", [
    "find-identity",
    "-v",
    "-p",
    "codesigning",
  ]);
  const identityLine = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.includes("Developer ID Application:"));

  if (!identityLine) {
    throw new Error(
      "Unable to locate a Developer ID Application signing identity.",
    );
  }

  const match = identityLine.match(/"([^"]+)"/u);
  if (!match) {
    throw new Error(`Unable to parse signing identity from: ${identityLine}`);
  }

  return match[1];
}

function getSigningCertificatePath() {
  const link = process.env.CSC_LINK;

  if (!link) {
    return null;
  }

  return link.startsWith("file://") ? fileURLToPath(link) : link;
}

async function ensureCodesignIdentity() {
  try {
    return await resolveCodesignIdentity();
  } catch {
    const certificatePath = getSigningCertificatePath();
    const certificatePassword = process.env.CSC_KEY_PASSWORD;

    if (!certificatePath || !certificatePassword) {
      throw new Error(
        "Unable to locate a Developer ID Application signing identity.",
      );
    }

    const keychainPath = resolve(tmpdir(), "nexu-openclaw-signing.keychain-db");
    const keychainPassword = "nexu-openclaw-signing";

    await run("security", [
      "create-keychain",
      "-p",
      keychainPassword,
      keychainPath,
    ]).catch(() => null);
    await run("security", [
      "set-keychain-settings",
      "-lut",
      "21600",
      keychainPath,
    ]);
    await run("security", [
      "unlock-keychain",
      "-p",
      keychainPassword,
      keychainPath,
    ]);
    await run("security", [
      "import",
      certificatePath,
      "-k",
      keychainPath,
      "-P",
      certificatePassword,
      "-T",
      "/usr/bin/codesign",
      "-T",
      "/usr/bin/security",
    ]);
    await run("security", [
      "set-key-partition-list",
      "-S",
      "apple-tool:,apple:,codesign:",
      "-s",
      "-k",
      keychainPassword,
      keychainPath,
    ]);

    const { stdout: keychainsOutput } = await runAndCapture("security", [
      "list-keychains",
      "-d",
      "user",
    ]);
    const keychains = keychainsOutput
      .split(/\r?\n/u)
      .map((line) => line.trim().replace(/^"|"$/gu, ""))
      .filter(Boolean);
    if (!keychains.includes(keychainPath)) {
      await run("security", [
        "list-keychains",
        "-d",
        "user",
        "-s",
        keychainPath,
        ...keychains,
      ]);
    }

    return await resolveCodesignIdentity();
  }
}

async function signOpenclawNativeBinaries() {
  if (process.platform !== "darwin") {
    return;
  }

  const unsignedMode =
    process.env.NEXU_DESKTOP_MAC_UNSIGNED === "1" ||
    process.env.NEXU_DESKTOP_MAC_UNSIGNED === "true";

  if (unsignedMode || !shouldCopyRuntimeDependencies()) {
    return;
  }

  const startedAt = Date.now();
  const identity = await ensureCodesignIdentity();
  const files = await collectFiles(sidecarRoot);
  const candidateFiles = files.filter(isNativeBinaryCandidate);
  let machOCount = 0;

  console.log(
    `[openclaw-sidecar] scanning ${candidateFiles.length} native-binary candidates out of ${files.length} files`,
  );

  for (const filePath of candidateFiles) {
    const { stdout } = await runAndCapture("file", ["-b", filePath]);
    const description = stdout.trim();
    const isMachO = description.includes("Mach-O");

    if (!isMachO) {
      continue;
    }

    machOCount += 1;

    const isExecutable =
      description.includes("executable") || description.includes("bundle");
    const args = [
      "--force",
      "--sign",
      identity,
      "--timestamp",
      "--entitlements",
      inheritEntitlementsPath,
      ...(isExecutable ? ["--options", "runtime"] : []),
      filePath,
    ];
    await run("codesign", args);
  }

  console.log(
    `[openclaw-sidecar] signed ${machOCount} native binaries in ${formatDurationMs(
      Date.now() - startedAt,
    )}`,
  );
}

async function applyOpenclawRuntimePatches() {
  const patchedFiles = new Map();

  if (!(await pathExists(openclawPackagePatchRoot))) {
    return patchedFiles;
  }

  const patchFiles = await collectFiles(openclawPackagePatchRoot);

  for (const patchFilePath of patchFiles) {
    const patchFileRelativePath = relative(
      openclawPackagePatchRoot,
      patchFilePath,
    );
    patchedFiles.set(
      patchFileRelativePath,
      await readFile(patchFilePath, "utf8"),
    );
  }

  if (patchFiles.length > 0) {
    console.log(
      `[openclaw-sidecar] prepared ${patchFiles.length} runtime patch overlay(s) from ${openclawPackagePatchRoot}`,
    );
  }

  return patchedFiles;
}

function applyExactReplacement(
  source,
  search,
  replacement,
  label,
  { optional = false } = {},
) {
  if (!source.includes(search)) {
    if (optional) {
      console.warn(
        `[openclaw-sidecar] patch anchor not found (skipped): ${label}`,
      );
      return source;
    }
    throw new Error(`Unable to locate patch anchor for ${label}.`);
  }
  return source.replace(search, replacement);
}

function countOccurrences(source, search) {
  if (search.length === 0) {
    return 0;
  }

  let count = 0;
  let index = 0;
  while (true) {
    const nextIndex = source.indexOf(search, index);
    if (nextIndex === -1) {
      return count;
    }
    count += 1;
    index = nextIndex + search.length;
  }
}

async function patchReplyOutcomeBridge(openclawPackageRoot) {
  const patchedFiles = new Map();
  const feishuBotPath = resolve(
    openclawPackageRoot,
    "extensions",
    "feishu",
    "src",
    "bot.ts",
  );
  const hasFeishuBotSource = await pathExists(feishuBotPath);

  if (hasFeishuBotSource) {
    let feishuBotSource = await readFile(feishuBotPath, "utf8");

    if (feishuBotSource.includes(LEGACY_FEISHU_PRE_LLM_BLOCK)) {
      feishuBotSource = feishuBotSource.replaceAll(
        LEGACY_FEISHU_PRE_LLM_BLOCK,
        "",
      );
    }

    if (feishuBotSource.includes(LEGACY_FEISHU_SINGLE_AGENT_TRIGGER_BLOCK)) {
      feishuBotSource = feishuBotSource.replaceAll(
        LEGACY_FEISHU_SINGLE_AGENT_TRIGGER_BLOCK,
        FEISHU_PRE_LLM_SINGLE_AGENT_REPLACEMENT,
      );
    }

    if (feishuBotSource.includes(LEGACY_FEISHU_TRIGGER_CALLSITE)) {
      feishuBotSource = feishuBotSource.replaceAll(
        LEGACY_FEISHU_TRIGGER_CALLSITE,
        LEGACY_FEISHU_TRIGGER_CALLSITE_REPLACEMENT,
      );
    }

    if (feishuBotSource.includes(FEISHU_SYNTHETIC_PRE_LLM_BLOCK)) {
      feishuBotSource = feishuBotSource.replaceAll(
        FEISHU_SYNTHETIC_PRE_LLM_BLOCK,
        "",
      );
    }

    if (feishuBotSource.includes(FEISHU_PRE_LLM_SINGLE_AGENT_SEARCH)) {
      feishuBotSource = feishuBotSource.replace(
        FEISHU_PRE_LLM_SINGLE_AGENT_SEARCH,
        FEISHU_PRE_LLM_SINGLE_AGENT_REPLACEMENT,
      );
      console.log(
        "[openclaw-sidecar] patched feishu single-agent pre-llm trigger",
      );
    }

    if (
      countOccurrences(feishuBotSource, FEISHU_SYNTHETIC_PRE_LLM_BLOCK) !== 1
    ) {
      throw new Error(
        "Feishu bot patch did not converge to a single synthetic pre-llm block.",
      );
    }

    if (
      feishuBotSource.includes("return;\n      }\n        route.sessionKey,")
    ) {
      throw new Error(
        "Feishu bot patch left a dangling buildCtxPayloadForAgent argument tail.",
      );
    }

    patchedFiles.set(
      relative(openclawPackageRoot, feishuBotPath),
      feishuBotSource,
    );
  } else {
    console.warn(
      "[openclaw-sidecar] feishu bot source not found (pre-compiled extension), skipping source-level patches",
    );
  }

  const patchBundleGroup = async (bundleDir, patterns, label) => {
    let entries;
    try {
      entries = await readdir(bundleDir);
    } catch {
      console.warn(
        `[openclaw-sidecar] bundle directory not found (skipped): ${label}`,
      );
      return;
    }
    const bundleNames = entries.filter((entry) =>
      patterns.some((pattern) => pattern.test(entry)),
    );

    if (bundleNames.length === 0) {
      console.warn(
        `[openclaw-sidecar] no matching bundles found for ${label} (skipped)`,
      );
      return;
    }

    for (const bundleName of bundleNames) {
      const bundlePath = resolve(bundleDir, bundleName);
      let source = await readFile(bundlePath, "utf8");
      let patchCount = 0;

      if (!source.includes("NEXU_EVENT channel.reply_outcome")) {
        const hasHelper = source.includes(REPLY_OUTCOME_HELPER_SEARCH);
        const hasSilent = source.includes(REPLY_OUTCOME_SILENT_SEARCH);
        const hasError = source.includes(REPLY_OUTCOME_ERROR_SEARCH);

        if (hasHelper && hasSilent && hasError) {
          source = applyExactReplacement(
            source,
            REPLY_OUTCOME_HELPER_SEARCH,
            REPLY_OUTCOME_HELPER_REPLACEMENT,
            `${bundleName}: reply outcome helper`,
          );

          source = applyExactReplacement(
            source,
            REPLY_OUTCOME_SILENT_SEARCH,
            REPLY_OUTCOME_SILENT_REPLACEMENT,
            `${bundleName}: silent outcome emit`,
          );

          source = applyExactReplacement(
            source,
            REPLY_OUTCOME_ERROR_SEARCH,
            REPLY_OUTCOME_ERROR_REPLACEMENT,
            `${bundleName}: error outcome emit`,
          );

          patchCount += 3;
          console.log(
            `[openclaw-sidecar] patched reply outcome bridge in ${bundleName}`,
          );
        } else if (hasHelper || hasSilent || hasError) {
          console.warn(
            `[openclaw-sidecar] partial reply outcome anchors in ${bundleName} (helper=${hasHelper}, silent=${hasSilent}, error=${hasError}), skipping reply outcome bridge`,
          );
        }
      }

      if (source.includes(FEISHU_ERROR_REPLY_SUPPRESS_GUARD_SEARCH)) {
        source = applyExactReplacement(
          source,
          FEISHU_ERROR_REPLY_SUPPRESS_GUARD_SEARCH,
          FEISHU_ERROR_REPLY_SUPPRESS_GUARD_REPLACEMENT,
          `${bundleName}: feishu error reply suppress guard`,
        );

        patchCount += 1;
        console.log(
          `[openclaw-sidecar] patched feishu error final suppression in ${bundleName}`,
        );
      }

      if (source.includes(CORE_EMBEDDED_PAYLOAD_MESSAGE_CHANNEL_SEARCH)) {
        source = applyExactReplacement(
          source,
          CORE_EMBEDDED_PAYLOAD_MESSAGE_CHANNEL_SEARCH,
          CORE_EMBEDDED_PAYLOAD_MESSAGE_CHANNEL_REPLACEMENT,
          `${bundleName}: core embedded payload message provider`,
        );

        patchCount += 1;
        console.log(
          `[openclaw-sidecar] patched embedded payload message provider in ${bundleName}`,
        );
      }

      if (
        !source.includes("runResult: { payloads: [] }") &&
        source.includes(FEISHU_PRE_REPLY_FINAL_SEARCH)
      ) {
        source = applyExactReplacement(
          source,
          FEISHU_PRE_REPLY_FINAL_SEARCH,
          FEISHU_PRE_REPLY_FINAL_REPLACEMENT,
          `${bundleName}: feishu pre-reply final suppression`,
        );

        patchCount += 1;
        console.log(
          `[openclaw-sidecar] patched feishu pre-reply final suppression in ${bundleName}`,
        );
      }

      if (patchCount > 0) {
        patchedFiles.set(relative(openclawPackageRoot, bundlePath), source);
      }
    }
  };

  await patchBundleGroup(
    resolve(openclawPackageRoot, "dist", "plugin-sdk"),
    PLUGIN_SDK_BUNDLE_PATTERNS,
    "plugin-sdk reply/dispatch",
  );
  await patchBundleGroup(
    resolve(openclawPackageRoot, "dist"),
    CORE_DIST_REPLY_BUNDLE_PATTERNS,
    "core dist reply",
  );

  const feishuMonitorDir = resolve(openclawPackageRoot, "dist");
  try {
    const monitorEntries = await readdir(feishuMonitorDir);
    const monitorBundles = monitorEntries.filter((entry) =>
      FEISHU_MONITOR_BUNDLE_PATTERNS.some((pattern) => pattern.test(entry)),
    );
    for (const bundleName of monitorBundles) {
      const bundlePath = resolve(feishuMonitorDir, bundleName);
      let source = await readFile(bundlePath, "utf8");
      if (
        source.includes("createFeishuReplyDispatcher") &&
        source.includes(FEISHU_MONITOR_ONERROR_SEARCH)
      ) {
        source = source.replace(
          FEISHU_MONITOR_ONERROR_SEARCH,
          FEISHU_MONITOR_ONERROR_REPLACEMENT,
        );
        patchedFiles.set(relative(openclawPackageRoot, bundlePath), source);
        console.log(
          `[openclaw-sidecar] patched feishu reply_outcome in ${bundleName}`,
        );
      }
    }
  } catch {
    console.warn(
      "[openclaw-sidecar] feishu monitor bundle patching skipped (directory not found)",
    );
  }

  return patchedFiles;
}

async function patchGeminiToolSanitization(openclawPackageRoot) {
  const patchedFiles = new Map();
  const distDir = resolve(openclawPackageRoot, "dist");

  let entries;
  try {
    entries = await readdir(distDir);
  } catch {
    console.warn(
      "[openclaw-sidecar] dist directory not found, skipping Gemini tool sanitization patch",
    );
    return patchedFiles;
  }

  // Primary patch: pi-embedded-yhO3edNd.js (normalizeProviderToolSchemas path)
  // The gateway runtime uses this file, not the bukGSgEe bundle.
  for (const entry of entries) {
    if (!PI_EMBEDDED_BUNDLE_PATTERN.test(entry)) continue;
    const entryPath = resolve(distDir, entry);
    let entrySource;
    try {
      entrySource = await readFile(entryPath, "utf8");
    } catch {
      continue;
    }
    if (!entrySource.includes("function normalizeProviderToolSchemas(")) continue;

    let patched = false;
    if (
      entrySource.includes(GEMINI_NORMALIZE_IMPORT_ANCHOR) &&
      !entrySource.includes("_normalizeGeminiToolSchemas")
    ) {
      const anchorLine = entrySource
        .split("\n")
        .find((l) => l.includes(GEMINI_NORMALIZE_IMPORT_ANCHOR));
      if (anchorLine) {
        entrySource = entrySource.replace(
          anchorLine,
          anchorLine + GEMINI_NORMALIZE_IMPORT_ADDITION,
        );
        patched = true;
      }
    }
    if (entrySource.includes(GEMINI_NORMALIZE_FUNC_SEARCH)) {
      entrySource = applyExactReplacement(
        entrySource,
        GEMINI_NORMALIZE_FUNC_SEARCH,
        GEMINI_NORMALIZE_FUNC_REPLACEMENT,
        `${entry}: normalizeProviderToolSchemas gemini fallback`,
      );
      patched = true;
    }
    if (
      entrySource.includes(PI_EMBEDDED_RUN_QUEUE_TIMING_SEARCH) &&
      !entrySource.includes("[clawpi-run-timing]")
    ) {
      entrySource = applyExactReplacement(
        entrySource,
        PI_EMBEDDED_RUN_QUEUE_TIMING_SEARCH,
        PI_EMBEDDED_RUN_QUEUE_TIMING_REPLACEMENT,
        `${entry}: add embedded run queue timing diagnostics`,
      );
      patched = true;
    }
    if (
      entrySource.includes(PI_EMBEDDED_RUN_STAGE_MARK_SEARCH) &&
      !entrySource.includes("__clawpiMarkRunStage")
    ) {
      entrySource = applyExactReplacement(
        entrySource,
        PI_EMBEDDED_RUN_STAGE_MARK_SEARCH,
        PI_EMBEDDED_RUN_STAGE_MARK_REPLACEMENT,
        `${entry}: add embedded run stage timing diagnostics`,
      );
      patched = true;
    }
    if (entrySource.includes(PI_EMBEDDED_WORKSPACE_MARK_SEARCH)) {
      entrySource = applyExactReplacement(
        entrySource,
        PI_EMBEDDED_WORKSPACE_MARK_SEARCH,
        PI_EMBEDDED_WORKSPACE_MARK_REPLACEMENT,
        `${entry}: mark workspace and runtime plugin timing`,
      );
      patched = true;
    }
    if (entrySource.includes(PI_EMBEDDED_RUNTIME_PLUGINS_MARK_SEARCH)) {
      entrySource = applyExactReplacement(
        entrySource,
        PI_EMBEDDED_RUNTIME_PLUGINS_MARK_SEARCH,
        PI_EMBEDDED_RUNTIME_PLUGINS_MARK_REPLACEMENT,
        `${entry}: mark runtime plugin timing`,
      );
      patched = true;
    }
    if (entrySource.includes(PI_EMBEDDED_MODELS_JSON_MARK_SEARCH)) {
      entrySource = applyExactReplacement(
        entrySource,
        PI_EMBEDDED_MODELS_JSON_MARK_SEARCH,
        PI_EMBEDDED_MODELS_JSON_MARK_REPLACEMENT,
        `${entry}: mark models json timing`,
      );
      patched = true;
    }
    if (entrySource.includes(PI_EMBEDDED_HOOK_SELECTION_MARK_SEARCH)) {
      entrySource = applyExactReplacement(
        entrySource,
        PI_EMBEDDED_HOOK_SELECTION_MARK_SEARCH,
        PI_EMBEDDED_HOOK_SELECTION_MARK_REPLACEMENT,
        `${entry}: mark hook model selection timing`,
      );
      patched = true;
    }
    if (entrySource.includes(PI_EMBEDDED_RESOLVE_MODEL_MARK_SEARCH)) {
      entrySource = applyExactReplacement(
        entrySource,
        PI_EMBEDDED_RESOLVE_MODEL_MARK_SEARCH,
        PI_EMBEDDED_RESOLVE_MODEL_MARK_REPLACEMENT,
        `${entry}: mark resolve model timing`,
      );
      patched = true;
    }
    if (entrySource.includes(PI_EMBEDDED_INIT_AUTH_MARK_SEARCH)) {
      entrySource = applyExactReplacement(
        entrySource,
        PI_EMBEDDED_INIT_AUTH_MARK_SEARCH,
        PI_EMBEDDED_INIT_AUTH_MARK_REPLACEMENT,
        `${entry}: mark auth profile timing`,
      );
      patched = true;
    }
    if (entrySource.includes(PI_EMBEDDED_CONTEXT_ENGINE_MARK_SEARCH)) {
      entrySource = applyExactReplacement(
        entrySource,
        PI_EMBEDDED_CONTEXT_ENGINE_MARK_SEARCH,
        PI_EMBEDDED_CONTEXT_ENGINE_MARK_REPLACEMENT,
        `${entry}: mark context engine timing`,
      );
      patched = true;
    }
    if (entrySource.includes(PI_EMBEDDED_ATTEMPT_MARK_SEARCH)) {
      entrySource = applyExactReplacement(
        entrySource,
        PI_EMBEDDED_ATTEMPT_MARK_SEARCH,
        PI_EMBEDDED_ATTEMPT_MARK_REPLACEMENT,
        `${entry}: mark embedded attempt start timing`,
      );
      patched = true;
    }
    if (entrySource.includes(PI_EMBEDDED_ATTEMPT_READY_MARK_SEARCH)) {
      entrySource = applyExactReplacement(
        entrySource,
        PI_EMBEDDED_ATTEMPT_READY_MARK_SEARCH,
        PI_EMBEDDED_ATTEMPT_READY_MARK_REPLACEMENT,
        `${entry}: mark embedded attempt ready timing`,
      );
      patched = true;
    }
    if (patched) {
      patchedFiles.set(relative(openclawPackageRoot, entryPath), entrySource);
      console.log(
        `[openclaw-sidecar] patched pi-embedded runtime in ${entry}`,
      );
    }
  }

  // Legacy fallback: sanitizeToolsForGoogle patches (bukGSgEe bundle)
  const legacyBundle = entries.find(
    (e) =>
      PI_EMBEDDED_BUNDLE_PATTERN.test(e) && !patchedFiles.has(`dist/${e}`),
  );
  if (legacyBundle) {
    const bundlePath = resolve(distDir, legacyBundle);
    let source = patchedFiles.get(relative(openclawPackageRoot, bundlePath));
    if (!source) {
      try {
        source = await readFile(bundlePath, "utf8");
      } catch {
        source = null;
      }
    }
    if (source) {
      let legacyPatchCount = 0;
      if (source.includes(GEMINI_SANITIZE_COMPACTION_SEARCH)) {
        source = applyExactReplacement(
          source,
          GEMINI_SANITIZE_COMPACTION_SEARCH,
          GEMINI_SANITIZE_COMPACTION_REPLACEMENT,
          `${legacyBundle}: gemini tool sanitization (compaction)`,
        );
        legacyPatchCount += 1;
      }
      if (source.includes(GEMINI_SANITIZE_EMBEDDED_SEARCH)) {
        source = applyExactReplacement(
          source,
          GEMINI_SANITIZE_EMBEDDED_SEARCH,
          GEMINI_SANITIZE_EMBEDDED_REPLACEMENT,
          `${legacyBundle}: gemini tool sanitization (embedded run)`,
        );
        legacyPatchCount += 1;
      }
      if (legacyPatchCount > 0) {
        patchedFiles.set(
          relative(openclawPackageRoot, bundlePath),
          source,
        );
        console.log(
          `[openclaw-sidecar] patched ${legacyPatchCount} legacy sanitizeToolsForGoogle call site(s) in ${legacyBundle}`,
        );
      }
    }
  }

  // Patch provider-tools-*.js: fix type array not collapsed to scalar for Gemini
  for (const entry of entries) {
    if (!/^provider-tools-.*\.js$/.test(entry)) continue;
    const entryPath = resolve(distDir, entry);
    let source;
    try {
      source = await readFile(entryPath, "utf8");
    } catch {
      continue;
    }
    if (!source.includes(GEMINI_TYPE_ARRAY_SEARCH)) continue;
    source = applyExactReplacement(
      source,
      GEMINI_TYPE_ARRAY_SEARCH,
      GEMINI_TYPE_ARRAY_REPLACEMENT,
      `${entry}: collapse type array to scalar for Gemini`,
    );
    patchedFiles.set(relative(openclawPackageRoot, entryPath), source);
    console.log(
      `[openclaw-sidecar] patched type-array collapse in ${entry}`,
    );
  }

  if (patchedFiles.size === 0) {
    console.warn(
      "[openclaw-sidecar] no Gemini tool sanitization anchors found in any pi-embedded bundle (may already be fixed upstream)",
    );
  }

  return patchedFiles;
}

async function patchControlUiGeneratedImageRendering(openclawPackageRoot) {
  const patchedFiles = new Map();
  const distDir = resolve(openclawPackageRoot, "dist");

  let distEntries;
  try {
    distEntries = await readdir(distDir);
  } catch {
    console.warn(
      "[openclaw-sidecar] dist directory not found, skipping Control UI generated image patch",
    );
    return patchedFiles;
  }

  const assetsDir = resolve(distDir, "control-ui", "assets");
  const patchedControlUiBundles = [];
  let assetEntries = [];
  try {
    assetEntries = await readdir(assetsDir);
  } catch {
    console.warn(
      "[openclaw-sidecar] Control UI assets directory not found, skipping generated image patch",
    );
  }

  for (const entry of assetEntries) {
    if (!CONTROL_UI_BUNDLE_PATTERN.test(entry)) continue;
    const entryPath = resolve(assetsDir, entry);
    let source;
    try {
      source = await readFile(entryPath, "utf8");
    } catch {
      continue;
    }

    let patchCount = 0;
    if (source.includes(CONTROL_UI_IMAGE_EXTRACTOR_SEARCH)) {
      source = applyExactReplacement(
        source,
        CONTROL_UI_IMAGE_EXTRACTOR_SEARCH,
        CONTROL_UI_IMAGE_EXTRACTOR_REPLACEMENT,
        `${entry}: generated image media extraction`,
      );
      patchCount += 1;
    }
    if (
      source.includes(CONTROL_UI_TOOL_OUTPUT_DETAILS_SEARCH) &&
      !source.includes(CONTROL_UI_TOOL_OUTPUT_DETAILS_REPLACEMENT)
    ) {
      source = applyExactReplacement(
        source,
        CONTROL_UI_TOOL_OUTPUT_DETAILS_SEARCH,
        CONTROL_UI_TOOL_OUTPUT_DETAILS_REPLACEMENT,
        `${entry}: auto-open media tool output`,
      );
      patchCount += 1;
    }
    if (
      source.includes(CONTROL_UI_NODE_LIST_POLL_SEARCH) ||
      source.includes(CONTROL_UI_NODE_LIST_POLL_60S_SEARCH)
    ) {
      const nodeListPollSearch = source.includes(
        CONTROL_UI_NODE_LIST_POLL_60S_SEARCH,
      )
        ? CONTROL_UI_NODE_LIST_POLL_60S_SEARCH
        : CONTROL_UI_NODE_LIST_POLL_SEARCH;
      source = applyExactReplacement(
        source,
        nodeListPollSearch,
        CONTROL_UI_NODE_LIST_POLL_REPLACEMENT,
        `${entry}: keep Control UI node.list polling responsive`,
      );
      patchCount += 1;
    }

    if (patchCount > 0) {
      patchedFiles.set(relative(openclawPackageRoot, entryPath), source);
      patchedControlUiBundles.push(entry);
      console.log(
        `[openclaw-sidecar] patched Control UI generated image rendering in ${entry}`,
      );
    }
  }

  if (patchedControlUiBundles.length > 0) {
    const indexHtmlPath = resolve(distDir, "control-ui", "index.html");
    let html;
    try {
      html = await readFile(indexHtmlPath, "utf8");
    } catch {
      html = "";
    }

    let updatedHtml = html;
    for (const entry of patchedControlUiBundles) {
      updatedHtml = updatedHtml.replace(
        `src="./assets/${entry}"`,
        `src="./assets/${entry}?clawpi-media=1&clawpi-node-poll=5s"`,
      );
    }
    if (updatedHtml !== html) {
      patchedFiles.set(relative(openclawPackageRoot, indexHtmlPath), updatedHtml);
      console.log(
        "[openclaw-sidecar] patched Control UI entry asset cache key",
      );
    }
  }

  for (const entry of distEntries) {
    if (!/^server\.impl-.*\.js$/u.test(entry)) continue;
    const entryPath = resolve(distDir, entry);
    let source;
    try {
      source = await readFile(entryPath, "utf8");
    } catch {
      continue;
    }
    let patchCount = 0;
    if (source.includes(CONTROL_UI_CSP_IMAGE_SRC_SEARCH)) {
      source = applyExactReplacement(
        source,
        CONTROL_UI_CSP_IMAGE_SRC_SEARCH,
        CONTROL_UI_CSP_IMAGE_SRC_REPLACEMENT,
        `${entry}: allow localhost generated images in Control UI CSP`,
      );
      patchCount += 1;
    }
    if (source.includes(CONTROL_UI_NODE_LIST_HANDLER_SEARCH)) {
      source = applyExactReplacement(
        source,
        CONTROL_UI_NODE_LIST_HANDLER_SEARCH,
        CONTROL_UI_NODE_LIST_HANDLER_REPLACEMENT,
        `${entry}: timeout slow node.list for Control UI`,
      );
      patchCount += 1;
    }
    if (source.includes(CONTROL_UI_DEVICE_PAIR_LIST_HANDLER_SEARCH)) {
      source = applyExactReplacement(
        source,
        CONTROL_UI_DEVICE_PAIR_LIST_HANDLER_SEARCH,
        CONTROL_UI_DEVICE_PAIR_LIST_HANDLER_REPLACEMENT,
        `${entry}: timeout slow device.pair.list for Control UI`,
      );
      patchCount += 1;
    }
    if (source.includes(CONTROL_UI_MODELS_LIST_HANDLER_SEARCH)) {
      source = applyExactReplacement(
        source,
        CONTROL_UI_MODELS_LIST_HANDLER_SEARCH,
        CONTROL_UI_MODELS_LIST_HANDLER_REPLACEMENT,
        `${entry}: return configured models before slow catalog refresh`,
      );
      patchCount += 1;
    }
    if (source.includes(CONTROL_UI_CHAT_HISTORY_THINKING_SEARCH)) {
      source = applyExactReplacement(
        source,
        CONTROL_UI_CHAT_HISTORY_THINKING_SEARCH,
        CONTROL_UI_CHAT_HISTORY_THINKING_REPLACEMENT,
        `${entry}: avoid model catalog wait in chat.history`,
      );
      patchCount += 1;
    }
    if (source.includes(CONTROL_UI_CHAT_HISTORY_DETAILS_STRIP_SEARCH)) {
      source = applyExactReplacement(
        source,
        CONTROL_UI_CHAT_HISTORY_DETAILS_STRIP_SEARCH,
        CONTROL_UI_CHAT_HISTORY_DETAILS_STRIP_REPLACEMENT,
        `${entry}: preserve generated image media for Control UI history`,
      );
      patchCount += 1;
    }
    if (
      source.includes(CONTROL_UI_CHAT_FINAL_BROADCAST_SEARCH) &&
      !source.includes("function broadcastChatDelta(params)")
    ) {
      source = applyExactReplacement(
        source,
        CONTROL_UI_CHAT_FINAL_BROADCAST_SEARCH,
        CONTROL_UI_CHAT_FINAL_BROADCAST_REPLACEMENT,
        `${entry}: add WebChat partial reply broadcast helper`,
      );
      patchCount += 1;
    }
    if (
      source.includes(CONTROL_UI_CHAT_PARTIAL_STATE_SEARCH) &&
      !source.includes("const broadcastWebchatPartial = (payload) =>")
    ) {
      source = applyExactReplacement(
        source,
        CONTROL_UI_CHAT_PARTIAL_STATE_SEARCH,
        CONTROL_UI_CHAT_PARTIAL_STATE_REPLACEMENT,
        `${entry}: add WebChat partial reply throttle`,
      );
      patchCount += 1;
    }
    if (
      source.includes(CONTROL_UI_CHAT_PARTIAL_REPLY_OPTIONS_SEARCH) &&
      source.includes("const broadcastWebchatPartial = (payload) =>") &&
      !source.includes("onPartialReply: broadcastWebchatPartial")
    ) {
      source = applyExactReplacement(
        source,
        CONTROL_UI_CHAT_PARTIAL_REPLY_OPTIONS_SEARCH,
        CONTROL_UI_CHAT_PARTIAL_REPLY_OPTIONS_REPLACEMENT,
        `${entry}: stream partial replies to Control UI only`,
      );
      patchCount += 1;
    }
    if (patchCount > 0) {
      patchedFiles.set(relative(openclawPackageRoot, entryPath), source);
      console.log(
        `[openclaw-sidecar] patched Control UI server behavior in ${entry}`,
      );
    }
  }

  if (patchedFiles.size === 0) {
    console.warn(
      "[openclaw-sidecar] no Control UI generated image anchors found (may already be fixed upstream)",
    );
  }

  return patchedFiles;
}

async function patchModelsConfigCaching(openclawPackageRoot) {
  const patchedFiles = new Map();
  const distDir = resolve(openclawPackageRoot, "dist");
  let entries;
  try {
    entries = await readdir(distDir);
  } catch {
    console.warn(
      "[openclaw-sidecar] dist directory not found, skipping models config cache patch",
    );
    return patchedFiles;
  }

  for (const entry of entries) {
    if (!MODELS_CONFIG_BUNDLE_PATTERN.test(entry)) continue;
    const entryPath = resolve(distDir, entry);
    let source;
    try {
      source = await readFile(entryPath, "utf8");
    } catch {
      continue;
    }
    if (
      source.includes(MODELS_CONFIG_FINGERPRINT_SEARCH) &&
      !source.includes("readFileRawForFingerprint")
    ) {
      source = applyExactReplacement(
        source,
        MODELS_CONFIG_FINGERPRINT_SEARCH,
        MODELS_CONFIG_FINGERPRINT_REPLACEMENT,
        `${entry}: stabilize models.json cache fingerprint`,
      );
      patchedFiles.set(relative(openclawPackageRoot, entryPath), source);
      console.log(
        `[openclaw-sidecar] patched models config cache fingerprint in ${entry}`,
      );
    }
  }

  if (patchedFiles.size === 0) {
    console.warn(
      "[openclaw-sidecar] no models config cache anchors found (may already be fixed upstream)",
    );
  }

  return patchedFiles;
}

async function stagePatchedOpenclawPackage() {
  await mkdir(dirname(sidecarRoot), { recursive: true });
  const stageRoot = await mkdtemp(
    resolve(dirname(sidecarRoot), ".openclaw-package-stage-"),
  );
  const stagedOpenclawRoot = resolve(stageRoot, "openclaw");

  await cp(openclawRoot, stagedOpenclawRoot, {
    recursive: true,
    dereference: true,
  });

  const overlayFiles = await applyOpenclawRuntimePatches();
  const bridgePatchedFiles = await patchReplyOutcomeBridge(stagedOpenclawRoot);
  const geminiPatchedFiles =
    await patchGeminiToolSanitization(stagedOpenclawRoot);
  const controlUiPatchedFiles =
    await patchControlUiGeneratedImageRendering(stagedOpenclawRoot);
  const modelsConfigPatchedFiles =
    await patchModelsConfigCaching(stagedOpenclawRoot);
  const patchedFiles = new Map([
    ...overlayFiles,
    ...bridgePatchedFiles,
    ...geminiPatchedFiles,
    ...controlUiPatchedFiles,
    ...modelsConfigPatchedFiles,
  ]);

  for (const [patchRelativePath, patchedSource] of patchedFiles) {
    const targetPath = resolve(stagedOpenclawRoot, patchRelativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, patchedSource, "utf8");
  }

  console.log(
    `[openclaw-sidecar] staged transactional OpenClaw package with ${patchedFiles.size} patched file(s)`,
  );

  return { stageRoot, stagedOpenclawRoot };
}

async function flattenNestedNodeModules(parentNodeModules) {
  const openclawPkgNodeModules = resolve(parentNodeModules, "openclaw", "node_modules");
  if (!(await pathExists(openclawPkgNodeModules))) {
    return;
  }

  const rootVersions = new Map();
  const topEntries = await readdir(openclawPkgNodeModules, { withFileTypes: true });
  for (const entry of topEntries) {
    if (!entry.isDirectory() || entry.name === ".bin") continue;

    if (entry.name.startsWith("@")) {
      const scopeDir = resolve(openclawPkgNodeModules, entry.name);
      const scopeEntries = await readdir(scopeDir, { withFileTypes: true });
      for (const scopeEntry of scopeEntries) {
        if (!scopeEntry.isDirectory()) continue;
        const pkgDir = resolve(scopeDir, scopeEntry.name);
        const pkgJsonPath = resolve(pkgDir, "package.json");
        if (await pathExists(pkgJsonPath)) {
          const pkg = JSON.parse(await readFile(pkgJsonPath, "utf8"));
          rootVersions.set(`${entry.name}/${scopeEntry.name}`, pkg.version);
        }
      }
    } else {
      const pkgDir = resolve(openclawPkgNodeModules, entry.name);
      const pkgJsonPath = resolve(pkgDir, "package.json");
      if (await pathExists(pkgJsonPath)) {
        const pkg = JSON.parse(await readFile(pkgJsonPath, "utf8"));
        rootVersions.set(entry.name, pkg.version);
      }
    }
  }

  async function findNestedNodeModulesDirs(dir) {
    const results = [];
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = resolve(dir, entry.name);
      if (entry.name === "node_modules") {
        results.push(fullPath);
      } else if (entry.name !== ".bin") {
        results.push(...(await findNestedNodeModulesDirs(fullPath)));
      }
    }
    return results;
  }

  const nestedNMDirs = [];
  for (const entry of topEntries) {
    if (!entry.isDirectory() || entry.name === ".bin") continue;
    const pkgDir = resolve(openclawPkgNodeModules, entry.name);
    nestedNMDirs.push(...(await findNestedNodeModulesDirs(pkgDir)));
  }

  let hoistedCount = 0;
  for (const nmDir of nestedNMDirs) {
    const entries = await readdir(nmDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".bin") continue;

      const pkgsToCheck = [];
      if (entry.name.startsWith("@")) {
        const scopeDir = resolve(nmDir, entry.name);
        const scopeEntries = await readdir(scopeDir, { withFileTypes: true });
        for (const se of scopeEntries) {
          if (se.isDirectory()) {
            pkgsToCheck.push({
              name: `${entry.name}/${se.name}`,
              sourcePath: resolve(scopeDir, se.name),
            });
          }
        }
      } else {
        pkgsToCheck.push({
          name: entry.name,
          sourcePath: resolve(nmDir, entry.name),
        });
      }

      for (const { name, sourcePath } of pkgsToCheck) {
        const pkgJsonPath = resolve(sourcePath, "package.json");
        if (!(await pathExists(pkgJsonPath))) continue;

        const pkg = JSON.parse(await readFile(pkgJsonPath, "utf8"));
        const existingVersion = rootVersions.get(name);

        if (existingVersion === pkg.version) {
          await rm(sourcePath, { recursive: true, force: true });
          hoistedCount += 1;
        } else if (existingVersion === undefined) {
          const pathParts = name.split("/");
          const targetDir = resolve(openclawPkgNodeModules, ...pathParts);
          await mkdir(dirname(targetDir), { recursive: true });
          await robustRename(sourcePath, targetDir);
          rootVersions.set(name, pkg.version);
          hoistedCount += 1;
        }
      }
    }

    const remaining = await readdir(nmDir).catch(() => []);
    const hasContent = remaining.some((e) => e !== ".bin");
    if (!hasContent) {
      await rm(nmDir, { recursive: true, force: true });
    }
  }

  if (hoistedCount > 0) {
    console.log(
      `[openclaw-sidecar] flattened ${hoistedCount} deeply nested package(s) in openclaw/node_modules`,
    );
  }
}

async function liftBundledExtensionDeps(parentNodeModules) {
  const openclawPackageRoot = resolve(parentNodeModules, "openclaw");
  const extensionsRoot = resolve(openclawPackageRoot, "dist/extensions");
  const targetNodeModules = resolve(openclawPackageRoot, "node_modules");

  if (!(await pathExists(extensionsRoot))) {
    return;
  }

  const seen = new Set();
  let linkedCount = 0;
  let skippedCount = 0;

  const extensionEntries = await readdir(extensionsRoot, {
    withFileTypes: true,
  });
  for (const extensionEntry of extensionEntries) {
    if (!extensionEntry.isDirectory()) {
      continue;
    }

    const extensionNodeModules = resolve(
      extensionsRoot,
      extensionEntry.name,
      "node_modules",
    );
    if (!(await pathExists(extensionNodeModules))) {
      continue;
    }

    const packageEntries = await readdir(extensionNodeModules, {
      withFileTypes: true,
    });
    for (const packageEntry of packageEntries) {
      if (
        !packageEntry.isDirectory() ||
        packageEntry.name === ".bin" ||
        packageEntry.name === ".cache"
      ) {
        continue;
      }

      const packagesToLift = [];
      if (packageEntry.name.startsWith("@")) {
        const scopeDir = resolve(extensionNodeModules, packageEntry.name);
        const scopeEntries = await readdir(scopeDir, { withFileTypes: true });
        for (const scopeEntry of scopeEntries) {
          if (!scopeEntry.isDirectory() || scopeEntry.name.startsWith(".")) {
            continue;
          }
          packagesToLift.push({
            name: `${packageEntry.name}/${scopeEntry.name}`,
            sourcePath: resolve(scopeDir, scopeEntry.name),
          });
        }
      } else {
        packagesToLift.push({
          name: packageEntry.name,
          sourcePath: resolve(extensionNodeModules, packageEntry.name),
        });
      }

      for (const { name, sourcePath } of packagesToLift) {
        if (seen.has(name)) {
          skippedCount += 1;
          continue;
        }
        seen.add(name);

        const destPath = resolve(targetNodeModules, ...name.split("/"));
        if (await pathExists(destPath)) {
          skippedCount += 1;
          continue;
        }

        await mkdir(dirname(destPath), { recursive: true });
        await symlink(
          sourcePath,
          destPath,
          process.platform === "win32" ? "junction" : "dir",
        );
        linkedCount += 1;
      }
    }
  }

  if (linkedCount > 0 || skippedCount > 0) {
    console.log(
      `[openclaw-sidecar] lifted extension deps linked=${linkedCount} skipped=${skippedCount}`,
    );
  }
}

async function prepareOpenclawSidecar() {
  if (!(await pathExists(openclawRoot))) {
    throw new Error(
      `OpenClaw runtime dependency not found at ${openclawRoot}. Run pnpm openclaw-runtime:install first.`,
    );
  }

  const fingerprint = await computeOpenclawSidecarFingerprint();
  const canReuseExistingOpenclawSidecar =
    shouldCopyRuntimeDependencies() && !shouldArchiveOpenclawSidecar;
  const willArchiveOpenclawSidecar =
    shouldCopyRuntimeDependencies() && shouldArchiveOpenclawSidecar;

  if (
    shouldCopyRuntimeDependencies() &&
    !canReuseExistingOpenclawSidecar &&
    shouldReuseExistingOpenclawSidecar
  ) {
    console.warn(
      "[openclaw-sidecar] reuse requested but disabled for archived or linked sidecar mode; rebuilding sidecar",
    );
  }

  if (
    !shouldCopyRuntimeDependencies() &&
    shouldReuseExistingOpenclawSidecar &&
    (await hasReusableOpenclawSidecarRoot(fingerprint))
  ) {
    console.log(
      "[openclaw-sidecar] reusing existing linked openclaw sidecar; fingerprint unchanged",
    );
    await liftBundledExtensionDeps(sidecarNodeModules);
    await writeSidecarMetadataAndLaunchers(sidecarRoot, fingerprint);
    return;
  }

  await timedStep("reset sidecar root", async () => {
    await resetDir(sidecarRoot);
    await mkdir(sidecarBinDir, { recursive: true });
  });

  if (
    canReuseExistingOpenclawSidecar &&
    shouldReuseExistingOpenclawSidecar &&
    (await hasReusableOpenclawSidecarCache(fingerprint))
  ) {
    await timedStep("restore cached openclaw sidecar", async () => {
      await restoreCachedOpenclawSidecar(fingerprint);
    });
    return;
  }

  const { stageRoot, stagedOpenclawRoot } = await timedStep(
    "stage patched openclaw package",
    async () => stagePatchedOpenclawPackage(),
  );
  try {
    await timedStep("copy openclaw runtime node_modules", async () => {
      await linkOrCopyDirectory(
        openclawRuntimeNodeModules,
        sidecarNodeModules,
        {
          excludeNames: ["openclaw"],
        },
      );
      await robustRename(
        stagedOpenclawRoot,
        resolve(sidecarNodeModules, "openclaw"),
      );
    });
  } finally {
    await removePathIfExists(stageRoot);
  }

  if (shouldCopyRuntimeDependencies()) {
    await timedStep("flatten nested node_modules", async () =>
      flattenNestedNodeModules(sidecarNodeModules),
    );
  }

  if (!willArchiveOpenclawSidecar) {
    await timedStep("lift bundled extension deps", async () =>
      liftBundledExtensionDeps(sidecarNodeModules),
    );
  }

  await writeSidecarMetadataAndLaunchers(sidecarRoot, fingerprint);
  await timedStep("sign native binaries", async () =>
    signOpenclawNativeBinaries(),
  );

  if (willArchiveOpenclawSidecar) {
    // Windows: LZMA2-compressed .7z for fastest extraction on cold install.
    // macOS/Linux: tar.gz stays (tar is ubiquitous; gz is good enough).
    const archiveFormat = process.platform === "win32" ? "7z" : "tar.gz";
    const archiveFileName =
      archiveFormat === "7z"
        ? "openclaw-sidecar.7z"
        : "openclaw-sidecar.tar.gz";
    const payloadFileName =
      archiveFormat === "7z" ? "payload.7z" : "payload.tar.gz";
    const archivePath = resolve(dirname(sidecarRoot), archiveFileName);
    await timedStep("archive openclaw sidecar", async () => {
      await removePathIfExists(archivePath);
      if (archiveFormat === "7z") {
        await create7zArchive(sidecarRoot, archivePath);
      } else {
        await run("tar", ["-czf", archivePath, "-C", sidecarRoot, "."]);
      }
      await resetDir(sidecarRoot);
      await writeFile(
        resolve(sidecarRoot, "archive.json"),
        `${JSON.stringify(
          {
            format: archiveFormat,
            path: payloadFileName,
          },
          null,
          2,
        )}\n`,
      );
      await writeFile(
        resolve(sidecarRoot, "package.json"),
        '{\n  "name": "openclaw-sidecar",\n  "private": true\n}\n',
      );
      await robustRename(archivePath, resolve(sidecarRoot, payloadFileName));
    });
  } else if (shouldCopyRuntimeDependencies()) {
    console.log(
      "[openclaw-sidecar] skipping archive packaging for fast CI mode",
    );
  }

  if (canReuseExistingOpenclawSidecar) {
    await timedStep("update openclaw sidecar cache", async () => {
      await updateOpenclawSidecarCache(fingerprint);
    });
  }
}

await prepareOpenclawSidecar();
