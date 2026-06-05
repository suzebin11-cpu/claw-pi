import { spawnSync } from "node:child_process";
import type { Dirent } from "node:fs";
import { access, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir, hostname, machine, release, version } from "node:os";
import { basename, resolve } from "node:path";
import { deflateRawSync } from "node:zlib";
import { app, dialog } from "electron";
import type { DesktopRuntimeConfig } from "../shared/runtime-config";
import { getDesktopDiagnosticsFilePath } from "./desktop-diagnostics";
import { redactJsonValue, scrubUrlTokens } from "./redaction";
import type { RuntimeOrchestrator } from "./runtime/daemon-supervisor";

export type DiagnosticsExportResult = {
  status: "success" | "cancelled" | "failed";
  outputPath?: string;
  warnings?: string[];
  errorMessage?: string;
};

// ---------------------------------------------------------------------------
// Minimal ZIP writer (deflate compression via Node built-in zlib)
// ---------------------------------------------------------------------------

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint16LE(buf: Buffer, offset: number, value: number): void {
  buf.writeUInt16LE(value, offset);
}

function writeUint32LE(buf: Buffer, offset: number, value: number): void {
  buf.writeUInt32LE(value >>> 0, offset);
}

type ZipFileEntry = {
  name: string;
  data: Buffer;
  modTime?: Date;
};

type CollectedFileMetadata = {
  sourcePath: string;
  archivePath: string;
  sizeBytes: number;
  modifiedAt: string;
};

type DiagnosticsErrorCategory =
  | "model_network_error"
  | "upstream_saturated"
  | "insufficient_balance"
  | "balance_unavailable"
  | "auth_expired"
  | "model_auth_not_ready"
  | "openclaw_not_ready"
  | "image_response_lost"
  | "attachment_extract_failed"
  | "wechat_qr_pending"
  | "wechat_network_error"
  | "update_failed"
  | "unknown";

function classifyDiagnosticText(text: string): DiagnosticsErrorCategory {
  if (
    /(?:上游.*(?:负载|分组).*(?:饱和|繁忙)|当前分组上游负载已饱和|upstream.*(?:saturat|overload|busy)|rate limit|too many requests|HTTP 429|\b429\b)/iu.test(
      text,
    )
  ) {
    return "upstream_saturated";
  }
  if (
    /(?:token quota is not enough|need quota|insufficient (?:balance|quota|credits?)|quota.+not enough|余额不足|额度不足|余额不够)/iu.test(
      text,
    )
  ) {
    return "insufficient_balance";
  }
  if (
    /(?:token|jwt|登录|登陆|auth|authorization).{0,24}(?:过期|expired)|(?:unauthorized|not authenticated|未登录|未认证)/iu.test(
      text,
    )
  ) {
    return "auth_expired";
  }
  if (
    /(?:No API key found|模型账号未就绪|auth-profiles\.json|Configure auth for this agent|OpenClaw 配置同步失败|config sync failed)/iu.test(
      text,
    )
  ) {
    return "model_auth_not_ready";
  }
  if (
    /(?:图片生成已提交但结果返回失败|图片生成请求未返回完整图片结果|image_generation_stream_failed|image_generation.*(?:timed out|timeout|response.*lost|failed)|(?:图片|生图|图生图|gpt-image|\/v1\/images).{0,120}openai_error|openai_error.{0,120}(?:图片|生图|图生图|gpt-image|\/v1\/images)|生图.*(?:超时|返回失败|未返回))/iu.test(
      text,
    )
  ) {
    return "image_response_lost";
  }
  if (
    /(?:余额暂时无法显示|无法加载余额|Failed to fetch balance|balance.{0,48}(?:unavailable|fetch failed|load failed|failed to fetch)|Server unreachable)/iu.test(
      text,
    )
  ) {
    return "balance_unavailable";
  }
  if (
    /(?:LLM request failed:\s*)?(?:network connection error|connection error|fetch failed|failed to fetch|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)/iu.test(
      text,
    )
  ) {
    return "model_network_error";
  }
  if (
    /(?:openclaw gateway not connected|gateway not connected|NOT_PAIRED|pairing required|device token mismatch|device signature invalid|OpenClaw agent chat timed out)/iu.test(
      text,
    )
  ) {
    return "openclaw_not_ready";
  }
  if (
    /(?:agent_chat_extracted_attachment.*"extractStatus":"failed"|附件内容为空|附件.*无法读取|attachment_extract_failed)/iu.test(
      text,
    )
  ) {
    return "attachment_extract_failed";
  }
  if (
    /(?:wechat_qr_wait_timeout|wechat_qr_wait_poll_retryable|仍在等待手机微信扫码|scanned_waiting_confirm|waiting_scan)/iu.test(
      text,
    )
  ) {
    return "wechat_qr_pending";
  }
  if (
    /(?:wechat.{0,120}(?:network|请检查网络|connect failed|connection failed|login failed)|(?:微信|wechat).{0,120}(?:网络异常|请检查网络|连接失败|登录失败|扫码没反应))/iu.test(
      text,
    )
  ) {
    return "wechat_network_error";
  }
  if (/(?:update error|update_failed|auto-update.*error)/iu.test(text)) {
    return "update_failed";
  }
  return "unknown";
}

function buildDiagnosticConclusion(category: DiagnosticsErrorCategory): string {
  switch (category) {
    case "model_network_error":
      return "本次失败原因：上游模型网络错误";
    case "upstream_saturated":
      return "本次失败原因：上游分组负载饱和";
    case "insufficient_balance":
      return "本次失败原因：余额不足";
    case "balance_unavailable":
      return "本次失败原因：余额暂时无法显示或余额接口不可用";
    case "auth_expired":
      return "本次失败原因：登录状态已过期";
    case "model_auth_not_ready":
      return "本次失败原因：OpenClaw 本地模型认证缺失";
    case "openclaw_not_ready":
      return "本次失败原因：OpenClaw 本地服务未就绪";
    case "image_response_lost":
      return "本次失败原因：图片生成结果返回失败";
    case "attachment_extract_failed":
      return "本次失败原因：附件读取或解析失败";
    case "wechat_qr_pending":
      return "本次失败原因：微信扫码仍在等待确认或网络恢复";
    case "wechat_network_error":
      return "本次失败原因：微信连接网络异常";
    case "update_failed":
      return "本次失败原因：更新检查或安装失败";
    default:
      return "本次诊断未识别到明确失败类型，请查看日志明细";
  }
}

function extractLastRunId(text: string): string | null {
  const matches = [...text.matchAll(/\brunId=([A-Za-z0-9._~-]+)/gu)];
  return matches.at(-1)?.[1] ?? null;
}

export function buildDiagnosticsSummary(input: {
  runtimeConfig: DesktopRuntimeConfig;
  runtimeState: ReturnType<RuntimeOrchestrator["getRuntimeState"]>;
  diagnosticText: string;
  desktopDiagnosticsSummary: unknown;
}): Record<string, unknown> {
  const category = classifyDiagnosticText(input.diagnosticText);
  const units = input.runtimeState.units.map((unit) => ({
    id: unit.id,
    label: unit.label,
    phase: unit.phase,
    port: unit.port,
    lastError: unit.lastError,
    lastReasonCode: unit.lastReasonCode,
    restartCount: unit.restartCount,
  }));
  const openclawUnit = input.runtimeState.units.find((unit) =>
    /openclaw/iu.test(`${unit.id} ${unit.label}`),
  );
  const failedUnits = input.runtimeState.units.filter(
    (unit) => unit.phase === "failed",
  );
  const startupStatus =
    failedUnits.length > 0
      ? "failed"
      : input.runtimeState.units.every((unit) => unit.phase === "running")
        ? "ready"
        : "starting";

  return {
    version: app.getVersion(),
    buildInfo: input.runtimeConfig.buildInfo,
    lastRunId: extractLastRunId(input.diagnosticText),
    lastErrorCategory: category,
    conclusion: buildDiagnosticConclusion(category),
    startupStatus,
    openclawReady: openclawUnit ? openclawUnit.phase === "running" : null,
    modelAuthReady:
      category === "model_auth_not_ready"
        ? false
        : null,
    imagePluginReady:
      /(?:Registered image_generate tool|clawpi-image-generation.*tool_call)/iu.test(
        input.diagnosticText,
      )
        ? true
        : null,
    balanceStatus:
      category === "insufficient_balance"
        ? "insufficient"
        : category === "auth_expired"
          ? "auth_expired"
          : category === "balance_unavailable"
            ? "unavailable"
          : null,
    wechatStatus:
      category === "wechat_qr_pending"
        ? "pending"
        : category === "wechat_network_error"
          ? "network_error"
        : /wechat_qr_wait_confirmed/iu.test(input.diagnosticText)
          ? "connected"
          : null,
    runtimeUnits: units,
    failedUnits: failedUnits.map((unit) => unit.id),
    desktopDiagnostics: input.desktopDiagnosticsSummary,
  };
}

function toDosDateTime(date: Date): { dosTime: number; dosDate: number } {
  const dosTime =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((date.getSeconds() >> 1) & 0x1f);
  const dosDate =
    (((date.getFullYear() - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);
  return { dosTime, dosDate };
}

async function writeZip(
  entries: ZipFileEntry[],
  outputPath: string,
): Promise<void> {
  const chunks: Buffer[] = [];
  const centralDirEntries: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const dataLen = entry.data.length;
    const crc = crc32(entry.data);

    // Local file header (30 bytes + name)
    const compressed = deflateRawSync(entry.data, { level: 6 });
    const compressedLen = compressed.length;
    const localHeader = Buffer.alloc(30 + nameBytes.length);
    const { dosTime, dosDate } = toDosDateTime(entry.modTime ?? new Date());
    writeUint32LE(localHeader, 0, 0x04034b50); // signature
    writeUint16LE(localHeader, 4, 20); // version needed
    writeUint16LE(localHeader, 6, 0); // flags
    writeUint16LE(localHeader, 8, 8); // compression: deflate
    writeUint16LE(localHeader, 10, dosTime); // mod time
    writeUint16LE(localHeader, 12, dosDate); // mod date
    writeUint32LE(localHeader, 14, crc);
    writeUint32LE(localHeader, 18, compressedLen); // compressed size
    writeUint32LE(localHeader, 22, dataLen); // uncompressed size
    writeUint16LE(localHeader, 26, nameBytes.length);
    writeUint16LE(localHeader, 28, 0); // extra length
    nameBytes.copy(localHeader, 30);

    // Central directory record (46 bytes + name)
    const centralRecord = Buffer.alloc(46 + nameBytes.length);
    writeUint32LE(centralRecord, 0, 0x02014b50); // signature
    writeUint16LE(centralRecord, 4, 20); // version made by
    writeUint16LE(centralRecord, 6, 20); // version needed
    writeUint16LE(centralRecord, 8, 0); // flags
    writeUint16LE(centralRecord, 10, 8); // compression: deflate
    writeUint16LE(centralRecord, 12, dosTime); // mod time
    writeUint16LE(centralRecord, 14, dosDate); // mod date
    writeUint32LE(centralRecord, 16, crc);
    writeUint32LE(centralRecord, 20, compressedLen); // compressed size
    writeUint32LE(centralRecord, 24, dataLen); // uncompressed size
    writeUint16LE(centralRecord, 28, nameBytes.length);
    writeUint16LE(centralRecord, 30, 0); // extra length
    writeUint16LE(centralRecord, 32, 0); // comment length
    writeUint16LE(centralRecord, 34, 0); // disk number start
    writeUint16LE(centralRecord, 36, 0); // internal attrs
    writeUint32LE(centralRecord, 38, 0); // external attrs
    writeUint32LE(centralRecord, 42, offset); // local header offset
    nameBytes.copy(centralRecord, 46);

    chunks.push(localHeader, compressed);
    centralDirEntries.push(centralRecord);

    offset += localHeader.length + compressedLen;
  }

  const centralDirBuffer = Buffer.concat(centralDirEntries);
  const centralDirSize = centralDirBuffer.length;
  const centralDirOffset = offset;

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  writeUint32LE(eocd, 0, 0x06054b50); // signature
  writeUint16LE(eocd, 4, 0); // disk number
  writeUint16LE(eocd, 6, 0); // central dir start disk
  writeUint16LE(eocd, 8, entries.length); // entries on disk
  writeUint16LE(eocd, 10, entries.length); // total entries
  writeUint32LE(eocd, 12, centralDirSize);
  writeUint32LE(eocd, 16, centralDirOffset);
  writeUint16LE(eocd, 20, 0); // comment length

  const zipData = Buffer.concat([...chunks, centralDirBuffer, eocd]);
  await writeFile(outputPath, zipData);
}

function scrubTextBuffer(raw: Buffer): Buffer {
  const text = raw.toString("utf8");
  return Buffer.from(scrubUrlTokens(text), "utf8");
}

function redactJsonBuffer(raw: Buffer): Buffer {
  try {
    const parsed: unknown = JSON.parse(raw.toString("utf8"));
    const redacted = redactJsonValue(parsed) as object;
    return Buffer.from(`${JSON.stringify(redacted, null, 2)}\n`, "utf8");
  } catch {
    // Not valid JSON — return as-is
    return raw;
  }
}

function parseJsonBuffer<T>(raw: Buffer): T | null {
  try {
    return JSON.parse(raw.toString("utf8")) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Artifact collection
// ---------------------------------------------------------------------------

async function tryReadFile(
  filePath: string,
): Promise<{ data: Buffer; mtime: Date } | null> {
  try {
    await access(filePath);
    const [data, fileStat] = await Promise.all([
      readFile(filePath),
      stat(filePath),
    ]);
    return { data, mtime: fileStat.mtime };
  } catch {
    return null;
  }
}

async function listFilesInDirectory(directoryPath: string): Promise<string[]> {
  try {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => resolve(directoryPath, entry.name));
  } catch {
    return [];
  }
}

async function listFilesRecursive(directoryPath: string): Promise<string[]> {
  const output: string[] = [];

  async function walk(currentPath: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(currentPath, {
        withFileTypes: true,
        encoding: "utf8",
      });
    } catch {
      return;
    }

    await Promise.all(
      entries.map(async (entry) => {
        const nextPath = resolve(currentPath, entry.name);
        if (entry.isDirectory()) {
          await walk(nextPath);
          return;
        }
        if (entry.isFile()) {
          output.push(nextPath);
        }
      }),
    );
  }

  await walk(directoryPath);
  return output;
}

function runCommand(
  binaryPath: string,
  args: string[],
): {
  binaryPath: string;
  args: string[];
  ok: boolean;
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string | null;
  stderr: string | null;
  error: string | null;
} {
  const result = spawnSync(binaryPath, args, {
    encoding: "utf8",
    timeout: 5000,
  });

  const stdout = result.stdout?.trim() ?? "";
  const stderr = result.stderr?.trim() ?? "";

  return {
    binaryPath,
    args,
    ok: result.status === 0 && !result.error,
    status: result.status,
    signal: result.signal,
    stdout: stdout.length > 0 ? stdout : null,
    stderr: stderr.length > 0 ? stderr : null,
    error: result.error ? String(result.error.message) : null,
  };
}

type CommandSnapshot = ReturnType<typeof runCommand>;

function buildStaticCommandSnapshot(
  binaryPath: string,
  args: string[],
  stdout: string | null,
  error: string | null = null,
): CommandSnapshot {
  return {
    binaryPath,
    args,
    ok: stdout !== null && error === null,
    status: stdout !== null && error === null ? 0 : null,
    signal: null,
    stdout,
    stderr: null,
    error,
  };
}

function normalizeStringValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function readOperatingSystemVersion(): string | null {
  if (process.platform === "darwin") {
    const result = runCommand("/usr/bin/sw_vers", ["-productVersion"]);
    return result.ok ? result.stdout : null;
  }

  return normalizeStringValue(version()) ?? normalizeStringValue(release());
}

function readMachineArchitectureSnapshot(): CommandSnapshot | null {
  if (process.platform === "darwin") {
    return runCommand("/usr/bin/uname", ["-m"]);
  }

  return buildStaticCommandSnapshot(
    "node:os.machine",
    [],
    normalizeStringValue(machine()) ?? normalizeStringValue(process.arch),
  );
}

export function buildMachineSummary(
  runtimeConfig: DesktopRuntimeConfig,
): Record<string, unknown> {
  const rosettaCheck =
    process.platform === "darwin"
      ? runCommand("/usr/sbin/sysctl", ["-n", "sysctl.proc_translated"])
      : null;

  const unameMachine = readMachineArchitectureSnapshot();

  return {
    buildInfo: runtimeConfig.buildInfo,
    hostName: hostname(),
    platform: process.platform,
    arch: process.arch,
    osVersion: readOperatingSystemVersion(),
    processVersions: process.versions,
    executablePath: app.getPath("exe"),
    processExecPath: process.execPath,
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
    rosetta: rosettaCheck
      ? {
          translated:
            rosettaCheck.ok && rosettaCheck.stdout !== null
              ? rosettaCheck.stdout === "1"
              : null,
          command: rosettaCheck,
        }
      : null,
    uname: unameMachine,
    appPaths: {
      userData: app.getPath("userData"),
      logs: app.getPath("logs"),
      crashDumps: app.getPath("crashDumps"),
      nexuHome: runtimeConfig.paths.nexuHome,
    },
  };
}

function buildAppSigningSummary(): object | null {
  if (process.platform !== "darwin") {
    return null;
  }

  const appExecutablePath = app.getPath("exe");

  return {
    executablePath: appExecutablePath,
    codesign: runCommand("/usr/bin/codesign", [
      "-dv",
      "--verbose=4",
      appExecutablePath,
    ]),
    spctl: runCommand("/usr/sbin/spctl", [
      "--assess",
      "--type",
      "execute",
      "-vv",
      appExecutablePath,
    ]),
  };
}

function getTimestampSlug(): string {
  const now = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const offsetMin = -now.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const absMin = Math.abs(offsetMin);
  const tz = `${sign}${pad(Math.floor(absMin / 60))}${pad(absMin % 60)}`;
  return `${date}T${time}${tz}`;
}

async function collectArtifacts(
  orchestrator: RuntimeOrchestrator,
  runtimeConfig: DesktopRuntimeConfig,
  archiveRoot: string,
): Promise<{ entries: ZipFileEntry[]; warnings: string[] }> {
  const entries: ZipFileEntry[] = [];
  const included: string[] = [];
  const missing: string[] = [];
  const warnings: string[] = [];
  let desktopDiagnosticsSummary: unknown = null;
  const diagnosticSignals: string[] = [];

  const additionalArtifacts = {
    startupHealth: null as CollectedFileMetadata | null,
    openclawLogs: [] as CollectedFileMetadata[],
    sentryFiles: [] as CollectedFileMetadata[],
    crashReports: [] as CollectedFileMetadata[],
    sentrySkippedNonJson: [] as string[],
  };

  async function addFile(
    zipPath: string,
    filePath: string,
    {
      redact = false,
      scrubLog = false,
    }: { redact?: boolean; scrubLog?: boolean } = {},
  ): Promise<CollectedFileMetadata | null> {
    const result = await tryReadFile(filePath);
    if (result === null) {
      missing.push(zipPath);
      return null;
    }
    let { data } = result;
    if (redact) data = redactJsonBuffer(data);
    if (scrubLog) data = scrubTextBuffer(data);
    entries.push({
      name: `${archiveRoot}/${zipPath}`,
      data,
      modTime: result.mtime,
    });
    included.push(zipPath);
    return {
      sourcePath: filePath,
      archivePath: zipPath,
      sizeBytes: data.length,
      modifiedAt: result.mtime.toISOString(),
    };
  }

  async function addDiagnosticSignal(filePath: string): Promise<void> {
    const result = await tryReadFile(filePath);
    if (result === null) {
      return;
    }
    diagnosticSignals.push(
      scrubTextBuffer(result.data).toString("utf8").slice(-160_000),
    );
  }

  // Desktop diagnostics snapshot
  const desktopDiagnosticsMetadata = await addFile(
    "diagnostics/desktop-diagnostics.json",
    getDesktopDiagnosticsFilePath(),
    {
      redact: true,
    },
  );

  if (desktopDiagnosticsMetadata) {
    const desktopDiagnosticsFile = await tryReadFile(
      getDesktopDiagnosticsFilePath(),
    );
    const parsedDiagnostics = desktopDiagnosticsFile
      ? parseJsonBuffer<{
          startupProbe?: {
            preloadSeen?: boolean;
            rendererSeen?: boolean;
            entries?: Array<{
              source?: string;
              stage?: string;
              status?: string;
              detail?: string | null;
              at?: string;
            }>;
          };
          renderer?: {
            didFinishLoad?: boolean;
            lastError?: string | null;
            processGone?: {
              seen?: boolean;
              reason?: string | null;
              exitCode?: number | null;
              at?: string | null;
            };
          };
          coldStart?: {
            status?: string;
            step?: string | null;
            error?: string | null;
          };
        }>(desktopDiagnosticsFile.data)
      : null;

    if (parsedDiagnostics) {
      desktopDiagnosticsSummary = {
        sourceArchivePath: desktopDiagnosticsMetadata.archivePath,
        coldStart: parsedDiagnostics.coldStart ?? null,
        renderer: parsedDiagnostics.renderer ?? null,
        startupProbe: parsedDiagnostics.startupProbe ?? null,
      };
    }
  }

  // Main process logs
  const logsDir = resolve(app.getPath("userData"), "logs");
  const coldStartLogPath = resolve(logsDir, "cold-start.log");
  const desktopMainLogPath = resolve(logsDir, "desktop-main.log");
  await addFile("logs/cold-start.log", coldStartLogPath, {
    scrubLog: true,
  });
  await addFile("logs/desktop-main.log", desktopMainLogPath, {
    scrubLog: true,
  });
  await addDiagnosticSignal(coldStartLogPath);
  await addDiagnosticSignal(desktopMainLogPath);

  // Runtime unit logs (skip embedded units — they have no subprocess log file)
  const runtimeState = orchestrator.getRuntimeState();
  for (const unit of runtimeState.units) {
    if (unit.logFilePath && unit.launchStrategy !== "embedded") {
      await addFile(`logs/runtime-units/${unit.id}.log`, unit.logFilePath, {
        scrubLog: true,
      });
    }
  }

  // OpenClaw config (derived from userData path, same logic as manifests.ts)
  const openclawConfigPath = resolve(
    app.getPath("userData"),
    "runtime/openclaw/config/openclaw.json",
  );
  await addFile("config/openclaw.json", openclawConfigPath, { redact: true });

  // Startup health state (updater rollback diagnostics)
  additionalArtifacts.startupHealth = await addFile(
    "diagnostics/startup-health.json",
    resolve(app.getPath("userData"), "startup-health.json"),
    {
      redact: true,
    },
  );

  // OpenClaw runtime logs. Historically openclaw-gateway writes to
  // `/tmp/openclaw`. On macOS/Linux that is `/tmp/openclaw`; on Windows the
  // same literal resolves to `<drive>:\tmp\openclaw` relative to the current
  // process cwd which has caused exports to miss the logs entirely. We scan
  // every plausible location and de-duplicate by absolute path.
  const openclawLogCandidateDirs = new Set<string>();
  openclawLogCandidateDirs.add("/tmp/openclaw");
  if (process.platform === "win32") {
    openclawLogCandidateDirs.add("C:\\tmp\\openclaw");
    const tempEnv = process.env.TEMP ?? process.env.TMP;
    if (tempEnv) {
      openclawLogCandidateDirs.add(resolve(tempEnv, "openclaw"));
    }
    openclawLogCandidateDirs.add(
      resolve(app.getPath("temp"), "..", "tmp", "openclaw"),
    );
  } else {
    openclawLogCandidateDirs.add(resolve(homedir(), ".openclaw", "logs"));
  }

  const seenOpenclawLogPaths = new Set<string>();
  for (const candidateDir of openclawLogCandidateDirs) {
    const files = (await listFilesInDirectory(candidateDir))
      .filter((filePath) => /^openclaw-.*\.log$/i.test(basename(filePath)))
      .sort();

    for (const openclawLogPath of files) {
      const absoluteLogPath = resolve(openclawLogPath);
      if (seenOpenclawLogPaths.has(absoluteLogPath)) continue;
      seenOpenclawLogPaths.add(absoluteLogPath);

      const metadata = await addFile(
        `logs/openclaw/${basename(openclawLogPath)}`,
        openclawLogPath,
        {
          scrubLog: true,
        },
      );
      if (metadata) {
        additionalArtifacts.openclawLogs.push(metadata);
        await addDiagnosticSignal(openclawLogPath);
      }
    }
  }

  // Sentry local data under userData/sentry (JSON files only)
  const sentryDir = resolve(app.getPath("userData"), "sentry");
  const sentryFiles = (await listFilesRecursive(sentryDir)).sort();

  for (const sentryFilePath of sentryFiles) {
    const fileName = sentryFilePath.slice(sentryDir.length + 1);
    const isJsonLike = /\.(json|jsonl)$/i.test(fileName);

    if (!isJsonLike) {
      additionalArtifacts.sentrySkippedNonJson.push(fileName);
      continue;
    }

    const metadata = await addFile(
      `diagnostics/sentry/${fileName}`,
      sentryFilePath,
      {
        redact: true,
      },
    );
    if (metadata) {
      additionalArtifacts.sentryFiles.push(metadata);
    }
  }

  // Crash reports (last 7 days, file name contains "exu")
  const crashReportsDir = resolve(homedir(), "Library/Logs/DiagnosticReports");
  const crashCandidateFiles = (
    await listFilesInDirectory(crashReportsDir)
  ).sort();
  const crashCutoffMs = Date.now() - 7 * 24 * 60 * 60 * 1000;

  for (const crashFilePath of crashCandidateFiles) {
    const reportName = basename(crashFilePath);
    if (!reportName.toLowerCase().includes("exu")) {
      continue;
    }

    const crashStat = await stat(crashFilePath).catch(() => null);
    if (crashStat === null || crashStat.mtimeMs < crashCutoffMs) {
      continue;
    }

    const crashFile = await tryReadFile(crashFilePath);
    if (crashFile === null) {
      continue;
    }

    const crashJson = {
      sourcePath: crashFilePath,
      fileName: reportName,
      modifiedAt: crashStat.mtime.toISOString(),
      sizeBytes: crashStat.size,
      content: scrubTextBuffer(crashFile.data).toString("utf8"),
    };

    const archivePath = `diagnostics/crashes/${reportName}.json`;
    entries.push({
      name: `${archiveRoot}/${archivePath}`,
      data: Buffer.from(`${JSON.stringify(crashJson, null, 2)}\n`, "utf8"),
      modTime: crashStat.mtime,
    });
    included.push(archivePath);
    additionalArtifacts.crashReports.push({
      sourcePath: crashFilePath,
      archivePath,
      sizeBytes: crashStat.size,
      modifiedAt: crashStat.mtime.toISOString(),
    });
  }

  // Environment summary (safe metadata only)
  const envSummary = buildEnvironmentSummary(runtimeConfig);
  const machineSummary = buildMachineSummary(runtimeConfig);
  const appSigningSummary = buildAppSigningSummary();
  const now = new Date();
  entries.push({
    name: `${archiveRoot}/summary/environment-summary.json`,
    data: Buffer.from(`${JSON.stringify(envSummary, null, 2)}\n`, "utf8"),
    modTime: now,
  });
  included.push("summary/environment-summary.json");

  entries.push({
    name: `${archiveRoot}/summary/machine-info.json`,
    data: Buffer.from(`${JSON.stringify(machineSummary, null, 2)}\n`, "utf8"),
    modTime: now,
  });
  included.push("summary/machine-info.json");

  if (appSigningSummary) {
    entries.push({
      name: `${archiveRoot}/summary/app-signing.json`,
      data: Buffer.from(
        `${JSON.stringify(appSigningSummary, null, 2)}\n`,
        "utf8",
      ),
      modTime: now,
    });
    included.push("summary/app-signing.json");
  }

  if (desktopDiagnosticsSummary) {
    const redactedStartupProbeSummary = redactJsonBuffer(
      Buffer.from(
        `${JSON.stringify(desktopDiagnosticsSummary, null, 2)}\n`,
        "utf8",
      ),
    );

    entries.push({
      name: `${archiveRoot}/summary/startup-probe-summary.json`,
      data: redactedStartupProbeSummary,
      modTime: now,
    });
    included.push("summary/startup-probe-summary.json");
  }

  const diagnosticsSummary = buildDiagnosticsSummary({
    runtimeConfig,
    runtimeState,
    diagnosticText: diagnosticSignals.join("\n"),
    desktopDiagnosticsSummary,
  });
  entries.push({
    name: `${archiveRoot}/diagnosticsSummary.json`,
    data: redactJsonBuffer(
      Buffer.from(`${JSON.stringify(diagnosticsSummary, null, 2)}\n`, "utf8"),
    ),
    modTime: now,
  });
  included.push("diagnosticsSummary.json");

  const extraArtifactsSummary = {
    startupHealth: additionalArtifacts.startupHealth,
    openclawLogs: additionalArtifacts.openclawLogs,
    sentryFiles: additionalArtifacts.sentryFiles,
    sentrySkippedNonJson: additionalArtifacts.sentrySkippedNonJson,
    crashReports: additionalArtifacts.crashReports,
  };
  entries.push({
    name: `${archiveRoot}/summary/additional-artifacts.json`,
    data: Buffer.from(
      `${JSON.stringify(extraArtifactsSummary, null, 2)}\n`,
      "utf8",
    ),
    modTime: now,
  });
  included.push("summary/additional-artifacts.json");

  if (missing.length > 0) {
    warnings.push(`${missing.length} file(s) were not found and were skipped.`);
  }

  included.push("summary/manifest.json");

  // Manifest
  const manifest = {
    exportedAt: now.toISOString(),
    appVersion: app.getVersion(),
    included,
    missing,
    warnings,
    redactionNote:
      "JSON files have had fields matching token/password/secret/key/dsn patterns redacted. " +
      "Log and JSON string values have had URL-embedded tokens (e.g. #token=, ?token=) scrubbed.",
  };
  entries.push({
    name: `${archiveRoot}/summary/manifest.json`,
    data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    modTime: now,
  });

  return { entries, warnings };
}

function buildEnvironmentSummary(runtimeConfig: DesktopRuntimeConfig): object {
  return {
    buildInfo: runtimeConfig.buildInfo,
    platform: process.platform,
    arch: process.arch,
    hostName: hostname(),
    osVersion: readOperatingSystemVersion(),
    nodeVersion: process.versions.node,
    electronVersion: process.versions.electron,
    isPackaged: app.isPackaged,
    appVersion: app.getVersion(),
    logPath: app.getPath("logs"),
    userDataPath: app.getPath("userData"),
    // Omit tokens, passwords, DSN — those are redacted from other artifacts
    ports: runtimeConfig.ports,
    urls: {
      controllerBase: runtimeConfig.urls.controllerBase,
      web: runtimeConfig.urls.web,
      openclawBase: runtimeConfig.urls.openclawBase,
    },
    nexuHome: runtimeConfig.paths.nexuHome,
  };
}

// ---------------------------------------------------------------------------
// Main export entry point
// ---------------------------------------------------------------------------

export async function exportDiagnostics({
  orchestrator,
  runtimeConfig,
  source: _source,
  autoSaveToDesktop = false,
}: {
  orchestrator: RuntimeOrchestrator;
  runtimeConfig: DesktopRuntimeConfig;
  source: "diagnostics-page" | "help-menu";
  autoSaveToDesktop?: boolean;
}): Promise<DiagnosticsExportResult> {
  const defaultFilename = `claw-pi-diagnostics-${getTimestampSlug()}.zip`;
  const defaultArchiveRoot = defaultFilename.replace(/\.zip$/i, "");

  let filePath: string | undefined;

  if (autoSaveToDesktop) {
    try {
      filePath = resolve(app.getPath("desktop"), defaultFilename);
    } catch (error) {
      return {
        status: "failed",
        errorMessage:
          error instanceof Error
            ? `无法确定桌面路径: ${error.message}`
            : "无法确定桌面路径",
      };
    }
  } else {
    try {
      const result = await dialog.showSaveDialog({
        title: "Export Diagnostics",
        defaultPath: defaultFilename,
        filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
      });

      if (result.canceled || !result.filePath) {
        return { status: "cancelled" };
      }

      filePath = result.filePath;
    } catch (error) {
      return {
        status: "failed",
        errorMessage:
          error instanceof Error ? error.message : "Save dialog failed.",
      };
    }
  }

  try {
    const archiveRoot =
      filePath
        .split(/[\\/]/)
        .pop()
        ?.replace(/\.zip$/i, "") || defaultArchiveRoot;
    const { entries, warnings } = await collectArtifacts(
      orchestrator,
      runtimeConfig,
      archiveRoot,
    );

    await writeZip(entries, filePath);

    return { status: "success", outputPath: filePath, warnings };
  } catch (error) {
    return {
      status: "failed",
      errorMessage: error instanceof Error ? error.message : "Export failed.",
    };
  }
}
