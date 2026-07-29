import { ProviderLogo } from "@/components/provider-logo";
import { cn } from "@/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  // CreditCard,
  History,
  Loader2,
  QrCode,
  Receipt,
  RefreshCw,
  Wallet,
  X,
  Zap,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getApiInternalActivationBalance,
  getApiInternalActivationTransactions,
  getApiInternalActivationUsageLogs,
  getApiInternalPaymentAlipayPendingOrders,
  getApiV1Models,
  // postApiInternalActivationRecharge,
  postApiInternalPaymentAlipayCancelOrder,
  postApiInternalPaymentAlipayCreateOrder,
  postApiInternalPaymentAlipayQueryOrder,
} from "../../lib/api/sdk.gen";

// ── Pricing data ──────────────────────────────────────────────

interface ModelPrice {
  id: string;
  name: string;
  provider: string;
  matchIds: string[];
  inputPerM: number;
  outputPerM: number;
  modelRatio: number;
  completionRatio: number;
  tag?: "cheapest" | "recommended" | "powerful" | "strongest";
}

interface ProviderGroup {
  key: string;
  name: string;
  accent: string;
  models: ModelPrice[];
}

type ApiModel = {
  id: string;
  name: string;
  provider: string;
};

const PROVIDER_META: Record<string, { name: string; accent: string }> = {
  google: { name: "Google Gemini", accent: "#4285F4" },
  anthropic: { name: "Anthropic Claude", accent: "#D97757" },
  openai: { name: "OpenAI GPT", accent: "#10A37F" },
  deepseek: { name: "DeepSeek", accent: "#4D6BFE" },
  grok: { name: "Grok xAI", accent: "#8B949E" },
};

const CLOUD_PRICING_MODELS: ModelPrice[] = [
  {
    id: "gemini-3.1-flash-lite-preview",
    name: "Gemini 3.1 Flash Lite",
    provider: "google",
    matchIds: ["gemini-3.1-flash-lite-preview", "gemini-3.1-flash-lite"],
    modelRatio: 0.125,
    completionRatio: 6,
    inputPerM: 0.25,
    outputPerM: 1.5,
    tag: "cheapest",
  },
  {
    id: "gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro",
    provider: "google",
    matchIds: ["gemini-3.1-pro-preview", "gemini-3.1-pro"],
    modelRatio: 1,
    completionRatio: 6,
    inputPerM: 2,
    outputPerM: 12,
    tag: "powerful",
  },
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    provider: "anthropic",
    matchIds: ["claude-haiku-4-5", "claude-haiku-4-5-20251001"],
    modelRatio: 0.5,
    completionRatio: 5,
    inputPerM: 1,
    outputPerM: 5,
    tag: "cheapest",
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    provider: "anthropic",
    matchIds: ["claude-sonnet-4-6"],
    modelRatio: 1.5,
    completionRatio: 5,
    inputPerM: 3,
    outputPerM: 15,
    tag: "recommended",
  },
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    provider: "anthropic",
    matchIds: ["claude-opus-4-6"],
    modelRatio: 2.5,
    completionRatio: 5,
    inputPerM: 5,
    outputPerM: 25,
    tag: "powerful",
  },
  {
    id: "gpt-5.4-nano",
    name: "GPT-5.4 Nano",
    provider: "openai",
    matchIds: ["gpt-5.4-nano"],
    modelRatio: 0.1,
    completionRatio: 6.25,
    inputPerM: 0.2,
    outputPerM: 1.25,
    tag: "cheapest",
  },
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    provider: "openai",
    matchIds: ["gpt-5.4-mini"],
    modelRatio: 0.375,
    completionRatio: 6,
    inputPerM: 0.75,
    outputPerM: 4.5,
    tag: "recommended",
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    provider: "openai",
    matchIds: ["gpt-5.4"],
    modelRatio: 1.25,
    completionRatio: 6,
    inputPerM: 2.5,
    outputPerM: 15,
  },
  {
    id: "gpt-5.5",
    name: "GPT-5.5",
    provider: "openai",
    matchIds: ["gpt-5.5"],
    modelRatio: 2.5,
    completionRatio: 6,
    inputPerM: 5,
    outputPerM: 30,
    tag: "powerful",
  },
  {
    id: "gpt-5.6",
    name: "GPT-5.6",
    provider: "openai",
    matchIds: ["gpt-5.6"],
    modelRatio: 2.5,
    completionRatio: 6,
    inputPerM: 5,
    outputPerM: 30,
    tag: "strongest",
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    provider: "deepseek",
    matchIds: ["deepseek-v4-flash"],
    modelRatio: 0.5,
    completionRatio: 2,
    inputPerM: 1,
    outputPerM: 2,
    tag: "cheapest",
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    provider: "deepseek",
    matchIds: ["deepseek-v4-pro"],
    modelRatio: 6,
    completionRatio: 2,
    inputPerM: 12,
    outputPerM: 24,
    tag: "powerful",
  },
  {
    id: "grok-4.2-fast",
    name: "Grok 4.2 Fast",
    provider: "grok",
    matchIds: ["grok-4.2-fast"],
    modelRatio: 0.2,
    completionRatio: 7.5,
    inputPerM: 0.4,
    outputPerM: 3,
    tag: "cheapest",
  },
  {
    id: "grok-4.2",
    name: "Grok 4.2",
    provider: "grok",
    matchIds: ["grok-4.2"],
    modelRatio: 1.5,
    completionRatio: 5,
    inputPerM: 3,
    outputPerM: 15,
  },
];

function canonicalModelId(modelId: string): string {
  return modelId.includes("/")
    ? modelId.split("/").slice(1).join("/")
    : modelId;
}

function findPricingModel(model: ApiModel): ModelPrice | undefined {
  const id = canonicalModelId(model.id).toLowerCase();
  const name = model.name.toLowerCase();
  return CLOUD_PRICING_MODELS.find((pricing) =>
    pricing.matchIds.some((candidate) => {
      const normalized = candidate.toLowerCase();
      return id === normalized || name === normalized;
    }),
  );
}

function buildPricingProviders(
  models: ApiModel[] | undefined,
): ProviderGroup[] {
  const selected = new Map<string, ModelPrice>();
  if (models && models.length > 0) {
    for (const model of models) {
      const pricing = findPricingModel(model);
      if (pricing) selected.set(pricing.id, pricing);
    }
  }

  const effectiveModels =
    selected.size > 0 ? Array.from(selected.values()) : CLOUD_PRICING_MODELS;
  const groups = new Map<string, ProviderGroup>();
  for (const model of effectiveModels) {
    const meta = PROVIDER_META[model.provider] ?? {
      name: model.provider,
      accent: "#8B949E",
    };
    const group =
      groups.get(model.provider) ??
      ({
        key: model.provider,
        name: meta.name,
        accent: meta.accent,
        models: [],
      } satisfies ProviderGroup);
    group.models.push(model);
    groups.set(model.provider, group);
  }

  return Array.from(groups.values());
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(Math.round(n));
}

function formatYuan(n: number): string {
  if (n < 1) return `¥${n.toFixed(2)}`;
  return `¥${n.toFixed(2)}`;
}

const TAG_CONFIG = {
  cheapest: {
    label: "最划算",
    dot: "bg-emerald-400",
    ring: "ring-emerald-400/20",
    text: "text-emerald-600 dark:text-emerald-400",
  },
  recommended: {
    label: "推荐",
    dot: "bg-blue-400",
    ring: "ring-blue-400/20",
    text: "text-blue-600 dark:text-blue-400",
  },
  powerful: {
    label: "最强性能",
    dot: "bg-purple-400",
    ring: "ring-purple-400/20",
    text: "text-purple-600 dark:text-purple-400",
  },
  strongest: {
    label: "最强智力",
    dot: "bg-amber-400",
    ring: "ring-amber-400/20",
    text: "text-amber-600 dark:text-amber-400",
  },
} as const;

function TagBadge({ tag }: { tag: ModelPrice["tag"] }) {
  if (!tag) return null;
  const cfg = TAG_CONFIG[tag];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1",
        cfg.text,
        cfg.ring,
      )}
    >
      <span className={cn("size-1.5 rounded-full", cfg.dot)} />
      {cfg.label}
    </span>
  );
}

function PricingModelCard({
  model,
  accent,
}: {
  model: ModelPrice;
  accent: string;
}) {
  const outputPerYuan = Math.round(1_000_000 / model.outputPerM);

  return (
    <div className="rounded-xl border border-border bg-surface-0 p-4 transition-colors hover:border-border-hover">
      <div className="mb-3">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="w-5 h-5 rounded-md flex items-center justify-center shrink-0">
            <ProviderLogo provider={model.provider} size={14} />
          </span>
          <span className="text-[13px] font-semibold text-text-primary">
            {model.name}
          </span>
        </div>
        <TagBadge tag={model.tag} />
      </div>

      <div className="grid grid-cols-2 gap-2 mb-3">
        <div className="rounded-lg bg-surface-1 px-3 py-2">
          <div className="text-[10px] font-medium text-text-muted uppercase tracking-wider mb-0.5">
            你发送的
          </div>
          <div className="text-[15px] font-bold text-text-primary tabular-nums">
            {formatYuan(model.inputPerM)}
          </div>
          <div className="text-[10px] text-text-muted">/ 100万 tokens</div>
        </div>
        <div className="rounded-lg bg-surface-1 px-3 py-2">
          <div className="text-[10px] font-medium text-text-muted uppercase tracking-wider mb-0.5">
            AI 回复的
          </div>
          <div className="text-[15px] font-bold text-text-primary tabular-nums">
            {formatYuan(model.outputPerM)}
          </div>
          <div className="text-[10px] text-text-muted">/ 100万 tokens</div>
        </div>
      </div>

      <div
        className="rounded-lg px-3 py-2"
        style={{ backgroundColor: `${accent}10` }}
      >
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-text-secondary">
            倍率 {model.modelRatio}x / 输出 {model.completionRatio}x
          </span>
          <span
            className="text-[13px] font-bold tabular-nums"
            style={{ color: accent }}
          >
            {formatTokenCount(outputPerYuan)} 输出 tokens
          </span>
        </div>
      </div>
    </div>
  );
}

function PricingProviderSection({ provider }: { provider: ProviderGroup }) {
  return (
    <div className="mb-8">
      <div className="flex items-center gap-2.5 mb-4">
        <span className="w-7 h-7 rounded-lg flex items-center justify-center bg-surface-1 border border-border-subtle shrink-0">
          <ProviderLogo provider={provider.key} size={16} />
        </span>
        <h3 className="text-[14px] font-semibold text-text-primary">
          {provider.name}
        </h3>
      </div>
      <div
        className={cn(
          "grid gap-3",
          provider.models.length === 2
            ? "grid-cols-1 sm:grid-cols-2"
            : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
        )}
      >
        {provider.models.map((m) => (
          <PricingModelCard key={m.id} model={m} accent={provider.accent} />
        ))}
      </div>
    </div>
  );
}

function ValueComparisonChart({ providers }: { providers: ProviderGroup[] }) {
  const allModels = useMemo(() => {
    const flat = providers.flatMap((p) =>
      p.models.map((m) => ({
        ...m,
        accent: p.accent,
        outputPerYuan: Math.round(1_000_000 / m.outputPerM),
      })),
    );
    return flat.sort((a, b) => b.outputPerYuan - a.outputPerYuan);
  }, [providers]);

  const maxValue = allModels[0]?.outputPerYuan ?? 1;

  return (
    <div className="space-y-2">
      {allModels.map((m) => {
        const pct = Math.max(
          4,
          (Math.sqrt(m.outputPerYuan) / Math.sqrt(maxValue)) * 100,
        );
        return (
          <div key={m.id} className="group flex items-center gap-3">
            <div className="w-32 sm:w-40 shrink-0 text-right">
              <span className="text-[11px] text-text-secondary group-hover:text-text-primary transition-colors">
                {m.name}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <div
                className="h-7 rounded-md flex items-center px-2.5 transition-all duration-300 group-hover:brightness-110"
                style={{
                  width: `${pct}%`,
                  background: `linear-gradient(90deg, ${m.accent}30, ${m.accent}15)`,
                  border: `1px solid ${m.accent}25`,
                }}
              >
                <span className="text-[11px] font-semibold text-text-primary whitespace-nowrap tabular-nums">
                  {formatTokenCount(m.outputPerYuan)}
                </span>
              </div>
            </div>
          </div>
        );
      })}
      <p className="text-[10px] text-text-muted mt-2 text-right">
        每 ¥1 约可获得的输出 tokens（平方根比例）
      </p>
    </div>
  );
}

// ── Transaction & Usage components ─────────────────────────────

type HistoryTab = "transactions" | "usage";

function Pagination({
  page,
  totalPages,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  onPageChange: (p: number) => void;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-center gap-2 mt-4">
      <button
        type="button"
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
        className="p-1.5 rounded-lg border border-border text-text-muted hover:bg-surface-1 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      >
        <ChevronLeft size={14} />
      </button>
      <span className="text-[12px] text-text-secondary tabular-nums">
        {page} / {totalPages}
      </span>
      <button
        type="button"
        disabled={page >= totalPages}
        onClick={() => onPageChange(page + 1)}
        className="p-1.5 rounded-lg border border-border text-text-muted hover:bg-surface-1 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      >
        <ChevronRight size={14} />
      </button>
    </div>
  );
}

function TransactionList() {
  const [page, setPage] = useState(1);
  const pageSize = 10;

  const { data, isLoading } = useQuery({
    queryKey: ["transactions", page, pageSize],
    queryFn: async () => {
      const { data } = await getApiInternalActivationTransactions({
        query: { page, page_size: pageSize },
      });
      return (
        data ?? {
          success: false,
          transactions: [],
          total: 0,
          page,
          page_size: pageSize,
        }
      );
    },
  });

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / pageSize));

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 size={16} className="animate-spin text-text-muted" />
      </div>
    );
  }

  const transactions = data?.transactions ?? [];

  if (transactions.length === 0) {
    return (
      <div className="text-center py-8 text-[12px] text-text-muted">
        暂无充值记录
      </div>
    );
  }

  return (
    <div>
      <div className="space-y-0">
        {transactions.map((tx) => {
          const isPositive = tx.amount_cents > 0;
          const amountYuan = (Math.abs(tx.amount_cents) / 100).toFixed(2);
          const balanceYuan = (tx.balance_after / 100).toFixed(2);
          const date = new Date(tx.created_at);
          const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
          return (
            <div
              key={tx.id}
              className="flex items-center justify-between gap-3 px-3 py-3 border-b border-border-subtle last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <div className="text-[12px] text-text-primary truncate">
                  {tx.description}
                </div>
                <div className="text-[10px] text-text-muted mt-0.5">
                  {dateStr}
                </div>
              </div>
              <div className="text-right shrink-0">
                <div
                  className={cn(
                    "text-[13px] font-semibold tabular-nums",
                    isPositive ? "text-emerald-600" : "text-text-primary",
                  )}
                >
                  {isPositive ? "+" : "-"}¥{amountYuan}
                </div>
                <div className="text-[10px] text-text-muted tabular-nums">
                  余额 ¥{balanceYuan}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}

function UsageLogList() {
  const [page, setPage] = useState(1);
  const pageSize = 10;

  const { data, isLoading } = useQuery({
    queryKey: ["usage-logs", page, pageSize],
    queryFn: async () => {
      const { data } = await getApiInternalActivationUsageLogs({
        query: { page, page_size: pageSize },
      });
      return (
        data ?? {
          success: false,
          logs: [],
          total: 0,
          page,
          page_size: pageSize,
        }
      );
    },
  });

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / pageSize));

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 size={16} className="animate-spin text-text-muted" />
      </div>
    );
  }

  const logs = data?.logs ?? [];

  if (logs.length === 0) {
    return (
      <div className="text-center py-8 text-[12px] text-text-muted">
        暂无消费记录
      </div>
    );
  }

  return (
    <div>
      <div className="space-y-0">
        {logs.map((log) => {
          const costYuan = (log.cost_cents / 100).toFixed(6);
          const date = new Date(log.created_at);
          const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
          const totalTokens = log.prompt_tokens + log.completion_tokens;
          return (
            <div
              key={log.id}
              className="flex items-center justify-between gap-3 px-3 py-3 border-b border-border-subtle last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <div className="text-[12px] text-text-secondary">
                  {dateStr} · {log.prompt_tokens.toLocaleString()} 输入 +{" "}
                  {log.completion_tokens.toLocaleString()} 输出 ={" "}
                  {totalTokens.toLocaleString()} tokens
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-[13px] font-semibold text-text-primary tabular-nums">
                  -¥{costYuan}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}

function HistorySection() {
  const [tab, setTab] = useState<HistoryTab>("transactions");

  return (
    <div className="rounded-2xl border border-border bg-surface-0 p-6 mb-6">
      <div className="flex items-center gap-1 mb-4 rounded-lg bg-surface-1 p-1 w-fit">
        <button
          type="button"
          onClick={() => setTab("transactions")}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors",
            tab === "transactions"
              ? "bg-surface-0 text-text-primary shadow-sm"
              : "text-text-muted hover:text-text-secondary",
          )}
        >
          <History size={13} />
          充值记录
        </button>
        <button
          type="button"
          onClick={() => setTab("usage")}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors",
            tab === "usage"
              ? "bg-surface-0 text-text-primary shadow-sm"
              : "text-text-muted hover:text-text-secondary",
          )}
        >
          <Receipt size={13} />
          消费日志
        </button>
      </div>
      {tab === "transactions" ? <TransactionList /> : <UsageLogList />}
    </div>
  );
}

function ModelPricingSection() {
  const { data: modelsData, isLoading } = useQuery({
    queryKey: ["models"],
    queryFn: async () => {
      const { data } = await getApiV1Models();
      return data;
    },
    refetchInterval: 30_000,
  });
  const providers = useMemo(
    () => buildPricingProviders((modelsData?.models ?? []) as ApiModel[]),
    [modelsData],
  );

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-border bg-surface-0 p-6">
        <div className="mb-6">
          <h2 className="text-[16px] font-semibold text-text-primary mb-1">
            模型定价
          </h2>
        </div>
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={16} className="animate-spin text-text-muted" />
          </div>
        ) : (
          providers.map((p) => (
            <PricingProviderSection key={p.key} provider={p} />
          ))
        )}
      </div>

      <div className="rounded-2xl border border-border bg-surface-0 p-6">
        <h2 className="text-[16px] font-semibold text-text-primary mb-1">
          性价比对比
        </h2>
        <p className="text-[12px] text-text-muted mb-5">
          花 ¥1 能得到多少输出 tokens？条形越长 = 输出单价越低。
        </p>
        <ValueComparisonChart providers={providers} />
      </div>
    </div>
  );
}

// ── Preset amounts (cents) ──────────────────────────────────────

const PRESET_AMOUNTS = [
  { cents: 1000, label: "¥10" },
  { cents: 3000, label: "¥30" },
  { cents: 5000, label: "¥50" },
  { cents: 10000, label: "¥100" },
  { cents: 20000, label: "¥200" },
];

const POLL_INTERVAL_MS = 3_000;
const POLL_MAX_MS = 5 * 60 * 1_000;

type PaymentFlowState =
  | { phase: "idle" }
  | { phase: "creating" }
  | { phase: "polling"; outTradeNo: string; qrCode: string; startedAt: number }
  | { phase: "success"; addedCents: number }
  | { phase: "timeout"; outTradeNo: string }
  | { phase: "error"; message: string };

function AlipayPaymentSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [selectedCents, setSelectedCents] = useState<number | null>(null);
  const [customYuan, setCustomYuan] = useState("");
  const [isCustom, setIsCustom] = useState(false);
  const [flow, setFlow] = useState<PaymentFlowState>({ phase: "idle" });
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const effectiveAmountCents = isCustom
    ? Math.round(Number.parseFloat(customYuan || "0") * 100)
    : selectedCents;
  const canPay =
    effectiveAmountCents != null &&
    effectiveAmountCents >= 100 &&
    flow.phase !== "creating" &&
    flow.phase !== "polling";

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const startPolling = useCallback(
    (outTradeNo: string, qrCode: string) => {
      const startedAt = Date.now();
      setFlow({ phase: "polling", outTradeNo, qrCode, startedAt });

      pollTimerRef.current = setInterval(async () => {
        try {
          const { data } = await postApiInternalPaymentAlipayQueryOrder({
            body: { out_trade_no: outTradeNo },
          });
          if (data?.ok && data.status === "paid") {
            stopPolling();
            setFlow({
              phase: "success",
              addedCents: data.added_cents ?? 0,
            });
            queryClient.invalidateQueries({ queryKey: ["user-balance"] });
            queryClient.invalidateQueries({ queryKey: ["transactions"] });
            queryClient.invalidateQueries({
              queryKey: ["pending-alipay-orders"],
            });
          } else if (
            data?.ok &&
            (data.status === "closed" || data.status === "failed")
          ) {
            stopPolling();
            setFlow({ phase: "error", message: t("recharge.payFailed") });
          } else if (Date.now() - startedAt > POLL_MAX_MS) {
            stopPolling();
            setFlow({ phase: "timeout", outTradeNo });
            queryClient.invalidateQueries({
              queryKey: ["pending-alipay-orders"],
            });
          }
        } catch {
          if (Date.now() - startedAt > POLL_MAX_MS) {
            stopPolling();
            setFlow({ phase: "timeout", outTradeNo });
          }
        }
      }, POLL_INTERVAL_MS);
    },
    [stopPolling, queryClient, t],
  );

  const handlePay = async () => {
    if (!effectiveAmountCents || effectiveAmountCents < 100) return;
    setFlow({ phase: "creating" });

    try {
      const { data } = await postApiInternalPaymentAlipayCreateOrder({
        body: { amount_cents: effectiveAmountCents },
      });
      if (!data?.ok || !data.qr_code || !data.out_trade_no) {
        setFlow({
          phase: "error",
          message: data?.error ?? t("recharge.payFailed"),
        });
        return;
      }
      startPolling(data.out_trade_no, data.qr_code);
    } catch {
      setFlow({ phase: "error", message: t("recharge.payFailed") });
    }
  };

  const resetFlow = () => {
    stopPolling();
    setFlow({ phase: "idle" });
  };

  return (
    <div className="rounded-2xl border border-border bg-surface-0 p-6 mb-6">
      <div className="flex items-center gap-3 mb-5">
        <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-[#1677FF]/10">
          <Zap size={20} className="text-[#1677FF]" />
        </div>
        <div>
          <div className="text-[14px] font-semibold text-text-primary">
            {t("recharge.onlinePayTitle")}
          </div>
          <div className="text-[12px] text-text-muted">
            {t("recharge.onlinePayDesc")}
          </div>
        </div>
      </div>

      {/* Amount selection */}
      <div className="mb-4">
        <div className="text-[12px] font-medium text-text-secondary mb-2.5">
          {t("recharge.amountLabel")}
        </div>
        <div className="grid grid-cols-3 gap-2">
          {PRESET_AMOUNTS.map((preset) => (
            <button
              key={preset.cents}
              type="button"
              onClick={() => {
                setSelectedCents(preset.cents);
                setIsCustom(false);
                setCustomYuan("");
              }}
              className={cn(
                "rounded-lg border py-3 text-[14px] font-semibold tabular-nums transition-all",
                !isCustom && selectedCents === preset.cents
                  ? "border-[#1677FF] bg-[#1677FF]/5 text-[#1677FF] ring-1 ring-[#1677FF]/20"
                  : "border-border bg-surface-1 text-text-primary hover:border-border-hover",
              )}
            >
              {preset.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setIsCustom(true);
              setSelectedCents(null);
            }}
            className={cn(
              "rounded-lg border py-3 text-[14px] font-semibold transition-all",
              isCustom
                ? "border-[#1677FF] bg-[#1677FF]/5 text-[#1677FF] ring-1 ring-[#1677FF]/20"
                : "border-border bg-surface-1 text-text-primary hover:border-border-hover",
            )}
          >
            {t("recharge.customAmount")}
          </button>
        </div>
        {isCustom && (
          <input
            type="number"
            min="1"
            step="1"
            value={customYuan}
            onChange={(e) => setCustomYuan(e.target.value)}
            placeholder={t("recharge.customAmountPlaceholder")}
            className="mt-2 w-full rounded-lg border border-border bg-surface-1 px-3 py-2.5 text-[13px] text-text-primary placeholder:text-text-muted/50 focus:outline-none focus:ring-2 focus:ring-[#1677FF]/30 focus:border-[#1677FF] transition-all tabular-nums"
          />
        )}
      </div>

      {/* Pay button */}
      <button
        type="button"
        onClick={handlePay}
        disabled={!canPay}
        className="w-full rounded-lg py-3 text-[14px] font-semibold text-white bg-[#1677FF] hover:bg-[#4096FF] disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
      >
        {flow.phase === "creating" && (
          <Loader2 size={16} className="animate-spin" />
        )}
        {flow.phase === "creating"
          ? t("recharge.paying")
          : t("recharge.payButton")}
        {effectiveAmountCents &&
          effectiveAmountCents >= 100 &&
          flow.phase === "idle" && (
            <span className="opacity-70">
              ¥{(effectiveAmountCents / 100).toFixed(2)}
            </span>
          )}
      </button>

      {/* QR code + polling status */}
      {flow.phase === "polling" && (
        <div className="mt-5 flex flex-col items-center">
          <div className="rounded-2xl border border-border bg-white p-5 shadow-sm">
            <QRCodeSVG value={flow.qrCode} size={200} level="M" />
          </div>
          <div className="mt-3 flex items-center gap-2 text-[#1677FF]">
            <Loader2 size={14} className="animate-spin" />
            <span className="text-[13px] font-medium">
              {t("recharge.payPending")}
            </span>
          </div>
          <div className="text-[11px] text-text-muted mt-1">
            {t("recharge.payPolling")}
          </div>
        </div>
      )}

      {flow.phase === "success" && (
        <div className="mt-4 rounded-lg bg-[var(--color-success)]/10 border border-[var(--color-success)]/20 px-4 py-3">
          <div className="text-[13px] font-medium text-[var(--color-success)]">
            {t("recharge.paySuccess", {
              amount: (flow.addedCents / 100).toFixed(2),
            })}
          </div>
          <button
            type="button"
            onClick={resetFlow}
            className="text-[11px] text-text-muted hover:text-text-secondary mt-1 underline"
          >
            {t("common.confirm")}
          </button>
        </div>
      )}

      {flow.phase === "timeout" && (
        <div className="mt-4 rounded-lg bg-amber-500/10 border border-amber-500/20 px-4 py-3">
          <div className="text-[13px] font-medium text-amber-600 dark:text-amber-400">
            {t("recharge.payTimeout")}
          </div>
          <button
            type="button"
            onClick={resetFlow}
            className="text-[11px] text-text-muted hover:text-text-secondary mt-1 underline"
          >
            {t("common.confirm")}
          </button>
        </div>
      )}

      {flow.phase === "error" && (
        <div className="mt-4 rounded-lg bg-red-500/10 border border-red-500/20 px-4 py-3">
          <div className="text-[13px] font-medium text-red-500">
            {flow.message}
          </div>
          <button
            type="button"
            onClick={resetFlow}
            className="text-[11px] text-text-muted hover:text-text-secondary mt-1 underline"
          >
            {t("common.confirm")}
          </button>
        </div>
      )}
    </div>
  );
}

function PendingOrdersSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [expandedOrder, setExpandedOrder] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["pending-alipay-orders"],
    queryFn: async () => {
      const { data } = await getApiInternalPaymentAlipayPendingOrders();
      return data;
    },
    refetchInterval: 15_000,
  });

  const cancelMutation = useMutation({
    mutationFn: async (outTradeNo: string) => {
      const { data } = await postApiInternalPaymentAlipayCancelOrder({
        body: { out_trade_no: outTradeNo },
      });
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pending-alipay-orders"] });
      setExpandedOrder(null);
    },
  });

  const orders = data?.orders ?? [];

  if (isLoading || orders.length === 0) return null;

  return (
    <div className="rounded-2xl border border-border bg-surface-0 p-6 mb-6">
      <div className="flex items-center gap-2 mb-4">
        <Clock size={16} className="text-text-muted" />
        <h3 className="text-[14px] font-semibold text-text-primary">
          {t("recharge.pendingOrders")}
        </h3>
      </div>
      <div className="space-y-0">
        {orders.map((order) => {
          const amountYuan = (order.amount_cents / 100).toFixed(2);
          const date = new Date(order.created_at);
          const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
          const isExpanded = expandedOrder === order.out_trade_no;
          return (
            <div
              key={order.out_trade_no}
              className="border-b border-border-subtle last:border-b-0"
            >
              <div className="flex items-center justify-between gap-3 px-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold text-text-primary tabular-nums">
                    ¥{amountYuan}
                  </div>
                  <div className="text-[10px] text-text-muted mt-0.5">
                    {dateStr}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() =>
                      setExpandedOrder(isExpanded ? null : order.out_trade_no)
                    }
                    className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[11px] font-medium text-[#1677FF] bg-[#1677FF]/10 hover:bg-[#1677FF]/15 transition-colors"
                  >
                    <QrCode size={12} />
                    {t("recharge.continuePay")}
                  </button>
                  <button
                    type="button"
                    onClick={() => cancelMutation.mutate(order.out_trade_no)}
                    disabled={cancelMutation.isPending}
                    className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[11px] font-medium text-text-muted hover:text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-40"
                  >
                    <X size={12} />
                    {t("recharge.cancelOrder")}
                  </button>
                </div>
              </div>
              {isExpanded && (
                <div className="flex justify-center pb-4">
                  <div className="rounded-xl border border-border bg-white p-4 shadow-sm">
                    <QRCodeSVG value={order.qr_code} size={160} level="M" />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function RechargePage() {
  const { t } = useTranslation();
  // Redemption code input — disabled now that Alipay orders are live
  // const [code, setCode] = useState("");
  // const [successMsg, setSuccessMsg] = useState<string | null>(null);
  // const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const {
    data: balanceData,
    isLoading: balanceLoading,
    isError: balanceError,
    isFetching: balanceFetching,
    refetch: refetchBalance,
  } = useQuery({
    queryKey: ["user-balance"],
    queryFn: async () => {
      const { data, error } = await getApiInternalActivationBalance();
      if (error || !data) {
        throw new Error("Failed to fetch balance");
      }
      // Don't throw when data.ok is false - return the response so we can show specific error
      return data;
    },
    refetchInterval: 15_000,
    retry: 2,
  });

  // const redeemMutation = useMutation({
  //   mutationFn: async (rechargeCode: string) => {
  //     const { data } = await postApiInternalActivationRecharge({
  //       body: { code: rechargeCode },
  //     });
  //     return data;
  //   },
  //   onSuccess: (data) => {
  //     if (data?.ok && data.added_cents != null) {
  //       const amount = (data.added_cents / 100).toFixed(2);
  //       setSuccessMsg(t("recharge.redeemSuccess", { amount }));
  //       setErrorMsg(null);
  //       setCode("");
  //       queryClient.invalidateQueries({ queryKey: ["user-balance"] });
  //     } else {
  //       setErrorMsg(data?.error ?? t("recharge.redeemFailed"));
  //       setSuccessMsg(null);
  //     }
  //   },
  //   onError: () => {
  //     setErrorMsg(t("recharge.redeemFailed"));
  //     setSuccessMsg(null);
  //   },
  // });

  // const handleRedeem = () => {
  //   if (!code.trim()) return;
  //   setSuccessMsg(null);
  //   setErrorMsg(null);
  //   redeemMutation.mutate(code.trim());
  // };

  const hasBalanceError = balanceData && !balanceData.ok;
  const balanceErrorMessage = hasBalanceError ? balanceData.error : undefined;
  const balanceCents = balanceData?.balance_cents ?? 0;
  const totalRecharged = balanceData?.total_recharged;
  const balanceYuan = (balanceCents / 100).toFixed(2);
  const totalYuan =
    totalRecharged == null ? null : (totalRecharged / 100).toFixed(2);

  return (
    <div
      className="max-w-2xl mx-auto px-6 pb-12"
      style={{ paddingTop: "2rem" }}
    >
      <div className="mb-8">
        <h1 className="heading-page">{t("recharge.pageTitle")}</h1>
        <p className="heading-page-desc">{t("recharge.pageSubtitle")}</p>
      </div>

      {/* Balance card */}
      <div className="rounded-2xl border border-border bg-surface-0 p-6 mb-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-accent/10">
            <Wallet size={20} className="text-accent" />
          </div>
          <div>
            <div className="text-[12px] text-text-muted font-medium">
              {t("recharge.balance")}
            </div>
            {balanceLoading ? (
              <div className="text-[13px] text-text-muted">
                {t("recharge.loadingBalance")}
              </div>
            ) : balanceError || hasBalanceError ? (
              <div className="flex flex-col gap-2">
                <div className="text-[13px] text-red-500">
                  {t("recharge.balanceUnavailable")}
                </div>
                {balanceErrorMessage && (
                  <div className="text-[11px] text-text-muted">
                    {balanceErrorMessage === "Not authenticated"
                      ? "请先登录账户"
                      : balanceErrorMessage === "Server unreachable"
                        ? "无法连接到服务器，请检查网络连接"
                        : balanceErrorMessage.includes("invalid tokens") ||
                            balanceErrorMessage.includes("wait")
                          ? t("recharge.providerUnavailable")
                          : balanceErrorMessage}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => void refetchBalance()}
                  disabled={balanceFetching}
                  className="mt-1 flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium text-white bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-all w-fit"
                >
                  <RefreshCw
                    size={12}
                    className={balanceFetching ? "animate-spin" : undefined}
                  />
                  {t("recharge.retryBalance")}
                </button>
              </div>
            ) : (
              <div className="text-2xl font-bold text-text-primary tabular-nums">
                {t("recharge.balanceCurrency", { amount: balanceYuan })}
              </div>
            )}
          </div>
        </div>
        {!balanceLoading &&
          !balanceError &&
          !hasBalanceError &&
          totalYuan != null && (
            <div className="text-[12px] text-text-muted">
              {t("recharge.totalRecharged")}:{" "}
              {t("recharge.balanceCurrency", { amount: totalYuan })}
            </div>
          )}
      </div>

      {/* Online payment */}
      <AlipayPaymentSection />

      {/* Pending orders */}
      <PendingOrdersSection />

      {/* Recharge code input — disabled now that Alipay orders are live */}
      {/* <div className="rounded-2xl border border-border bg-surface-0 p-6 mb-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-[var(--color-brand-primary)]/10">
            <CreditCard
              size={20}
              className="text-[var(--color-brand-primary)]"
            />
          </div>
          <div>
            <div className="text-[14px] font-semibold text-text-primary">
              {t("recharge.redeemButton")}
            </div>
            <div className="text-[12px] text-text-muted">
              {t("recharge.codeHint")}
            </div>
          </div>
        </div>

        <div className="flex gap-3">
          <input
            type="text"
            value={code}
            onChange={(e) => {
              setCode(e.target.value.toUpperCase());
              setSuccessMsg(null);
              setErrorMsg(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRedeem();
            }}
            placeholder={t("recharge.codePlaceholder")}
            className="flex-1 rounded-lg border border-border bg-surface-1 px-3 py-2.5 text-[13px] text-text-primary placeholder:text-text-muted/50 focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all font-mono tracking-wider"
            disabled={redeemMutation.isPending}
          />
          <button
            type="button"
            onClick={handleRedeem}
            disabled={!code.trim() || redeemMutation.isPending}
            className="rounded-lg px-5 py-2.5 text-[13px] font-medium text-white bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center gap-2 shrink-0"
          >
            {redeemMutation.isPending && (
              <Loader2 size={14} className="animate-spin" />
            )}
            {redeemMutation.isPending
              ? t("recharge.redeeming")
              : t("recharge.redeemButton")}
          </button>
        </div>

        {successMsg && (
          <div className="mt-3 rounded-lg bg-[var(--color-success)]/10 border border-[var(--color-success)]/20 px-3 py-2 text-[12px] text-[var(--color-success)] font-medium">
            {successMsg}
          </div>
        )}
        {errorMsg && (
          <div className="mt-3 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-[12px] text-red-500 font-medium">
            {errorMsg}
          </div>
        )}
      </div> */}

      {/* Transaction history & usage logs */}
      <HistorySection />

      {/* Model pricing */}
      <ModelPricingSection />
    </div>
  );
}
