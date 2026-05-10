import { ModelLogo, ProviderLogo } from "@/components/provider-logo";
import { track } from "@/lib/tracking";
import { cn } from "@/lib/utils";
import { AlertTriangle, Check, ChevronDown, Cpu, Search } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export interface ModelPickerItem {
  id: string;
  name: string;
  provider: string;
}

const PROVIDER_LABELS: Record<string, string> = {
  nexu: "Claw-Pi 官方",
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google AI",
  siliconflow: "SiliconFlow",
  ppio: "PPIO",
  openrouter: "OpenRouter",
  minimax: "MiniMax",
  kimi: "Kimi",
  glm: "GLM",
  moonshot: "Kimi",
  zai: "GLM",
};

function isLinkModel(modelId: string): boolean {
  return modelId.startsWith("link/") || modelId.startsWith("link-openai/");
}

function getGroupKey(model: ModelPickerItem): string {
  if (isLinkModel(model.id)) {
    return "nexu";
  }

  return model.provider;
}

function getModelLabel(modelId: string): string {
  return modelId.includes("/")
    ? modelId.split("/").slice(1).join("/")
    : modelId;
}

type ModelPickerDropdownProps = {
  models: ModelPickerItem[];
  currentModelId: string;
  emptyLabel: string;
  onSelectModel: (modelId: string) => void;
  onOpenSettings?: () => void;
  className?: string;
  triggerClassName?: string;
  dropdownClassName?: string;
  compact?: boolean;
  dropdownAlign?: "start" | "end" | "stretch";
  confirmSwitch?: boolean;
};

export function ModelPickerDropdown({
  models,
  currentModelId,
  emptyLabel,
  onSelectModel,
  onOpenSettings,
  className,
  triggerClassName,
  dropdownClassName,
  compact = false,
  dropdownAlign = compact ? "start" : "stretch",
  confirmSwitch = false,
}: ModelPickerDropdownProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const currentItemRef = useRef<HTMLButtonElement | null>(null);
  const [pendingModelId, setPendingModelId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        closePicker();
      }
    };

    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const currentModel = models.find(
    (model) =>
      model.id === currentModelId ||
      (isLinkModel(currentModelId) &&
        model.id === currentModelId.split("/").slice(1).join("/")),
  );
  const currentGroupKey = currentModel
    ? getGroupKey(currentModel)
    : isLinkModel(currentModelId)
      ? "nexu"
      : (currentModelId.split("/")[0] ?? "");
  const currentModelLabel = currentModelId
    ? (currentModel?.name ?? getModelLabel(currentModelId))
    : emptyLabel;

  const modelsByProvider = useMemo(() => {
    const grouped = new Map<string, ModelPickerItem[]>();
    for (const model of models) {
      const groupKey = getGroupKey(model);
      const list = grouped.get(groupKey) ?? [];
      list.push(model);
      grouped.set(groupKey, list);
    }

    const entries = Array.from(grouped.entries());
    entries.sort((a, b) => {
      if (a[0] === "nexu") return -1;
      if (b[0] === "nexu") return 1;
      return a[0].localeCompare(b[0]);
    });

    return entries.map(([providerId, providerModels]) => ({
      id: providerId,
      name: PROVIDER_LABELS[providerId] ?? providerId,
      models: providerModels,
    }));
  }, [models]);

  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(
    () => new Set(currentGroupKey ? [currentGroupKey] : []),
  );

  const resolveOpenGroups = (): Set<string> =>
    new Set(
      currentGroupKey
        ? [currentGroupKey]
        : modelsByProvider.length > 0 && modelsByProvider[0]
          ? [modelsByProvider[0].id]
          : [],
    );

  const closePicker = () => {
    setOpen(false);
    setSearch("");
  };

  useLayoutEffect(() => {
    if (!open) {
      return;
    }

    currentItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [open]);

  const query = search.toLowerCase().trim();
  const filteredProviders = modelsByProvider
    .map((provider) => ({
      ...provider,
      models: provider.models.filter(
        (model) =>
          !query ||
          model.name.toLowerCase().includes(query) ||
          provider.name.toLowerCase().includes(query),
      ),
    }))
    .filter((provider) => provider.models.length > 0);

  if (models.length === 0) {
    return compact ? (
      <button
        type="button"
        onClick={onOpenSettings}
        className={cn(
          "flex items-center gap-1 text-[11px] text-text-muted hover:text-text-secondary transition-colors",
          className,
        )}
      >
        <Cpu size={10} />
        <span>{emptyLabel}</span>
        <ChevronDown size={9} />
      </button>
    ) : (
      <div
        className={cn(
          "rounded-xl border border-border bg-surface-0 px-4 py-4 mb-5",
          className,
        )}
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-surface-2 shrink-0">
            <Cpu size={16} className="text-text-muted" />
          </div>
          <div>
            <div className="text-[13px] font-medium text-text-primary">
              {emptyLabel}
            </div>
            <div className="text-[11px] text-text-muted">
              {t("models.configureProviderHint")}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const dropdownPositionClass =
    dropdownAlign === "end"
      ? "right-0"
      : dropdownAlign === "stretch"
        ? "left-0 right-0"
        : "left-0";

  return (
    <div className={cn("relative", className)} ref={ref}>
      <button
        type="button"
        onClick={() => {
          if (open) {
            closePicker();
            return;
          }

          track("workspace_change_model_click");
          setExpandedProviders(resolveOpenGroups());
          setOpen(true);
        }}
        className={cn(
          compact
            ? "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-border bg-surface-0 hover:border-border-hover hover:bg-surface-1 transition-all text-[12px] text-text-primary"
            : "inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border bg-surface-0 hover:bg-surface-2 hover:border-border-hover transition-all text-[12px] font-medium text-text-primary",
          triggerClassName,
        )}
      >
        <span
          className={cn(
            compact ? "w-4 h-4" : "w-4 h-4",
            "shrink-0 flex items-center justify-center",
          )}
        >
          {currentGroupKey ? (
            <ModelLogo
              model={currentModelLabel}
              provider={currentGroupKey}
              size={14}
            />
          ) : (
            <Cpu size={13} className="text-text-muted" />
          )}
        </span>
        <span className={cn(compact ? "font-medium" : undefined)}>
          {currentModelLabel}
        </span>
        <ChevronDown
          size={compact ? 10 : 13}
          className={cn(
            "text-text-muted transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div
          className={cn(
            compact
              ? `absolute z-50 mt-2 ${dropdownPositionClass} min-w-[340px] rounded-xl border border-border bg-surface-1 shadow-xl`
              : `absolute top-full ${dropdownPositionClass} z-20 mt-1 rounded-xl border border-border bg-surface-0 shadow-lg overflow-hidden`,
            dropdownClassName,
          )}
        >
          <div className="px-3 pt-3 pb-2">
            <div className="flex items-center gap-2 rounded-lg bg-surface-0 border border-border px-3 py-2">
              <Search
                size={compact ? 12 : 14}
                className="text-text-muted shrink-0"
              />
              <input
                type="text"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  if (event.target.value.trim()) {
                    setExpandedProviders(
                      new Set(modelsByProvider.map((provider) => provider.id)),
                    );
                  }
                }}
                placeholder={t("models.searchModels")}
                className={cn(
                  "flex-1 bg-transparent text-text-primary placeholder:text-text-muted/50 outline-none",
                  compact ? "text-[12px]" : "text-[13px]",
                )}
                // biome-ignore lint/a11y/noAutofocus: Intentional for dropdown search UX
                autoFocus
              />
            </div>
          </div>

          <div className={compact ? "relative" : undefined}>
            {compact && (
              <div className="pointer-events-none absolute inset-x-0 top-0 h-3 z-10 bg-gradient-to-b from-surface-1 to-transparent" />
            )}
            <div
              className={cn(
                compact
                  ? "max-h-[280px] overflow-y-auto py-1"
                  : "max-h-[320px] overflow-y-auto",
              )}
              style={
                compact
                  ? {
                      overscrollBehavior: "contain",
                      WebkitOverflowScrolling: "touch",
                    }
                  : undefined
              }
            >
              {filteredProviders.length === 0 ? (
                <div
                  className={cn(
                    compact ? "px-4 py-6" : "px-4 py-8",
                    "text-center text-[12px] text-text-muted",
                  )}
                >
                  {t("models.byok.none")}
                </div>
              ) : (
                filteredProviders.map((provider) => {
                  const isExpanded =
                    expandedProviders.has(provider.id) || !!query;
                  return (
                    <div key={provider.id}>
                      <button
                        type="button"
                        onClick={() => {
                          if (query) return;
                          setExpandedProviders((previous) => {
                            const next = new Set(previous);
                            if (next.has(provider.id)) next.delete(provider.id);
                            else next.add(provider.id);
                            return next;
                          });
                        }}
                        className={cn(
                          compact
                            ? "w-full px-3 py-1.5 flex items-center gap-2 hover:bg-surface-2/50 transition-colors"
                            : "w-full px-3 pt-2.5 pb-1 text-left hover:bg-surface-1/50 transition-colors flex items-center gap-2",
                        )}
                      >
                        <ChevronDown
                          size={10}
                          className={cn(
                            "text-text-muted/50 transition-transform",
                            !isExpanded && "-rotate-90",
                          )}
                        />
                        <span className="w-[14px] h-[14px] shrink-0 flex items-center justify-center">
                          <ProviderLogo provider={provider.id} size={13} />
                        </span>
                        <span
                          className={cn(
                            compact
                              ? "text-[11px]"
                              : "text-[10px] uppercase tracking-wider",
                            "font-medium text-text-secondary",
                          )}
                        >
                          {provider.name}
                        </span>
                        <span className="text-[10px] text-text-muted/40 ml-auto tabular-nums">
                          {provider.models.length}
                        </span>
                      </button>
                      {isExpanded &&
                        provider.models.map((model) => {
                          const isSelected =
                            model.id === currentModelId ||
                            (currentModel != null &&
                              model.id === currentModel.id);
                          return (
                            <button
                              key={model.id}
                              ref={isSelected ? currentItemRef : null}
                              type="button"
                              onClick={() => {
                                if (isSelected) {
                                  closePicker();
                                  return;
                                }
                                if (confirmSwitch) {
                                  setPendingModelId(model.id);
                                  closePicker();
                                  return;
                                }
                                onSelectModel(model.id);
                                closePicker();
                              }}
                              className={cn(
                                compact
                                  ? "w-full flex items-center gap-2 pl-8 pr-3 py-1.5 text-left transition-colors hover:bg-surface-2"
                                  : "w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors",
                                isSelected
                                  ? "bg-brand-primary/5"
                                  : compact
                                    ? undefined
                                    : "hover:bg-surface-2",
                              )}
                            >
                              {compact ? (
                                isSelected ? (
                                  <Check
                                    size={12}
                                    className="text-brand-primary shrink-0"
                                  />
                                ) : (
                                  <span className="w-[12px] shrink-0" />
                                )
                              ) : (
                                <span className="w-5 h-5 shrink-0 flex items-center justify-center">
                                  {isSelected ? (
                                    <Check
                                      size={14}
                                      className="text-brand-primary shrink-0"
                                    />
                                  ) : null}
                                </span>
                              )}
                              <span className="w-[14px] h-[14px] shrink-0 flex items-center justify-center">
                                <ModelLogo
                                  model={model.name}
                                  provider={provider.id}
                                  size={13}
                                />
                              </span>
                              <div className="flex-1 min-w-0">
                                <div
                                  className={cn(
                                    compact
                                      ? "text-[12px]"
                                      : "text-[12px] truncate",
                                    isSelected
                                      ? "font-semibold text-text-primary"
                                      : "font-medium text-text-primary",
                                  )}
                                >
                                  {model.name}
                                </div>
                                {!compact && (
                                  <div className="text-[10px] text-text-tertiary">
                                    {provider.name}
                                  </div>
                                )}
                              </div>
                            </button>
                          );
                        })}
                    </div>
                  );
                })
              )}
            </div>
            {compact && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-3 z-10 bg-gradient-to-t from-surface-1 to-transparent" />
            )}
          </div>
        </div>
      )}

      {pendingModelId && (
        <ModelSwitchConfirmDialog
          modelName={
            models.find((m) => m.id === pendingModelId)?.name ??
            getModelLabel(pendingModelId)
          }
          onConfirm={() => {
            onSelectModel(pendingModelId);
            setPendingModelId(null);
          }}
          onCancel={() => setPendingModelId(null)}
        />
      )}
    </div>
  );
}

function ModelSwitchConfirmDialog({
  modelName,
  onConfirm,
  onCancel,
}: {
  modelName: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss is supplementary to Escape key */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onCancel}
      />
      <div className="relative w-full max-w-[400px] rounded-2xl border border-border bg-surface-1 shadow-xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        <div className="px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/10 shrink-0">
              <AlertTriangle size={14} className="text-amber-500" />
            </div>
            <div>
              <h3 className="text-[14px] font-semibold text-text-primary">
                {t("models.confirmSwitch.title")}
              </h3>
              <p className="text-[11px] text-text-muted mt-0.5">
                {t("models.confirmSwitch.subtitle", { model: modelName })}
              </p>
            </div>
          </div>
        </div>

        <div className="px-5 py-4">
          <p className="text-[12px] text-text-secondary leading-relaxed">
            {t("models.confirmSwitch.body")}
          </p>
        </div>

        <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3.5 py-1.5 rounded-lg text-[12px] font-medium text-text-secondary hover:bg-surface-2 transition-colors"
          >
            {t("models.confirmSwitch.cancel")}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-3.5 py-1.5 rounded-lg text-[12px] font-medium text-white bg-brand-primary hover:bg-brand-primary/90 transition-colors"
          >
            {t("models.confirmSwitch.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
