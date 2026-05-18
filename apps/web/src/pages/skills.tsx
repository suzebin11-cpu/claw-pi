import ImportSkillModal from "@/components/skills/import-skill-modal";
import {
  useCommunitySkills,
  useExploreSearch,
  useInstallSkill,
  useRefreshCatalog,
  useUninstallSkill,
} from "@/hooks/use-community-catalog";
import { useLocale } from "@/hooks/use-locale";
import { useSkillTranslationMap } from "@/hooks/use-skill-translations";
import {
  SKILL_CATEGORY_ORDER,
  type SkillCategoryId,
  compareSkillsForMarketplace,
  getSkillCategoryId,
  skillMatchesCategory,
} from "@/lib/skill-categories";
import {
  composeSkillSearchText,
  getSkillTranslation,
  getTagLabel,
  localizeSkillText,
} from "@/lib/skill-translations";
import {
  type SkillSelection,
  type TopTab,
  type YoursSubTab,
  applySkillsViewStatePatch,
  createSkillDetailPath,
  createSkillDetailState,
  getUnavailableSkillDetailSlugs,
  parseSkillsViewState,
} from "@/lib/skills-view-state";
import { mapInstalledSkillSource, track } from "@/lib/tracking";
import { cn } from "@/lib/utils";
import type {
  InstalledSkill,
  MinimalSkill,
  SkillSource,
} from "@/types/desktop";
import {
  BarChart3,
  Bot,
  BriefcaseBusiness,
  CheckCircle2,
  Code2,
  Compass,
  Download,
  FileText,
  Globe,
  Loader2,
  Palette,
  Plus,
  Search,
  ServerCog,
  Settings2,
  ShieldCheck,
  Star,
  Wrench,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { toast } from "sonner";

const PAGE_SIZE = 60;
const MARKETPLACE_TOTAL_FALLBACK = 12_387;
const MARKETPLACE_CATEGORY_TABS: readonly SkillCategoryId[] = [
  "document_processing",
  "data_analysis",
  "industry_skills",
  "it_operations",
  "code_development",
  "web_research",
] as const;
const MARKETPLACE_CATEGORY_DISPLAY_RATIO: Record<SkillCategoryId, number> = {
  document_processing: 0.16,
  data_analysis: 0.13,
  industry_skills: 0.12,
  it_operations: 0.1,
  code_development: 0.14,
  web_research: 0.08,
  product_design: 0.07,
  automation_workflow: 0.07,
  security_testing: 0.05,
  finance_web3: 0.05,
  ai_agents: 0.02,
  others: 0.01,
};
type UninstallableSkillSource = Exclude<SkillSource, "curated">;

function toUninstallSource(
  source: SkillSource | null | undefined,
): UninstallableSkillSource | undefined {
  return source && source !== "curated" ? source : undefined;
}

function getSkillType(tags: readonly string[]): string | null {
  const primaryTag = tags[0]?.trim();
  if (!primaryTag) {
    return null;
  }
  return primaryTag.toLowerCase();
}

function useDebounce<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

function formatSkillCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

function formatCategoryCount(count: number): string {
  return Math.round(count).toLocaleString("zh-CN");
}

function getMarketplaceCategoryDisplayCount(
  categoryId: SkillCategoryId | "all",
  total: number,
): number {
  if (categoryId === "all") return total;
  return Math.max(
    1,
    Math.round(total * MARKETPLACE_CATEGORY_DISPLAY_RATIO[categoryId]),
  );
}

const SKILL_TAG_STYLES: Record<
  string,
  { icon: typeof Zap; bg: string; fg: string }
> = {
  automation: { icon: Zap, bg: "bg-amber-50", fg: "text-amber-600" },
  ai: { icon: Bot, bg: "bg-violet-50", fg: "text-violet-600" },
  agent: { icon: Bot, bg: "bg-violet-50", fg: "text-violet-600" },
  agents: { icon: Bot, bg: "bg-violet-50", fg: "text-violet-600" },
  "ai-agents": { icon: Bot, bg: "bg-violet-50", fg: "text-violet-600" },
  productivity: { icon: Zap, bg: "bg-emerald-50", fg: "text-emerald-600" },
  search: { icon: Search, bg: "bg-blue-50", fg: "text-blue-600" },
  web: { icon: Globe, bg: "bg-sky-50", fg: "text-sky-600" },
  tools: { icon: Wrench, bg: "bg-slate-100", fg: "text-slate-600" },
  content: { icon: FileText, bg: "bg-rose-50", fg: "text-rose-600" },
  writing: { icon: FileText, bg: "bg-rose-50", fg: "text-rose-600" },
  code: { icon: Settings2, bg: "bg-indigo-50", fg: "text-indigo-600" },
  development: { icon: Settings2, bg: "bg-indigo-50", fg: "text-indigo-600" },
  data: { icon: Settings2, bg: "bg-cyan-50", fg: "text-cyan-600" },
  analytics: { icon: Settings2, bg: "bg-cyan-50", fg: "text-cyan-600" },
  it_operations: {
    icon: ServerCog,
    bg: "bg-emerald-50",
    fg: "text-emerald-600",
  },
  document_processing: {
    icon: FileText,
    bg: "bg-sky-50",
    fg: "text-sky-600",
  },
  backend_development: {
    icon: Code2,
    bg: "bg-indigo-50",
    fg: "text-indigo-600",
  },
  frontend_development: {
    icon: Code2,
    bg: "bg-sky-50",
    fg: "text-sky-600",
  },
  data_analysis: { icon: BarChart3, bg: "bg-cyan-50", fg: "text-cyan-600" },
  product_design: {
    icon: Palette,
    bg: "bg-fuchsia-50",
    fg: "text-fuchsia-600",
  },
  industry_skills: {
    icon: BriefcaseBusiness,
    bg: "bg-amber-50",
    fg: "text-amber-600",
  },
  security_testing: {
    icon: ShieldCheck,
    bg: "bg-red-50",
    fg: "text-red-600",
  },
  code_development: { icon: Code2, bg: "bg-indigo-50", fg: "text-indigo-600" },
  web_research: { icon: Globe, bg: "bg-blue-50", fg: "text-blue-600" },
  automation_workflow: { icon: Zap, bg: "bg-lime-50", fg: "text-lime-600" },
  finance_web3: { icon: Wrench, bg: "bg-orange-50", fg: "text-orange-600" },
  ai_agents: { icon: Bot, bg: "bg-violet-50", fg: "text-violet-600" },
  others: { icon: Wrench, bg: "bg-surface-2", fg: "text-text-primary" },
};

function getSkillTagStyle(tags: string[]) {
  for (const tag of tags) {
    if (SKILL_TAG_STYLES[tag]) return SKILL_TAG_STYLES[tag];
  }
  return { icon: Zap, bg: "bg-surface-2", fg: "text-text-primary" };
}

function SkillCard({
  skill,
  isInstalled,
  queueStatus,
  categoryId,
  categoryLabel,
  skillSource,
  detailTo,
  isDetailAvailable,
  locale,
  installation,
}: {
  skill: MinimalSkill;
  isInstalled: boolean;
  queueStatus?:
    | "queued"
    | "downloading"
    | "installing-deps"
    | "done"
    | "failed"
    | null;
  categoryId: SkillCategoryId;
  categoryLabel?: string;
  skillSource: "builtin" | "explore" | "custom";
  detailTo: string;
  isDetailAvailable: boolean;
  locale: string;
  installation?: SkillSelection;
}) {
  const { t } = useTranslation();
  const installMutation = useInstallSkill();
  const uninstallMutation = useUninstallSkill();
  const [pendingAction, setPendingAction] = useState<
    "install" | "uninstall" | null
  >(null);

  const isQueueActive =
    queueStatus === "queued" ||
    queueStatus === "downloading" ||
    queueStatus === "installing-deps";
  const isMutating = pendingAction !== null;

  async function handleInstall() {
    setPendingAction("install");
    const skillType = getSkillType(skill.tags);
    try {
      await installMutation.mutateAsync(skill.slug);
      track("workspace_skill_install", {
        skill_name: skill.name,
        skill_type: skillType,
        skill_source: skillSource,
        success: true,
      });
      track("workspace_skill_enable", {
        name: skill.name,
        skill_source: skillSource,
      });
    } catch {
      track("workspace_skill_install", {
        skill_name: skill.name,
        skill_type: skillType,
        skill_source: skillSource,
        success: false,
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function handleUninstall() {
    setPendingAction("uninstall");
    try {
      await uninstallMutation.mutateAsync({
        slug: skill.slug,
        ...(toUninstallSource(installation?.source)
          ? { source: toUninstallSource(installation?.source) }
          : {}),
        ...(installation?.agentId ? { agentId: installation.agentId } : {}),
      });
      track("workspace_skill_uninstall", {
        skill_name: skill.name,
        skill_source: skillSource,
        success: true,
      });
      track("workspace_skill_disable", {
        name: skill.name,
        skill_source: skillSource,
      });
    } catch {
      track("workspace_skill_uninstall", {
        skill_name: skill.name,
        skill_source: skillSource,
        success: false,
      });
    } finally {
      setPendingAction(null);
    }
  }

  const tagStyle = getSkillTagStyle([categoryId, ...skill.tags]);
  const TagIcon = tagStyle.icon;
  const visibleTags = skill.tags.slice(0, 3);
  const hasStats = skill.downloads > 0 || skill.stars > 0;

  const cardContent = (
    <>
      <div className="flex items-start gap-3 mb-3">
        <div
          className={cn(
            "w-10 h-10 rounded-lg flex items-center justify-center shrink-0",
            tagStyle.bg,
          )}
        >
          <TagIcon size={18} className={tagStyle.fg} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-text-heading line-clamp-1">
            {skill.name}
          </div>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-text-muted">
            {categoryLabel && <span>{categoryLabel}</span>}
            {isInstalled && (
              <span className="inline-flex items-center gap-1 text-[var(--color-success)]">
                <CheckCircle2 size={11} />
                {t("skills.installedAction")}
              </span>
            )}
          </div>
        </div>
      </div>

      <p className="text-[12.5px] text-text-secondary leading-[1.6] line-clamp-3 min-h-[60px] mb-3">
        {skill.description}
      </p>

      <div className="flex items-center gap-1.5 min-h-6 mb-3 overflow-hidden">
        {visibleTags.length > 0 ? (
          visibleTags.map((tag) => (
            <span
              key={tag}
              className="shrink-0 rounded-md border border-border bg-surface-2 px-1.5 py-0.5 text-[10.5px] font-medium text-text-muted"
            >
              {getTagLabel(tag, locale)}
            </span>
          ))
        ) : (
          <span className="text-[11px] text-text-muted">
            {t("skills.noTags")}
          </span>
        )}
      </div>

      <div
        className="mt-auto flex items-center justify-between gap-3"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
      >
        <div className="flex items-center gap-3 min-w-0 text-[11px] text-text-muted">
          {hasStats ? (
            <>
              <span className="inline-flex items-center gap-1">
                <Download size={11} />
                {formatSkillCount(skill.downloads)}
              </span>
              {skill.stars > 0 && (
                <span className="inline-flex items-center gap-1">
                  <Star size={11} />
                  {formatSkillCount(skill.stars)}
                </span>
              )}
            </>
          ) : (
            <span className="truncate">{skill.slug}</span>
          )}
        </div>
        {isQueueActive || (isMutating && pendingAction === "install") ? (
          <span className="inline-flex items-center gap-1.5 rounded-[8px] px-[14px] py-[5px] text-[12px] font-medium border border-border text-text-muted cursor-default">
            <Loader2 size={12} className="animate-spin" />
            {t("skills.installingAction")}
          </span>
        ) : isInstalled ? (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              handleUninstall();
            }}
            disabled={isMutating}
            className="rounded-[8px] px-[12px] py-[5px] text-[12px] font-medium text-text-muted hover:bg-[var(--color-danger-subtle)] hover:text-[var(--color-danger)] transition-colors"
          >
            {pendingAction === "uninstall"
              ? t("skills.uninstallingAction")
              : t("skills.uninstallAction")}
          </button>
        ) : (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              handleInstall();
            }}
            disabled={isMutating}
            className="rounded-[8px] px-[14px] py-[5px] text-[12px] font-semibold bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] transition-colors"
          >
            {t("skills.installAction")}
          </button>
        )}
      </div>
    </>
  );

  if (!isDetailAvailable) {
    return (
      <div
        className={cn(
          "card flex flex-col p-4 cursor-default min-h-[214px]",
          isInstalled && !pendingAction ? "" : "",
        )}
      >
        {cardContent}
      </div>
    );
  }

  return (
    <Link
      to={detailTo}
      state={createSkillDetailState(installation)}
      draggable={false}
      className={cn(
        "card flex flex-col p-4 min-h-[214px]",
        isInstalled && !pendingAction ? "" : "",
      )}
    >
      {cardContent}
    </Link>
  );
}

export function SkillsPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const isDesktopClient = useMemo(
    () =>
      typeof navigator !== "undefined" &&
      navigator.userAgent.includes("Electron"),
    [],
  );
  const { locale } = useLocale();
  const { data, isLoading, isError } = useCommunitySkills();
  const skillTranslations = useSkillTranslationMap(locale);
  const refreshMutation = useRefreshCatalog();
  const [importModalOpen, setImportModalOpen] = useState(false);
  const viewState = useMemo(
    () => parseSkillsViewState(searchParams),
    [searchParams],
  );
  const { topTab, yoursSubTab, activeTag, searchQuery } = viewState;
  const [localSearch, setLocalSearch] = useState(searchQuery);
  const composingRef = useRef(false);

  // Sync URL → local when search params change externally
  useEffect(() => {
    setLocalSearch(searchQuery);
  }, [searchQuery]);

  const debouncedQuery = useDebounce(localSearch, 300);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const exploreQuery = useExploreSearch(
    topTab === "explore" ? debouncedQuery : "",
  );

  const updateViewState = useCallback(
    (
      patch: Partial<{
        topTab: TopTab;
        yoursSubTab: YoursSubTab;
        activeTag: string | null;
        searchQuery: string;
      }>,
    ) => {
      setSearchParams((current) => applySkillsViewStatePatch(current, patch), {
        replace: true,
      });
    },
    [setSearchParams],
  );

  const rawSkills = data?.skills ?? [];
  const rawSkillBySlug = useMemo(() => {
    return new Map(rawSkills.map((skill) => [skill.slug, skill]));
  }, [rawSkills]);
  const allSkills = useMemo(
    () =>
      rawSkills.map((skill) =>
        localizeSkillText(skill, skillTranslations, locale),
      ),
    [rawSkills, skillTranslations, locale],
  );
  const installedSlugs = useMemo(
    () => new Set(data?.installedSlugs ?? []),
    [data?.installedSlugs],
  );
  const installedSkills: InstalledSkill[] = useMemo(
    () =>
      (data?.installedSkills ?? []).map((skill) =>
        localizeSkillText(skill, skillTranslations, locale),
      ),
    [data?.installedSkills, skillTranslations, locale],
  );

  // Queue items actively downloading that aren't already installed
  const activeQueueItems = useMemo(() => {
    const activeStatuses = new Set([
      "queued",
      "downloading",
      "installing-deps",
    ]);
    return (data?.queue ?? []).filter(
      (qi) => activeStatuses.has(qi.status) && !installedSlugs.has(qi.slug),
    );
  }, [data?.queue, installedSlugs]);
  const queueBySlug = useMemo(() => {
    const map = new Map<
      string,
      "queued" | "downloading" | "installing-deps" | "done" | "failed"
    >();
    for (const item of data?.queue ?? []) {
      map.set(item.slug, item.status);
    }
    return map;
  }, [data?.queue]);
  const queueSourceBySlug = useMemo(() => {
    const map = new Map<string, SkillSource>();
    for (const item of data?.queue ?? []) {
      map.set(item.slug, item.source);
    }
    return map;
  }, [data?.queue]);
  const unavailableDetailSlugs = useMemo(
    () => getUnavailableSkillDetailSlugs(allSkills, activeQueueItems),
    [allSkills, activeQueueItems],
  );

  // Show toast for "skill not found" errors
  const shownErrorSlugs = useRef(new Set<string>());
  useEffect(() => {
    for (const item of data?.queue ?? []) {
      if (
        item.status === "failed" &&
        item.errorCode === "skill_not_found" &&
        !shownErrorSlugs.current.has(item.slug)
      ) {
        shownErrorSlugs.current.add(item.slug);
        toast.error(t("skills.skillNotFound", { slug: item.slug }));
      }
    }
  }, [data?.queue, t]);

  // Build skill lists based on tabs
  // Explore: server-side search results (may include already-installed skills)
  const isExploreSearchActive = debouncedQuery.trim().length > 0;
  const remoteExploreSkills = useMemo(
    () =>
      exploreQuery.skills.map((skill) =>
        localizeSkillText(skill, skillTranslations, locale),
      ),
    [exploreQuery.skills, skillTranslations, locale],
  );
  const defaultExploreSkills = useMemo(() => {
    const bySlug = new Map<string, MinimalSkill>();
    for (const skill of allSkills) {
      bySlug.set(skill.slug, skill);
    }
    for (const skill of remoteExploreSkills) {
      bySlug.set(skill.slug, skill);
    }
    return [...bySlug.values()].sort(compareSkillsForMarketplace);
  }, [allSkills, remoteExploreSkills]);
  const exploreSkills = isExploreSearchActive
    ? remoteExploreSkills
    : defaultExploreSkills;
  const yourSkillsList = useMemo(() => {
    const installed = installedSkills.map((is) => {
      const catalogEntry = allSkills.find((s) => s.slug === is.slug);
      return (
        catalogEntry ?? {
          slug: is.slug,
          name: is.name || is.slug,
          description: is.description || "",
          downloads: 0,
          stars: 0,
          tags: [],
          version: "",
          updatedAt: "",
        }
      );
    });

    // Map active queue items to MinimalSkill shape with source for filtering
    const downloadingWithSource = activeQueueItems.map((qi) => {
      const catalogEntry = allSkills.find((s) => s.slug === qi.slug);
      return {
        skill: catalogEntry ?? {
          slug: qi.slug,
          name: qi.slug,
          description: "",
          downloads: 0,
          stars: 0,
          tags: [],
          version: "",
          updatedAt: "",
        },
        source: qi.source,
      };
    });

    if (yoursSubTab === "builtin") {
      const builtinSlugs = new Set(
        installedSkills
          .filter((is) => is.source === "curated" || is.source === "managed")
          .map((is) => is.slug),
      );
      const filteredDownloading = downloadingWithSource
        .filter((d) => d.source === "curated" || d.source === "managed")
        .map((d) => d.skill);
      return [
        ...filteredDownloading,
        ...installed.filter((s) => builtinSlugs.has(s.slug)),
      ];
    }
    if (yoursSubTab === "custom") {
      const customSlugs = new Set(
        installedSkills
          .filter(
            (is) =>
              is.source === "custom" ||
              is.source === "workspace" ||
              is.source === "user",
          )
          .map((is) => is.slug),
      );
      const filteredDownloading = downloadingWithSource
        .filter(
          (d) =>
            d.source === "custom" ||
            d.source === "workspace" ||
            d.source === "user",
        )
        .map((d) => d.skill);
      return [
        ...filteredDownloading,
        ...installed.filter((s) => customSlugs.has(s.slug)),
      ];
    }
    return [...downloadingWithSource.map((d) => d.skill), ...installed];
  }, [installedSkills, allSkills, yoursSubTab, activeQueueItems]);

  // Yours tab: client-side filter by tag and search
  const filteredYoursSkills = useMemo(() => {
    let list = [...yourSkillsList];

    if (activeTag) {
      list = list.filter((s) => s.tags.includes(activeTag));
    }

    if (debouncedQuery.trim()) {
      const q = debouncedQuery.toLowerCase();
      list = list.filter((s) => {
        const raw = rawSkillBySlug.get(s.slug) ?? s;
        const translation = getSkillTranslation(
          s.slug,
          skillTranslations,
          locale,
        );
        return composeSkillSearchText(
          raw.slug,
          raw.name,
          raw.description,
          translation?.name,
          translation?.description,
        ).includes(q);
      });
    }

    return list;
  }, [
    yourSkillsList,
    activeTag,
    debouncedQuery,
    rawSkillBySlug,
    skillTranslations,
    locale,
  ]);

  const filteredExploreSkills = useMemo(() => {
    if (!activeTag) return exploreSkills;
    return exploreSkills.filter((s) => skillMatchesCategory(s, activeTag));
  }, [exploreSkills, activeTag]);

  const filteredSkills =
    topTab === "explore" ? filteredExploreSkills : filteredYoursSkills;

  // Reset visible count when yours-tab filters change
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps trigger reset on filter change
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [debouncedQuery, activeTag, topTab, yoursSubTab]);

  // Intersection Observer — for Explore, fetch next server page; for Yours, show more client items
  const loadMore = useCallback(() => {
    if (topTab === "explore") {
      if (visibleCount < filteredSkills.length) {
        setVisibleCount((prev) =>
          prev >= filteredSkills.length ? prev : prev + PAGE_SIZE,
        );
        return;
      }

      if (exploreQuery.hasNextPage && !exploreQuery.isFetchingNextPage) {
        void exploreQuery.fetchNextPage().then(() => {
          if (!isExploreSearchActive) {
            setVisibleCount((prev) => prev + PAGE_SIZE);
          }
        });
      }
    } else {
      setVisibleCount((prev) =>
        prev >= filteredSkills.length ? prev : prev + PAGE_SIZE,
      );
    }
  }, [
    topTab,
    visibleCount,
    filteredSkills.length,
    exploreQuery,
    isExploreSearchActive,
  ]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          loadMore();
        }
      },
      { rootMargin: "200px" },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore]);

  const visibleSkills =
    topTab === "explore" && isExploreSearchActive
      ? filteredSkills
      : filteredSkills.slice(0, visibleCount);

  const installationBySlug = useMemo(() => {
    const map = new Map<string, SkillSelection>();
    for (const skill of installedSkills) {
      const existing = map.get(skill.slug);
      if (!existing) {
        map.set(skill.slug, {
          source: toUninstallSource(skill.source),
          agentId: skill.agentId,
        });
        continue;
      }

      if (existing.source === "workspace" && skill.source !== "workspace") {
        map.set(skill.slug, {
          source: toUninstallSource(skill.source),
          agentId: skill.agentId,
        });
      }
    }

    return map;
  }, [installedSkills]);

  // Category tabs for pills
  const categoryTabs = useMemo(() => {
    const skills = topTab === "explore" ? exploreSkills : yourSkillsList;
    const marketplaceDisplayTotal = Math.max(
      data?.meta?.skillCount ?? 0,
      MARKETPLACE_TOTAL_FALLBACK,
    );
    const base =
      topTab === "explore"
        ? [
            {
              id: "all",
              label: t("skills.all"),
              count: exploreSkills.length,
              displayCount: isExploreSearchActive
                ? exploreSkills.length
                : getMarketplaceCategoryDisplayCount(
                    "all",
                    marketplaceDisplayTotal,
                  ),
              icon: Compass,
            },
          ]
        : [
            {
              id: "all",
              label: t("skills.all"),
              count: yourSkillsList.length,
              displayCount: yourSkillsList.length,
              icon: Compass,
            },
          ];

    const visibleCategoryIds =
      topTab === "explore" ? MARKETPLACE_CATEGORY_TABS : SKILL_CATEGORY_ORDER;

    const categoryFilters = visibleCategoryIds
      .map((id) => {
        const style = getSkillTagStyle([id]);
        const count = skills.filter((skill) =>
          skillMatchesCategory(skill, id),
        ).length;
        return {
          id,
          label: getTagLabel(id, locale),
          count,
          displayCount: count,
          icon: style.icon,
        };
      })
      .filter((tab) => tab.count > 0);

    return [...base, ...categoryFilters];
  }, [
    topTab,
    exploreSkills,
    yourSkillsList,
    locale,
    t,
    data?.meta?.skillCount,
    isExploreSearchActive,
  ]);

  // Yours sub-tab counts (include actively downloading items)
  const builtinCount =
    installedSkills.filter(
      (is) => is.source === "curated" || is.source === "managed",
    ).length +
    activeQueueItems.filter(
      (qi) => qi.source === "curated" || qi.source === "managed",
    ).length;
  const customCount =
    installedSkills.filter(
      (is) =>
        is.source === "custom" ||
        is.source === "workspace" ||
        is.source === "user",
    ).length +
    activeQueueItems.filter(
      (qi) =>
        qi.source === "custom" ||
        qi.source === "workspace" ||
        qi.source === "user",
    ).length;
  const totalYoursCount = installedSkills.length + activeQueueItems.length;

  if (isLoading) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 pt-6 pb-6 sm:pb-8">
          <div className="flex flex-col items-center justify-center py-16 gap-2">
            <Loader2 size={24} className="animate-spin text-text-muted" />
            <p className="text-[13px] text-text-muted">
              {t("skills.loadingCatalog")}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (isError && allSkills.length === 0) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 pt-6 pb-6 sm:pb-8">
          <div className="text-center py-16">
            <div className="flex justify-center items-center mx-auto mb-3 w-12 h-12 rounded-xl bg-red-500/10">
              <Zap size={20} className="text-red-500" />
            </div>
            <p className="text-[13px] text-text-muted mb-2">
              {t("skills.catalogUnavailable")}
            </p>
            <button
              type="button"
              onClick={() => refreshMutation.mutate()}
              disabled={refreshMutation.isPending}
              className="text-[12px] text-accent hover:underline"
            >
              {refreshMutation.isPending
                ? t("skills.retrying")
                : t("skills.tryAgain")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div
        className="max-w-5xl mx-auto px-4 sm:px-6 pb-6 sm:pb-8"
        style={{ paddingTop: isDesktopClient ? "2rem" : "0.5rem" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-10">
          <div>
            <h1 className="heading-page">{t("skills.pageTitle")}</h1>
            <p className="heading-page-desc">{t("skills.pageSubtitle")}</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
              />
              <input
                type="text"
                value={localSearch}
                onChange={(e) => {
                  setLocalSearch(e.target.value);
                  if (!composingRef.current) {
                    updateViewState({ searchQuery: e.target.value });
                  }
                }}
                onCompositionStart={() => {
                  composingRef.current = true;
                }}
                onCompositionEnd={(e) => {
                  composingRef.current = false;
                  const val = (e.target as HTMLInputElement).value;
                  setLocalSearch(val);
                  updateViewState({ searchQuery: val });
                }}
                placeholder={t("skills.searchPlaceholder")}
                className="w-48 pl-9 pr-3 py-1.5 rounded-lg border border-border bg-surface-1 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-[var(--color-brand-primary)]/30 focus:ring-1 focus:ring-[var(--color-brand-primary)]/20 transition-colors"
              />
            </div>
            <button
              type="button"
              onClick={() => setImportModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--color-accent)]/35 bg-[var(--color-accent-subtle)] text-[var(--color-accent)] text-[12px] font-medium hover:bg-[var(--color-accent-glow)] transition-colors"
            >
              <Plus size={12} />
              {t("skills.import")}
            </button>
            <ImportSkillModal
              open={importModalOpen}
              onClose={() => setImportModalOpen(false)}
            />
          </div>
        </div>

        {/* Top-level tabs: Explore / Yours — segment control */}
        <div className="inline-flex items-center gap-1 p-1 rounded-full bg-surface-2 mb-4">
          {(
            [
              {
                id: "explore" as const,
                label: t("skills.explore"),
                icon: Compass,
              },
              {
                id: "yours" as const,
                label: t("skills.yours"),
                icon: Settings2,
              },
            ] as const
          ).map((tab) => {
            const active = topTab === tab.id;
            const TabIcon = tab.icon;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  updateViewState({
                    topTab: tab.id,
                    yoursSubTab: "all",
                    activeTag: tab.id === "yours" ? null : activeTag,
                  });
                }}
                className={cn(
                  "flex items-center gap-1.5 px-4 py-1.5 rounded-full text-[13px] font-medium transition-all",
                  active
                    ? "bg-surface-1 text-text-primary shadow-[var(--shadow-rest)]"
                    : "text-text-secondary hover:text-text-primary",
                )}
              >
                <TabIcon size={14} />
                {tab.label}
                {tab.id === "yours" && totalYoursCount > 0 && active && (
                  <span
                    className={cn(
                      "tabular-nums text-[12px]",
                      active ? "text-text-secondary" : "text-text-tertiary",
                    )}
                  >
                    {totalYoursCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Yours sub-tabs: All / Built-in / Custom */}
        {topTab === "yours" && (
          <div className="flex items-center gap-2 mb-3">
            {(
              [
                {
                  id: "all" as const,
                  label: t("skills.all"),
                  count: totalYoursCount,
                },
                {
                  id: "builtin" as const,
                  label: t("skills.builtin"),
                  count: builtinCount,
                },
                {
                  id: "custom" as const,
                  label: t("skills.custom"),
                  count: customCount,
                },
              ] as const
            ).map((tab) => {
              const active = yoursSubTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    updateViewState({
                      yoursSubTab: tab.id,
                      activeTag: null,
                    });
                  }}
                  className={cn(
                    "shrink-0 inline-flex items-center justify-center rounded-full h-7 px-3 text-[11px] leading-none font-medium transition-all",
                    active
                      ? "bg-[var(--color-accent)] text-white"
                      : "border border-border bg-surface-1 text-text-secondary hover:text-text-primary hover:border-border-hover",
                  )}
                >
                  {tab.label}
                  <span
                    className={cn(
                      "ml-1 tabular-nums",
                      active ? "opacity-80" : "opacity-50",
                    )}
                  >
                    {tab.count}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* Category pill filters (Explore only) */}
        {topTab === "explore" && (
          <div className="relative mb-5">
            <div className="flex flex-wrap items-center gap-2 pb-0.5">
              {categoryTabs.map((tab) => {
                const active =
                  (activeTag === null && tab.id === "all") ||
                  activeTag === tab.id;
                const TabIcon = tab.icon;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() =>
                      updateViewState({
                        activeTag: tab.id === "all" ? null : tab.id,
                      })
                    }
                    className={cn(
                      "shrink-0 inline-flex items-center justify-center rounded-full h-7 px-3 text-[11px] leading-none font-medium transition-all",
                      active
                        ? "bg-[var(--color-accent)] text-white"
                        : "border border-border bg-surface-1 text-text-secondary hover:text-text-primary hover:border-border-hover",
                    )}
                  >
                    <TabIcon size={13} className="mr-1.5" />
                    {tab.label}
                    <span
                      className={cn(
                        "ml-1 tabular-nums",
                        active ? "opacity-80" : "opacity-50",
                      )}
                    >
                      {formatCategoryCount(tab.displayCount)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {
          <>
            {/* Skill Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {visibleSkills.map((skill) => {
                const categoryId = getSkillCategoryId(skill);
                return (
                  <SkillCard
                    key={skill.slug}
                    skill={skill}
                    isInstalled={installedSlugs.has(skill.slug)}
                    queueStatus={queueBySlug.get(skill.slug)}
                    categoryId={categoryId}
                    detailTo={createSkillDetailPath(
                      skill.slug,
                      location.search,
                      installationBySlug.get(skill.slug),
                    )}
                    locale={locale}
                    installation={installationBySlug.get(skill.slug)}
                    isDetailAvailable={!unavailableDetailSlugs.has(skill.slug)}
                    skillSource={
                      topTab === "explore"
                        ? "explore"
                        : mapInstalledSkillSource(
                            installedSkills.find(
                              (item) => item.slug === skill.slug,
                            )?.source ??
                              queueSourceBySlug.get(skill.slug) ??
                              "managed",
                          )
                    }
                    categoryLabel={
                      categoryId ? getTagLabel(categoryId, locale) : undefined
                    }
                  />
                );
              })}
            </div>

            {/* Sentinel for infinite scroll */}
            {(topTab === "explore"
              ? exploreQuery.hasNextPage || visibleCount < filteredSkills.length
              : visibleCount < filteredSkills.length) && (
              <div ref={sentinelRef} className="flex justify-center py-8">
                <Loader2 size={20} className="animate-spin text-text-muted" />
              </div>
            )}

            {/* Empty state */}
            {filteredSkills.length === 0 &&
              !(topTab === "explore" && exploreQuery.isLoading) && (
                <div className="text-center py-12">
                  <Search size={24} className="mx-auto text-text-muted mb-3" />
                  <div className="text-[13px] text-text-muted">
                    {topTab === "yours" && !debouncedQuery.trim()
                      ? t("skills.noInstalledSkills")
                      : t("skills.noMatchingSkills")}
                  </div>
                </div>
              )}
          </>
        }
      </div>
    </div>
  );
}
