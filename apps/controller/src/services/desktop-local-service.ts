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

export class DesktopLocalService {
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
      await proxyFetch(`${cloudUrl}/api/auth/switch-model`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({ model_id: rawModelId }),
        timeoutMs: 10_000,
      });
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

    let res: Response;
    try {
      res = await proxyFetch(`${cloudUrl}/api/auth/register-with-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: input.code,
          email: input.email,
          password: input.password,
        }),
        timeoutMs: 15_000,
      });
    } catch {
      return { ok: false, error: "Server unreachable" };
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

  async getBalance(): Promise<{
    ok: boolean;
    error?: string;
    balance_cents?: number;
    total_recharged?: number;
  }> {
    const jwt = await this.configStore.getActivationJwt();
    if (!jwt) {
      return { ok: false, error: "Not authenticated" };
    }

    const cloudStatus = await this.configStore.getDesktopCloudStatus();
    const cloudUrl = cloudStatus.cloudUrl;

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
      const text = await res.text().catch(() => "Unknown error");
      return {
        ok: false,
        error: parseRemoteError(text),
      };
    }

    const data = (await res.json()) as {
      success?: boolean;
      balance_cents?: number;
      total_recharged?: number;
      error?: string;
    };
    if (data.error) {
      return {
        ok: false,
        error: parseRemoteError(data.error),
      };
    }

    return {
      ok: true,
      balance_cents: data.balance_cents,
      total_recharged: data.total_recharged,
    };
  }

  async loginWithCredentials(input: {
    email: string;
    password: string;
  }): Promise<{ ok: boolean; error?: string; email?: string }> {
    const cloudStatus = await this.configStore.getDesktopCloudStatus();
    const cloudUrl = cloudStatus.cloudUrl;

    let res: Response;
    try {
      res = await proxyFetch(`${cloudUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: input.email,
          password: input.password,
        }),
        timeoutMs: 15_000,
      });
    } catch {
      return { ok: false, error: "Server unreachable" };
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
    const existingStatus = await this.configStore.getActivationStatus();
    await this.configStore.setActivationState({
      activated: true,
      email: input.email,
      jwt,
      apiKey: data.api_key ?? null,
      activatedAt: existingStatus.activatedAt ?? now,
      codePrefix: existingStatus.codePrefix ?? null,
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
      const text = await res.text().catch(() => "Unknown error");
      return {
        success: false,
        transactions: [],
        total: 0,
        page,
        page_size: pageSize,
        error: text,
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
    const url = `${cloudUrl}/api/auth/usage-logs?page=${page}&page_size=${pageSize}`;

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
        logs: [],
        total: 0,
        page,
        page_size: pageSize,
        error: "Server unreachable",
      };
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "Unknown error");
      return {
        success: false,
        logs: [],
        total: 0,
        page,
        page_size: pageSize,
        error: text,
      };
    }

    return (await res.json()) as {
      success: boolean;
      logs: Array<{
        id: number;
        model_name: string;
        cost_cents: number;
        prompt_tokens: number;
        completion_tokens: number;
        created_at: string;
      }>;
      total: number;
      page: number;
      page_size: number;
      error?: string;
    };
  }
}
