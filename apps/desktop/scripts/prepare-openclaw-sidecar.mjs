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
    if (patched) {
      patchedFiles.set(relative(openclawPackageRoot, entryPath), entrySource);
      console.log(
        `[openclaw-sidecar] patched normalizeProviderToolSchemas in ${entry}`,
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
  const patchedFiles = new Map([
    ...overlayFiles,
    ...bridgePatchedFiles,
    ...geminiPatchedFiles,
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

async function prepareOpenclawSidecar() {
  if (!(await pathExists(openclawRoot))) {
    throw new Error(
      `OpenClaw runtime dependency not found at ${openclawRoot}. Run pnpm openclaw-runtime:install first.`,
    );
  }

  const fingerprint = await computeOpenclawSidecarFingerprint();
  const canReuseExistingOpenclawSidecar =
    shouldCopyRuntimeDependencies() && !shouldArchiveOpenclawSidecar;

  if (!canReuseExistingOpenclawSidecar && shouldReuseExistingOpenclawSidecar) {
    console.warn(
      "[openclaw-sidecar] reuse requested but disabled for archived or linked sidecar mode; rebuilding sidecar",
    );
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

  await writeSidecarMetadataAndLaunchers(sidecarRoot, fingerprint);
  await timedStep("sign native binaries", async () =>
    signOpenclawNativeBinaries(),
  );

  if (shouldCopyRuntimeDependencies() && shouldArchiveOpenclawSidecar) {
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
