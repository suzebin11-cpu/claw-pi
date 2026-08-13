import type { ControllerEnv } from "../app/env.js";
import { proxyFetch } from "../lib/proxy-fetch.js";
import type { OpenClawProcessManager } from "../runtime/openclaw-process.js";
import type { NexuConfigStore } from "../store/nexu-config-store.js";
import type { ModelProviderService } from "./model-provider-service.js";

type ActivationServerResponse = {
  token?: string;
  jwt?: string;
  api_key?: string;
  api_base_url?: string;
  user?: { email?: string };
  models?: Array<{ id: string; name: string; provider?: string }>;
  error?: string;
};

type CredentialLoginResult = {
  ok: boolean;
  error?: string;
  email?: string;
};

type RechargeReconcileStatus = "matched" | "cloud_behind" | "cloud_ahead";

type BalanceResult = {
  ok: boolean;
  error?: string;
  balance_cents?: number;
  total_recharged?: number;
  upstream_total_cents?: number;
  recharge_delta_cents?: number;
  recharge_reconcile_status?: RechargeReconcileStatus;
};

type UsageLogItem = {
  id: number;
  model_name: string;
  cost_cents: number;
  prompt_tokens: number;
  completion_tokens: number;
  created_at: string;
};

type UsageLogsResult = {
  success: boolean;
  logs: UsageLogItem[];
  total: number;
  page: number;
  page_size: number;
  error?: string;
};

function maskActivationCode(code: string): string {
  if (code.length <= 8) return code;
  return `${code.slice(0, 4)}...${code.slice(-4)}`;
}

function parseRemoteError(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === "string") {
      return parseRemoteError(parsed.error);
    }
    if (typeof parsed.message === "string") {
      return parsed.message;
    }
  } catch {
    // The upstream may return a plain-text error.
  }
  return text;
}

function parseRemoteErrorCode(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as {
      code?: unknown;
      error?: unknown;
      message?: unknown;
    };
    if (typeof parsed.code === "string") {
      return parsed.code;
    }
    if (typeof parsed.error === "string") {
      return parseRemoteErrorCode(parsed.error);
    }
    if (typeof parsed.message === "string") {
      return parseRemoteErrorCode(parsed.message);
    }
  } catch {
    // Plain-text failures have no structured code.
  }
  return null;
}

const TERMINAL_ACTIVATION_CODES = new Set([
  "AUTH_EXPIRED",
  "INVALID_SESSION",
  "JWT_EXPIRED",
  "SESSION_EXPIRED",
  "SESSION_KICKED",
  "SESSION_REVOKED",
  "TOKEN_EXPIRED",
]);

function isTerminalActivationFailure(text: string): boolean {
  const code = parseRemoteErrorCode(text)?.toUpperCase();
  if (code && TERMINAL_ACTIVATION_CODES.has(code)) {
    return true;
  }

  const message = parseRemoteError(text).toLowerCase();
  return (
    /\b(?:jwt|token|session)\b.{0,24}\b(?:expired|revoked|kicked)\b/u.test(
      message,
    ) ||
    message.includes("账号已在其它设备登录") ||
    message.includes("会话已失效")
  );
}

function readNonNegativeFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function readNumberLike(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readNonNegativeNumberLike(value: unknown): number | undefined {
  const parsed = readNumberLike(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function firstDefinedField(
  record: Record<string, unknown>,
  keys: readonly string[],
): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) {
      return record[key];
    }
  }
  return undefined;
}

function firstArrayField(
  record: Record<string, unknown>,
  keys: readonly string[],
): unknown[] | null {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return null;
}

function readStringField(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  const value = firstDefinedField(record, keys);
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function normalizeUsageLogTimestamp(value: unknown): string {
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value > 10_000_000_000 ? value : value * 1000;
    return new Date(milliseconds).toISOString();
  }
  return new Date().toISOString();
}

function normalizeUsageLogItem(
  value: unknown,
  index: number,
  page: number,
  pageSize: number,
): UsageLogItem | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const id =
    readNumberLike(firstDefinedField(record, ["id", "log_id", "logId"])) ??
    (page - 1) * pageSize + index + 1;
  const modelName =
    readStringField(record, [
      "model_name",
      "modelName",
      "model",
      "model_id",
      "modelId",
      "name",
    ]) ?? "Unknown model";
  const costCents =
    readNonNegativeNumberLike(
      firstDefinedField(record, [
        "cost_cents",
        "costCents",
        "amount_cents",
        "amountCents",
        "fee_cents",
        "feeCents",
        "total_cost_cents",
        "totalCostCents",
      ]),
    ) ?? 0;
  const promptTokens =
    readNonNegativeNumberLike(
      firstDefinedField(record, [
        "prompt_tokens",
        "promptTokens",
        "input_tokens",
        "inputTokens",
        "promptTokenCount",
      ]),
    ) ?? 0;
  const completionTokens =
    readNonNegativeNumberLike(
      firstDefinedField(record, [
        "completion_tokens",
        "completionTokens",
        "output_tokens",
        "outputTokens",
        "completionTokenCount",
      ]),
    ) ?? 0;

  return {
    id: Math.round(id),
    model_name: modelName,
    // Sub-cent charges are common for short prompts. Rounding here made real
    // OpenLux log entries appear as ¥0.000000 in the feeding page.
    cost_cents: costCents,
    prompt_tokens: Math.round(promptTokens),
    completion_tokens: Math.round(completionTokens),
    created_at: normalizeUsageLogTimestamp(
      firstDefinedField(record, [
        "created_at",
        "createdAt",
        "created",
        "timestamp",
        "time",
      ]),
    ),
  };
}

function normalizeUsageLogsResponse(
  raw: unknown,
  page: number,
  pageSize: number,
): UsageLogsResult {
  const root = asRecord(raw);
  if (!root) {
    return {
      success: false,
      logs: [],
      total: 0,
      page,
      page_size: pageSize,
      error: "Usage logs unavailable",
    };
  }

  const dataRecord = asRecord(root.data);
  const payload = dataRecord ?? root;
  const rawLogs =
    firstArrayField(payload, ["logs", "usage_logs", "usageLogs", "items"]) ??
    firstArrayField(root, ["logs", "usage_logs", "usageLogs", "items"]) ??
    (Array.isArray(root.data) ? root.data : []);
  const logs = rawLogs
    .map((item, index) => normalizeUsageLogItem(item, index, page, pageSize))
    .filter((item): item is UsageLogItem => item !== null);
  const error = readStringField(root, ["error", "message"]);
  const success = root.success === false ? false : !error || logs.length > 0;

  return {
    success,
    logs,
    total:
      readNonNegativeNumberLike(
        firstDefinedField(payload, ["total", "total_count", "totalCount"]),
      ) ??
      readNonNegativeNumberLike(
        firstDefinedField(root, ["total", "total_count", "totalCount"]),
      ) ??
      logs.length,
    page:
      readNonNegativeNumberLike(firstDefinedField(payload, ["page"])) ??
      readNonNegativeNumberLike(firstDefinedField(root, ["page"])) ??
      page,
    page_size:
      readNonNegativeNumberLike(
        firstDefinedField(payload, ["page_size", "pageSize", "limit"]),
      ) ??
      readNonNegativeNumberLike(
        firstDefinedField(root, ["page_size", "pageSize", "limit"]),
      ) ??
      pageSize,
    ...(error && logs.length === 0 ? { error: parseRemoteError(error) } : {}),
  };
}

function usageLogsUnavailable(
  page: number,
  pageSize: number,
  error: string,
): UsageLogsResult {
  return {
    success: false,
    logs: [],
    total: 0,
    page,
    page_size: pageSize,
    error,
  };
}

const DNS_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "EAI_FAIL",
  "ENODATA",
  "ENOTFOUND",
]);
const TLS_ERROR_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);
const TIMEOUT_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);
function readNetworkErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") return code.toUpperCase();
  return readNetworkErrorCode((error as { cause?: unknown }).cause);
}

function describeLoginNetworkError(error: unknown): string {
  const code = readNetworkErrorCode(error);
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message.toUpperCase() : "";

  if (
    name === "TimeoutError" ||
    TIMEOUT_ERROR_CODES.has(code) ||
    message.includes("TIMED OUT") ||
    message.includes("CONNECT TIMEOUT")
  ) {
    return "Connection timed out";
  }
  if (
    TLS_ERROR_CODES.has(code) ||
    message.includes("CERTIFICATE") ||
    message.includes("TLS")
  ) {
    return "TLS certificate validation failed";
  }
  if (DNS_ERROR_CODES.has(code) || message.includes("GETADDRINFO")) {
    return "DNS lookup failed";
  }
  return "Server unreachable";
}

function isCredentialRejection(status: number): boolean {
  return status === 400 || status === 401 || status === 403;
}

export class DesktopLocalService {
  private credentialLoginInFlight: Promise<CredentialLoginResult> | null = null;
  private activationCredentialRefreshAt = 0;

  constructor(
    private readonly configStore: NexuConfigStore,
    private readonly modelProviderService: ModelProviderService,
    private readonly openclawProcess: OpenClawProcessManager,
    private readonly env?: ControllerEnv,
  ) {}

  async getCloudStatus() {
    return this.configStore.getDesktopCloudStatus();
  }

  async refreshCloudStatus() {
    const before = await this.modelProviderService.getInventoryStatus();
    const status = await this.configStore.refreshDesktopCloudModels();
    const after = await this.modelProviderService.getInventoryStatus();
    return {
      ...status,
      firstInventoryActivated:
        !before.hasKnownInventory && after.hasKnownInventory,
    };
  }

  async connectCloud() {
    return this.configStore.connectDesktopCloud();
  }

  async connectCloudProfile(name: string) {
    return this.configStore.connectDesktopCloudProfile(name);
  }

  async disconnectCloud() {
    return this.configStore.disconnectDesktopCloud();
  }

  async disconnectCloudProfile(name: string) {
    return this.configStore.disconnectDesktopCloudProfile(name);
  }

  async importCloudProfiles(
    profiles: Array<{ name: string; cloudUrl: string; linkUrl: string }>,
  ) {
    return this.configStore.setDesktopCloudProfiles(profiles);
  }

  async createCloudProfile(profile: {
    name: string;
    cloudUrl: string;
    linkUrl: string;
  }) {
    return this.configStore.createDesktopCloudProfile(profile);
  }

  async switchCloudProfile(name: string) {
    return this.configStore.switchDesktopCloudProfile(name);
  }

  async updateCloudProfile(
    previousName: string,
    profile: { name: string; cloudUrl: string; linkUrl: string },
  ) {
    return this.configStore.updateDesktopCloudProfile(previousName, profile);
  }

  async deleteCloudProfile(name: string) {
    return this.configStore.deleteDesktopCloudProfile(name);
  }

  async setCloudModels(enabledModelIds: string[]) {
    const before = await this.modelProviderService.getInventoryStatus();
    const result =
      await this.configStore.setDesktopCloudModels(enabledModelIds);
    const after = await this.modelProviderService.getInventoryStatus();
    return {
      ...result,
      firstInventoryActivated:
        !before.hasKnownInventory && after.hasKnownInventory,
    };
  }

  async setDefaultModel(modelId: string) {
    await this.configStore.setDefaultModel(modelId);
    await this.configStore.markFastDefaultModelMigrationComplete();
    void this.syncModelGroupToCloud(modelId);
    return { ok: true, modelId };
  }

  async setDefaultImageGenerationModel(modelId: string) {
    await this.configStore.setDefaultImageGenerationModel(modelId);
    return { ok: true, modelId };
  }

  private async syncModelGroupToCloud(modelId: string): Promise<void> {
    try {
      const jwt = await this.configStore.getActivationJwt();
      if (!jwt) return;

      const cloudStatus = await this.configStore.getDesktopCloudStatus();
      const cloudUrl = cloudStatus.cloudUrl;

      const rawModelId = modelId.replace(/^link\//, "");
      const res = await proxyFetch(`${cloudUrl}/api/auth/switch-model`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({ model_id: rawModelId }),
        timeoutMs: 10_000,
      });
      await this.clearActivationIfUnauthorized(res);
    } catch {
      // best-effort: don't block model switch if cloud sync fails
    }
  }

  async restartRuntime(): Promise<void> {
    await this.openclawProcess.stop();
    this.openclawProcess.enableAutoRestart();
    this.openclawProcess.start();
  }

  async getActivationStatus() {
    return this.configStore.getActivationStatus();
  }

  async logout(): Promise<{ ok: boolean }> {
    // Only clear activation state (JWT / email / code prefix). Intentionally
    // NOT calling disconnectDesktopCloud(): wiping cloud.linkUrl/apiKey/models
    // would rewrite openclaw.json without any `models.providers`, which makes
    // OpenClaw fall back to the hardcoded "openai" provider for bare model
    // refs and throw "No API key found for provider 'openai'" for any message
    // that arrives through external channels (weixin/feishu/cron) between
    // logout and the next successful login. The next loginWithCredentials /
    // registerWithCode call overwrites cloud state with the fresh api_key, so
    // leaving the previous snapshot in place is both safe and less disruptive.
    await this.configStore.clearActivation();
    return { ok: true };
  }

  private async clearActivationIfUnauthorized(
    response: Response,
  ): Promise<boolean> {
    if (response.status !== 401) {
      return false;
    }

    const text = await response
      .clone()
      .text()
      .catch(() => "");
    if (!isTerminalActivationFailure(text)) {
      return false;
    }

    await this.configStore.clearActivation();
    return true;
  }

  /**
   * Refresh the fixed child token for an existing authenticated desktop.
   * This repairs sessions that still cache an upstream key from before an
   * upstream migration without requiring the user to enter their password.
   */
  private async refreshActivationCredentials(
    jwt: string,
    cloudUrl: string,
  ): Promise<void> {
    const nowMs = Date.now();
    if (nowMs - this.activationCredentialRefreshAt < 60_000) return;
    this.activationCredentialRefreshAt = nowMs;

    try {
      const res = await proxyFetch(`${cloudUrl}/api/auth/user-activate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}` },
        timeoutMs: 10_000,
      });
      if (!res.ok) return;

      const data = (await res.json()) as ActivationServerResponse;
      if (!data.api_key) return;

      const currentApiKey = await this.configStore.getActivationApiKey();
      if (currentApiKey === data.api_key) return;

      const status = await this.configStore.getActivationStatus();
      const refreshedAt = new Date().toISOString();
      await this.configStore.setActivationState({
        activated: true,
        email: status.email,
        jwt,
        apiKey: data.api_key,
        activatedAt: status.activatedAt ?? refreshedAt,
        codePrefix: status.codePrefix,
      });
      await this.configStore.applyActivationCloudState({
        connected: true,
        polling: false,
        userName: status.email,
        userEmail: status.email,
        connectedAt: refreshedAt,
        linkUrl: data.api_base_url ?? null,
        apiKey: data.api_key,
        models: data.models ?? [],
      });
    } catch {
      // Best effort: the authoritative balance/log request below still reports
      // its own failure and must never be replaced by another account's bill.
    }
  }

  async registerWithCode(input: {
    code: string;
    email: string;
    password: string;
  }): Promise<{
    ok: boolean;
    error?: string;
    email?: string;
    activatedAt?: string;
  }> {
    const cloudStatus = await this.configStore.getDesktopCloudStatus();
    const cloudUrl = cloudStatus.cloudUrl;
    const deviceId = await this.configStore.getOrCreateActivationDeviceId();

    let res: Response;
    try {
      res = await proxyFetch(`${cloudUrl}/api/auth/register-with-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: input.code,
          email: input.email,
          password: input.password,
          device_id: deviceId,
          deviceId,
        }),
        timeoutMs: 15_000,
      });
    } catch (error) {
      return { ok: false, error: describeLoginNetworkError(error) };
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "Unknown error");
      return { ok: false, error: text };
    }

    const data = (await res.json()) as ActivationServerResponse;
    if (data.error) {
      return { ok: false, error: data.error };
    }

    const jwt = data.jwt ?? data.token ?? null;
    const now = new Date().toISOString();
    await this.configStore.setActivationState({
      activated: true,
      email: input.email,
      jwt,
      apiKey: data.api_key ?? null,
      activatedAt: now,
      codePrefix: maskActivationCode(input.code),
      deviceId,
    });

    if (data.api_key) {
      await this.configStore.applyActivationCloudState({
        connected: true,
        polling: false,
        userName: data.user?.email ?? input.email,
        userEmail: input.email,
        connectedAt: now,
        linkUrl: data.api_base_url ?? null,
        apiKey: data.api_key,
        models: data.models ?? [],
      });
    }

    return { ok: true, email: input.email, activatedAt: now };
  }

  async redeemRechargeCode(code: string): Promise<{
    ok: boolean;
    error?: string;
    added_cents?: number;
    new_balance_cents?: number;
  }> {
    const jwt = await this.configStore.getActivationJwt();
    if (!jwt) {
      return { ok: false, error: "Not authenticated" };
    }

    const cloudStatus = await this.configStore.getDesktopCloudStatus();
    const cloudUrl = cloudStatus.cloudUrl;

    let res: Response;
    try {
      res = await proxyFetch(`${cloudUrl}/api/auth/redeem-recharge`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({ code }),
        timeoutMs: 15_000,
      });
    } catch {
      return { ok: false, error: "Server unreachable" };
    }

    if (!res.ok) {
      if (await this.clearActivationIfUnauthorized(res)) {
        return { ok: false, error: "Not authenticated" };
      }
      const text = await res.text().catch(() => "Unknown error");
      try {
        const parsed = JSON.parse(text) as { error?: string };
        return { ok: false, error: parsed.error ?? text };
      } catch {
        return { ok: false, error: text };
      }
    }

    const data = (await res.json()) as {
      success?: boolean;
      added_cents?: number;
      new_balance_cents?: number;
      error?: string;
    };
    if (data.error) {
      return { ok: false, error: data.error };
    }

    return {
      ok: true,
      added_cents: data.added_cents,
      new_balance_cents: data.new_balance_cents,
    };
  }

  async getBalance(): Promise<BalanceResult> {
    const jwt = await this.configStore.getActivationJwt();
    if (!jwt) {
      return { ok: false, error: "Not authenticated" };
    }

    const cloudStatus = await this.configStore.getDesktopCloudStatus();
    const cloudUrl = cloudStatus.cloudUrl;
    await this.refreshActivationCredentials(jwt, cloudUrl);

    let res: Response;
    try {
      res = await proxyFetch(`${cloudUrl}/api/auth/balance`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${jwt}`,
        },
        timeoutMs: 10_000,
      });
    } catch {
      return {
        ok: false,
        error: "Server unreachable",
      };
    }

    if (!res.ok) {
      if (await this.clearActivationIfUnauthorized(res)) {
        return { ok: false, error: "Not authenticated" };
      }
      const text = await res.text().catch(() => "Unknown error");
      return { ok: false, error: parseRemoteError(text) };
    }

    let data: {
      success?: boolean;
      balance_cents?: number;
      total_recharged?: number;
      error?: string;
    };
    try {
      data = (await res.json()) as typeof data;
    } catch {
      return { ok: false, error: "Balance unavailable" };
    }
    if (data.error) {
      return { ok: false, error: parseRemoteError(data.error) };
    }
    if (data.success === false) {
      return { ok: false, error: "Balance unavailable" };
    }
    const balanceCents = readNonNegativeFiniteNumber(data.balance_cents);
    const totalRecharged = readNonNegativeFiniteNumber(data.total_recharged);

    if (balanceCents === undefined) {
      return { ok: false, error: "Balance unavailable" };
    }

    return {
      ok: true,
      balance_cents: balanceCents,
      ...(totalRecharged === undefined
        ? {}
        : { total_recharged: totalRecharged }),
    };
  }

  async loginWithCredentials(input: {
    email: string;
    password: string;
  }): Promise<CredentialLoginResult> {
    if (this.credentialLoginInFlight) {
      return this.credentialLoginInFlight;
    }

    const request = this.performCredentialLogin(input);
    this.credentialLoginInFlight = request;
    try {
      return await request;
    } finally {
      if (this.credentialLoginInFlight === request) {
        this.credentialLoginInFlight = null;
      }
    }
  }

  private async performCredentialLogin(input: {
    email: string;
    password: string;
  }): Promise<CredentialLoginResult> {
    const cloudStatus = await this.configStore.getDesktopCloudStatus();
    const cloudUrl = cloudStatus.cloudUrl;
    const deviceId = await this.configStore.getOrCreateActivationDeviceId();

    let res: Response;
    try {
      res = await proxyFetch(`${cloudUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: input.email,
          password: input.password,
          device_id: deviceId,
          deviceId,
        }),
        timeoutMs: 15_000,
      });
    } catch (error) {
      return { ok: false, error: describeLoginNetworkError(error) };
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "Unknown error");
      return {
        ok: false,
        error: isCredentialRejection(res.status)
          ? "Invalid email or password"
          : parseRemoteError(text),
      };
    }

    const data = (await res.json()) as ActivationServerResponse;
    if (data.error) {
      return { ok: false, error: data.error };
    }

    const jwt = data.jwt ?? data.token ?? null;
    const now = new Date().toISOString();
    const existingStatus = await this.configStore.getActivationStatus();
    await this.configStore.setActivationState({
      activated: true,
      email: input.email,
      jwt,
      apiKey: data.api_key ?? null,
      activatedAt: existingStatus.activatedAt ?? now,
      codePrefix: existingStatus.codePrefix ?? null,
      deviceId,
    });

    if (data.api_key) {
      await this.configStore.applyActivationCloudState({
        connected: true,
        polling: false,
        userName: data.user?.email ?? input.email,
        userEmail: input.email,
        connectedAt: now,
        linkUrl: data.api_base_url ?? null,
        apiKey: data.api_key,
        models: data.models ?? [],
      });
    }

    return { ok: true, email: input.email };
  }

  async getTransactions(page: number, pageSize: number) {
    const jwt = await this.configStore.getActivationJwt();
    if (!jwt) {
      return {
        success: false,
        transactions: [],
        total: 0,
        page,
        page_size: pageSize,
        error: "Not authenticated",
      };
    }

    const cloudStatus = await this.configStore.getDesktopCloudStatus();
    const cloudUrl = cloudStatus.cloudUrl;
    const url = `${cloudUrl}/api/auth/transactions?page=${page}&page_size=${pageSize}`;

    let res: Response;
    try {
      res = await proxyFetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${jwt}` },
        timeoutMs: 10_000,
      });
    } catch {
      return {
        success: false,
        transactions: [],
        total: 0,
        page,
        page_size: pageSize,
        error: "Server unreachable",
      };
    }

    if (!res.ok) {
      if (await this.clearActivationIfUnauthorized(res)) {
        return {
          success: false,
          transactions: [],
          total: 0,
          page,
          page_size: pageSize,
          error: "Not authenticated",
        };
      }
      const text = await res.text().catch(() => "Unknown error");
      return {
        success: false,
        transactions: [],
        total: 0,
        page,
        page_size: pageSize,
        error: parseRemoteError(text),
      };
    }

    return (await res.json()) as {
      success: boolean;
      transactions: Array<{
        id: number;
        type: string;
        amount_cents: number;
        balance_after: number;
        description: string;
        created_at: string;
      }>;
      total: number;
      page: number;
      page_size: number;
      error?: string;
    };
  }

  // ── Alipay Payment Proxy ──

  async createAlipayOrder(amountCents: number): Promise<{
    ok: boolean;
    qr_code?: string;
    out_trade_no?: string;
    error?: string;
  }> {
    const jwt = await this.configStore.getActivationJwt();
    if (!jwt) {
      return { ok: false, error: "Not authenticated" };
    }

    const cloudStatus = await this.configStore.getDesktopCloudStatus();
    const cloudUrl = cloudStatus.cloudUrl;
    const returnUrl = this.env
      ? `${this.env.webUrl}/workspace/recharge`
      : undefined;

    let res: Response;
    try {
      res = await proxyFetch(`${cloudUrl}/api/payment/alipay/create-order`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({
          amount_cents: amountCents,
          return_url: returnUrl,
        }),
        timeoutMs: 15_000,
      });
    } catch {
      return { ok: false, error: "Server unreachable" };
    }

    if (!res.ok) {
      if (await this.clearActivationIfUnauthorized(res)) {
        return { ok: false, error: "Not authenticated" };
      }
      const text = await res.text().catch(() => "Unknown error");
      try {
        const parsed = JSON.parse(text) as { error?: string };
        return { ok: false, error: parsed.error ?? text };
      } catch {
        return { ok: false, error: text };
      }
    }

    const data = (await res.json()) as {
      qr_code?: string;
      out_trade_no?: string;
      error?: string;
    };
    if (data.error) {
      return { ok: false, error: data.error };
    }

    return {
      ok: true,
      qr_code: data.qr_code,
      out_trade_no: data.out_trade_no,
    };
  }

  async queryAlipayOrder(outTradeNo: string): Promise<{
    ok: boolean;
    status?: string;
    added_cents?: number;
    new_balance_cents?: number;
    error?: string;
  }> {
    const jwt = await this.configStore.getActivationJwt();
    if (!jwt) {
      return { ok: false, error: "Not authenticated" };
    }

    const cloudStatus = await this.configStore.getDesktopCloudStatus();
    const cloudUrl = cloudStatus.cloudUrl;

    let res: Response;
    try {
      res = await proxyFetch(`${cloudUrl}/api/payment/alipay/query-order`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({ out_trade_no: outTradeNo }),
        timeoutMs: 10_000,
      });
    } catch {
      return { ok: false, error: "Server unreachable" };
    }

    if (!res.ok) {
      if (await this.clearActivationIfUnauthorized(res)) {
        return { ok: false, error: "Not authenticated" };
      }
      const text = await res.text().catch(() => "Unknown error");
      try {
        const parsed = JSON.parse(text) as { error?: string };
        return { ok: false, error: parsed.error ?? text };
      } catch {
        return { ok: false, error: text };
      }
    }

    const data = (await res.json()) as {
      status?: string;
      added_cents?: number;
      new_balance_cents?: number;
      error?: string;
    };
    if (data.error) {
      return { ok: false, error: data.error };
    }

    return {
      ok: true,
      status: data.status,
      added_cents: data.added_cents,
      new_balance_cents: data.new_balance_cents,
    };
  }

  async cancelAlipayOrder(outTradeNo: string): Promise<{
    ok: boolean;
    error?: string;
  }> {
    const jwt = await this.configStore.getActivationJwt();
    if (!jwt) {
      return { ok: false, error: "Not authenticated" };
    }

    const cloudStatus = await this.configStore.getDesktopCloudStatus();
    const cloudUrl = cloudStatus.cloudUrl;

    let res: Response;
    try {
      res = await proxyFetch(`${cloudUrl}/api/payment/alipay/cancel-order`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({ out_trade_no: outTradeNo }),
        timeoutMs: 10_000,
      });
    } catch {
      return { ok: false, error: "Server unreachable" };
    }

    if (!res.ok) {
      if (await this.clearActivationIfUnauthorized(res)) {
        return { ok: false, error: "Not authenticated" };
      }
      const text = await res.text().catch(() => "Unknown error");
      try {
        const parsed = JSON.parse(text) as { error?: string };
        return { ok: false, error: parsed.error ?? text };
      } catch {
        return { ok: false, error: text };
      }
    }

    const data = (await res.json()) as { ok?: boolean; error?: string };
    if (data.error) {
      return { ok: false, error: data.error };
    }

    return { ok: true };
  }

  async getPendingAlipayOrders(): Promise<{
    ok: boolean;
    orders?: Array<{
      out_trade_no: string;
      amount_cents: number;
      qr_code: string;
      created_at: string;
    }>;
    error?: string;
  }> {
    const jwt = await this.configStore.getActivationJwt();
    if (!jwt) {
      return { ok: false, error: "Not authenticated" };
    }

    const cloudStatus = await this.configStore.getDesktopCloudStatus();
    const cloudUrl = cloudStatus.cloudUrl;

    let res: Response;
    try {
      res = await proxyFetch(`${cloudUrl}/api/payment/alipay/pending-orders`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${jwt}`,
        },
        timeoutMs: 10_000,
      });
    } catch {
      return { ok: false, error: "Server unreachable" };
    }

    if (!res.ok) {
      if (await this.clearActivationIfUnauthorized(res)) {
        return { ok: false, error: "Not authenticated" };
      }
      const text = await res.text().catch(() => "Unknown error");
      return { ok: false, error: text };
    }

    const data = (await res.json()) as {
      orders?: Array<{
        out_trade_no: string;
        amount_cents: number;
        qr_code: string;
        created_at: string;
      }>;
      error?: string;
    };
    if (data.error) {
      return { ok: false, error: data.error };
    }

    return { ok: true, orders: data.orders ?? [] };
  }

  async getUsageLogs(page: number, pageSize: number) {
    const jwt = await this.configStore.getActivationJwt();
    if (!jwt) {
      return {
        success: false,
        logs: [],
        total: 0,
        page,
        page_size: pageSize,
        error: "Not authenticated",
      };
    }

    const cloudStatus = await this.configStore.getDesktopCloudStatus();
    const cloudUrl = cloudStatus.cloudUrl;
    await this.refreshActivationCredentials(jwt, cloudUrl);
    const url = `${cloudUrl}/api/auth/usage-logs?page=${page}&page_size=${pageSize}`;

    let res: Response;
    try {
      res = await proxyFetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${jwt}` },
        timeoutMs: 10_000,
      });
    } catch {
      return usageLogsUnavailable(page, pageSize, "Server unreachable");
    }

    if (!res.ok) {
      if (await this.clearActivationIfUnauthorized(res)) {
        return usageLogsUnavailable(page, pageSize, "Not authenticated");
      }
      const text = await res.text().catch(() => "Unknown error");
      return usageLogsUnavailable(page, pageSize, parseRemoteError(text));
    }

    let normalized: UsageLogsResult;
    try {
      normalized = normalizeUsageLogsResponse(await res.json(), page, pageSize);
    } catch {
      return usageLogsUnavailable(page, pageSize, "Usage logs unavailable");
    }
    return normalized;
  }
}
