import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { proxyFetch } from "../../lib/proxy-fetch.js";
import {
  CURATED_SKILL_SLUGS,
  type CuratedInstallResult,
  copyStaticSkills,
  resolveCuratedSkillsToInstall,
} from "./curated-skills.js";
import type { SkillDb, SkillRecord } from "./skill-db.js";
import type {
  CatalogMeta,
  InstalledSkill,
  MinimalSkill,
  SelectedSkillContext,
  SkillSource,
  SkillhubCatalogData,
} from "./types.js";
import { importSkillZip as extractZip } from "./zip-importer.js";

const execFileAsync = promisify(execFile);

const nodeRequire = createRequire(import.meta.url);

function resolveClawHubBin(): string {
  const bundledPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "clawhub.js",
  );
  if (existsSync(bundledPath)) {
    return bundledPath;
  }
  const pkgPath = nodeRequire.resolve("clawhub/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    bin?: Record<string, string>;
  };
  const binRel = pkg.bin?.clawhub ?? pkg.bin?.clawdhub ?? "bin/clawdhub.js";
  return resolve(dirname(pkgPath), binRel);
}

const DEFAULT_DOWNLOAD_COUNT = 1000;

/**
 * Corrects known broken slugs in the ClawHub catalog.
 * Key = broken slug in catalog data, Value = correct slug on ClawHub.
 */
const SLUG_CORRECTIONS: Record<string, string> = {
  "find-skills": "find-skill",
};

/**
 * Skills listed in the ClawHub catalog but no longer available for install.
 * Filtered out from the catalog response to avoid confusing users.
 */
const CATALOG_BLOCKLIST = new Set(["self-improving-agent"]);

function mapRegistryResults(results: unknown[]): MinimalSkill[] {
  const skills: MinimalSkill[] = [];
  for (const raw of results) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const meta =
      typeof entry.metaContent === "object" && entry.metaContent !== null
        ? (entry.metaContent as Record<string, unknown>)
        : {};

    const updatedAtRaw = entry.updatedAt ?? 0;
    const updatedAt =
      typeof updatedAtRaw === "number"
        ? new Date(updatedAtRaw).toISOString()
        : String(updatedAtRaw);

    const keywords = Array.isArray(meta.Keywords) ? meta.Keywords : [];

    skills.push({
      slug: String(entry.slug ?? ""),
      name: String(entry.displayName ?? entry.slug ?? ""),
      description: String(entry.summary ?? "").slice(0, 150),
      downloads: Number(entry.score ?? DEFAULT_DOWNLOAD_COUNT),
      stars: 0,
      tags: keywords.slice(0, 5).map(String),
      version: String(entry.version ?? "0.0.0"),
      updatedAt,
    });
  }
  return skills;
}

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,127}$/;

function isValidSlug(slug: string): boolean {
  return SLUG_REGEX.test(slug);
}

function resolveSkillPath(skillsDir: string, slug: string): string | null {
  const rootDir = resolve(skillsDir);
  const skillPath = resolve(rootDir, slug);
  const normalizedRoot = rootDir.endsWith(sep) ? rootDir : `${rootDir}${sep}`;

  if (skillPath === rootDir || !skillPath.startsWith(normalizedRoot)) {
    return null;
  }

  return skillPath;
}

export type SkillhubLogFn = (
  level: "info" | "error" | "warn",
  message: string,
) => void;

const noopLog: SkillhubLogFn = () => {};

const CATALOG_API_PAGE_LIMIT = 100;

const DAILY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DYNAMIC_SKILL_LIMIT = 3;
const DEFAULT_DYNAMIC_SKILL_MAX_TOTAL_CHARS = 9_000;
const DEFAULT_DYNAMIC_SKILL_MAX_CHARS = 4_000;
const DYNAMIC_SKILL_MIN_SCORE = 3;
const DYNAMIC_SKILL_INDEX_CACHE_MS = 30_000;

const SKILL_QUERY_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "for",
  "from",
  "how",
  "into",
  "please",
  "the",
  "this",
  "that",
  "with",
  "you",
  "your",
]);

const SKILL_QUERY_EXPANSIONS: Array<{
  pattern: RegExp;
  terms: readonly string[];
}> = [
  {
    pattern: /图片|图像|画图|绘图|生图|图生图|海报|插画|logo|照片|视觉|换色/u,
    terms: [
      "image",
      "images",
      "picture",
      "photo",
      "vision",
      "generate",
      "generation",
      "design",
      "logo",
      "drawing",
    ],
  },
  {
    pattern: /网页|网站|浏览器|联网|搜索|爬取|抓取|资料|新闻/u,
    terms: [
      "web",
      "browser",
      "search",
      "internet",
      "crawl",
      "scrape",
      "research",
    ],
  },
  {
    pattern: /文件|文档|pdf|word|excel|ppt|表格|幻灯片|压缩包/u,
    terms: [
      "file",
      "document",
      "pdf",
      "word",
      "excel",
      "spreadsheet",
      "presentation",
      "slides",
    ],
  },
  {
    pattern: /代码|程序|开发|报错|bug|测试|前端|后端|接口|脚本/u,
    terms: [
      "code",
      "coding",
      "debug",
      "test",
      "frontend",
      "backend",
      "api",
      "script",
    ],
  },
  {
    pattern: /数据|分析|图表|统计|csv|数据库|报表/u,
    terms: [
      "data",
      "analysis",
      "chart",
      "database",
      "csv",
      "report",
      "analytics",
    ],
  },
  {
    pattern: /部署|发布|运维|服务器|docker|k8s|日志|监控/u,
    terms: [
      "deploy",
      "deployment",
      "server",
      "docker",
      "kubernetes",
      "logs",
      "monitoring",
      "operations",
    ],
  },
];

type SkillSelectionCandidate = {
  record: SkillRecord;
  name: string;
  description: string;
  tags: readonly string[];
  skillMdPath: string;
};

type SkillSelectionIndexCache = {
  key: string;
  expiresAt: number;
  candidates: SkillSelectionCandidate[];
};

function normalizeSkillSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_/|]+/gu, " ")
    .replace(/[^\p{L}\p{N}\s.-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function tokenizeSkillQuery(query: string): string[] {
  const normalized = normalizeSkillSearchText(query);
  const terms = new Set<string>();
  const tokens = normalized.match(/[\p{L}\p{N}][\p{L}\p{N}.-]{1,}/gu) ?? [];
  for (const token of tokens) {
    if (!SKILL_QUERY_STOPWORDS.has(token)) {
      terms.add(token);
    }
  }
  for (const expansion of SKILL_QUERY_EXPANSIONS) {
    if (expansion.pattern.test(query)) {
      for (const term of expansion.terms) {
        terms.add(term);
      }
    }
  }
  return [...terms];
}

function scoreSkillCandidate(
  candidate: SkillSelectionCandidate,
  queryTerms: readonly string[],
): number {
  const slug = normalizeSkillSearchText(candidate.record.slug);
  const name = normalizeSkillSearchText(candidate.name);
  const description = normalizeSkillSearchText(candidate.description);
  const tags = candidate.tags.map(normalizeSkillSearchText);

  let score = 0;
  for (const term of queryTerms) {
    if (!term) continue;
    if (slug === term || name === term) {
      score += 10;
      continue;
    }
    if (slug.includes(term) || name.includes(term)) score += 5;
    if (tags.some((tag) => tag === term || tag.includes(term))) score += 4;
    if (description.includes(term)) score += 2;
  }
  return score;
}

function trimSkillContent(
  content: string,
  maxChars: number,
): { content: string; truncated: boolean } {
  const trimmed = content.trim();
  if (trimmed.length <= maxChars) {
    return { content: trimmed, truncated: false };
  }
  return {
    content: `${trimmed.slice(0, Math.max(0, maxChars)).trimEnd()}\n\n[Skill content truncated for this turn.]`,
    truncated: true,
  };
}

function buildSkillSelectionCacheKey(records: readonly SkillRecord[]): string {
  return records
    .map((record) =>
      [
        record.slug,
        record.source,
        record.agentId ?? "",
        record.version ?? "",
        record.installedAt ?? "",
      ].join(":"),
    )
    .sort()
    .join("|");
}

export type SkillUninstallRequest = {
  slug: string;
  source?: SkillSource;
  agentId?: string | null;
};

/**
 * All skills (curated, managed, custom) live in a single `skillsDir`.
 * The lowdb ledger (`SkillDb`) is the single source of truth for source categorization.
 */
export class CatalogManager {
  private readonly cacheDir: string;
  private readonly skillsDir: string;
  private readonly db: SkillDb;
  private readonly staticSkillsDir: string;
  private readonly metaPath: string;
  private readonly catalogPath: string;
  private readonly tempCatalogPath: string;
  private readonly log: SkillhubLogFn;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  private readonly userSkillsDir: string;

  private readonly clawHubRegistry: string | undefined;
  private readonly clawHubSearchApi: string | undefined;
  private skillSelectionIndexCache: SkillSelectionIndexCache | null = null;

  constructor(
    cacheDir: string,
    opts: {
      skillsDir?: string;
      userSkillsDir?: string;
      staticSkillsDir?: string;
      skillDb: SkillDb;
      log?: SkillhubLogFn;
      clawHubRegistry?: string;
      clawHubSearchApi?: string;
    },
  ) {
    this.cacheDir = cacheDir;
    this.skillsDir = opts.skillsDir ?? "";
    this.userSkillsDir = opts.userSkillsDir ?? "";
    this.db = opts.skillDb;
    this.staticSkillsDir = opts.staticSkillsDir ?? "";
    this.metaPath = resolve(this.cacheDir, "meta.json");
    this.catalogPath = resolve(this.cacheDir, "catalog.json");
    this.tempCatalogPath = resolve(this.cacheDir, ".catalog-next.json");
    this.log = opts.log ?? noopLog;
    this.clawHubRegistry = opts.clawHubRegistry;
    this.clawHubSearchApi = opts.clawHubSearchApi;
    mkdirSync(this.cacheDir, { recursive: true });
  }

  start(): void {
    if (process.env.CI) {
      this.log("info", "skillhub catalog sync skipped in CI");
      return;
    }

    void this.refreshCatalog().catch(() => {
      // Best-effort initial sync — cached catalog used as fallback.
    });

    this.intervalId = setInterval(() => {
      void this.refreshCatalog().catch(() => {});
    }, DAILY_MS);
  }

  async refreshCatalog(): Promise<{ ok: boolean; skillCount: number }> {
    if (!this.clawHubRegistry) {
      this.log("warn", "catalog refresh skipped — no registry configured");
      return { ok: false, skillCount: 0 };
    }

    const currentMeta = this.readMeta();
    const staleAfterMs = DAILY_MS;
    if (
      currentMeta &&
      Date.now() - new Date(currentMeta.updatedAt).getTime() < staleAfterMs
    ) {
      return { ok: true, skillCount: currentMeta.skillCount };
    }

    const skills = await this.fetchCatalogFromRegistry();

    writeFileSync(this.tempCatalogPath, JSON.stringify(skills), "utf8");
    renameSync(this.tempCatalogPath, this.catalogPath);

    const meta: CatalogMeta = {
      version: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      skillCount: skills.length,
    };
    this.writeMeta(meta);

    this.log("info", `catalog refreshed: ${skills.length} skills`);
    return { ok: true, skillCount: skills.length };
  }

  /**
   * Returns the skill catalog. Installed skills come from the DB ledger
   * (single source of truth), enriched with name/description from SKILL.md on disk.
   */
  getCatalog(): SkillhubCatalogData {
    const skills = this.readCachedSkills();
    const dbRecords = this.db.getAllInstalled();

    const installedSkills: InstalledSkill[] = dbRecords
      .map((r) => {
        const skillMdDir = this.resolveSkillMdDir(r);
        const skillMdPath = resolve(skillMdDir, "SKILL.md");
        const { name, description } = this.parseFrontmatter(skillMdPath);
        return {
          slug: r.slug,
          source: r.source,
          name: name || r.slug,
          description: description || "",
          installedAt: r.installedAt,
          agentId: r.agentId ?? null,
        };
      })
      .sort((a, b) => {
        if (a.installedAt && b.installedAt) {
          const cmp = a.installedAt.localeCompare(b.installedAt);
          if (cmp !== 0) return cmp;
        } else if (a.installedAt && !b.installedAt) {
          return -1;
        } else if (!a.installedAt && b.installedAt) {
          return 1;
        }
        return a.name.localeCompare(b.name);
      });

    const installedSlugs = installedSkills.map((s) => s.slug);
    const meta = this.readMeta();

    return { skills, installedSlugs, installedSkills, meta };
  }

  selectRelevantSkills(input: {
    query: string;
    agentId?: string | null;
    limit?: number;
    maxTotalChars?: number;
    maxSkillChars?: number;
  }): SelectedSkillContext[] {
    const query = input.query.trim();
    if (query.length < 2) {
      return [];
    }

    const queryTerms = tokenizeSkillQuery(query);
    if (queryTerms.length === 0) {
      return [];
    }

    const limit = Math.max(
      1,
      Math.min(input.limit ?? DEFAULT_DYNAMIC_SKILL_LIMIT, 5),
    );
    const maxTotalChars =
      input.maxTotalChars ?? DEFAULT_DYNAMIC_SKILL_MAX_TOTAL_CHARS;
    const maxSkillChars =
      input.maxSkillChars ?? DEFAULT_DYNAMIC_SKILL_MAX_CHARS;
    const installedRecords = this.db.getAllInstalled();

    const candidates = this.getSkillSelectionCandidates(installedRecords)
      .filter(
        (candidate) =>
          candidate.record.source !== "workspace" ||
          (input.agentId && candidate.record.agentId === input.agentId),
      )
      .map((candidate) => ({
        candidate,
        score: scoreSkillCandidate(candidate, queryTerms),
      }))
      .filter((item) => item.score >= DYNAMIC_SKILL_MIN_SCORE)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.candidate.name.localeCompare(b.candidate.name);
      });

    const selected: SelectedSkillContext[] = [];
    let remainingChars = maxTotalChars;
    for (const { candidate, score } of candidates) {
      if (selected.length >= limit || remainingChars <= 0) {
        break;
      }

      const contentBudget = Math.min(maxSkillChars, remainingChars);
      if (contentBudget < 500) {
        break;
      }

      try {
        const { content, truncated } = trimSkillContent(
          readFileSync(candidate.skillMdPath, "utf8"),
          contentBudget,
        );
        if (!content) continue;
        selected.push({
          slug: candidate.record.slug,
          source: candidate.record.source,
          agentId: candidate.record.agentId ?? null,
          name: candidate.name,
          description: candidate.description,
          score,
          content,
          truncated,
        });
        remainingChars -= content.length;
      } catch {
        // A skill may disappear between ledger sync and request time.
      }
    }

    return selected;
  }

  /**
   * Install a skill from ClawHub marketplace.
   * Step A: Download via clawhub into skillsDir
   * Step B: Record in DB with source "managed"
   */
  async installSkill(
    rawSlug: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const slug = SLUG_CORRECTIONS[rawSlug] ?? rawSlug;
    if (!isValidSlug(slug)) {
      this.log("warn", `install rejected slug=${slug} — invalid slug`);
      return { ok: false, error: "Invalid skill slug" };
    }

    this.log("info", `installing skill slug=${slug} dir=${this.skillsDir}`);
    try {
      const clawHubBin = resolveClawHubBin();
      this.log("info", `install resolved clawhub=${clawHubBin}`);
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [
          clawHubBin,
          "--workdir",
          this.skillsDir,
          "--dir",
          ".",
          "install",
          slug,
          "--force",
        ],
        { env: this.clawHubEnv() },
      );
      if (stdout)
        this.log("info", `install stdout slug=${slug}: ${stdout.trim()}`);
      if (stderr)
        this.log("warn", `install stderr slug=${slug}: ${stderr.trim()}`);
      this.log("info", `install ok slug=${slug}`);
      await this.installSkillDeps(resolve(this.skillsDir, slug), slug);
      this.db.recordInstall(slug, "managed");
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log("error", `install failed slug=${slug}: ${message}`);
      return { ok: false, error: message };
    }
  }

  /**
   * Execute a single clawhub install + npm deps. Does NOT record in DB.
   * Used by InstallQueue as the executor function.
   */
  async executeInstall(rawSlug: string): Promise<void> {
    const slug = SLUG_CORRECTIONS[rawSlug] ?? rawSlug;
    if (!isValidSlug(slug)) {
      throw new Error(`Invalid skill slug: ${slug}`);
    }

    this.log("info", `installing: ${slug} -> ${this.skillsDir}`);
    const clawHubBin = resolveClawHubBin();
    this.log("info", `install resolved clawhub=${clawHubBin}`);

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        clawHubBin,
        "--workdir",
        this.skillsDir,
        "--dir",
        ".",
        "install",
        slug,
        "--force",
      ],
      { env: this.clawHubEnv() },
    );
    if (stdout) this.log("info", `install stdout ${slug}: ${stdout.trim()}`);
    if (stderr) this.log("warn", `install stderr ${slug}: ${stderr.trim()}`);

    await this.installSkillDeps(resolve(this.skillsDir, slug), slug);
  }

  /**
   * Returns curated slugs that have no record in the ledger.
   * Used by SkillhubService to enqueue on startup.
   */
  canonicalizeSlug(rawSlug: string): string {
    return SLUG_CORRECTIONS[rawSlug] ?? rawSlug;
  }

  getCuratedSlugsToEnqueue(): string[] {
    const knownSlugs = this.db.getAllKnownSlugs();
    return CURATED_SKILL_SLUGS.filter((slug) => !knownSlugs.has(slug));
  }

  /**
   * Uninstall a skill.
   * Step A: Look up source from DB record
   * Step B: Delete skill folder from skillsDir
   * Step C: Record uninstall in DB with correct source
   */
  async uninstallSkill(
    request: string | SkillUninstallRequest,
  ): Promise<{ ok: boolean; error?: string }> {
    const payload =
      typeof request === "string" ? { slug: request } : { ...request };
    const slug = SLUG_CORRECTIONS[payload.slug] ?? payload.slug;
    if (!isValidSlug(slug)) {
      this.log("warn", `uninstall rejected slug=${slug} — invalid slug`);
      return { ok: false, error: "Invalid skill slug" };
    }

    if (payload.source === "workspace" && !payload.agentId) {
      this.log(
        "warn",
        `uninstall rejected slug=${slug} — workspace uninstall missing agentId`,
      );
      return { ok: false, error: "Workspace uninstall requires agentId" };
    }

    this.log("info", `uninstalling skill slug=${slug}`);
    try {
      const dbRecords = this.db.getInstalledRecordsBySlug(slug);
      const record = this.resolveInstalledRecord(dbRecords, payload);
      if (!record && payload.source === "workspace") {
        return {
          ok: false,
          error: "Workspace skill not installed for the selected agent",
        };
      }
      if (
        !record &&
        !payload.source &&
        dbRecords.some((item) => item.source === "workspace")
      ) {
        return { ok: false, error: "Workspace uninstall requires agentId" };
      }

      const skillPath = record
        ? this.resolveSkillMdDir(record)
        : resolveSkillPath(this.skillsDir, slug);
      if (skillPath && existsSync(skillPath)) {
        rmSync(skillPath, { recursive: true, force: true });
        const source: SkillSource =
          record?.source ?? payload.source ?? "managed";
        this.log("info", `uninstall ok (${source}) slug=${slug}`);
        this.db.recordUninstall(
          slug,
          source,
          record?.agentId ?? payload.agentId,
        );
      } else {
        this.log("warn", `uninstall skip slug=${slug} — dir not found`);
      }

      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log("error", `uninstall failed slug=${slug}: ${message}`);
      return { ok: false, error: message };
    }
  }

  /**
   * @deprecated Replaced by the InstallQueue-based flow in SkillhubService.start().
   * Curated slugs are now resolved via {@link getCuratedSlugsToEnqueue} (ledger-only)
   * and enqueued into the InstallQueue. This method is retained for backward compatibility.
   */
  async installCuratedSkills(): Promise<CuratedInstallResult> {
    const failed: string[] = [];

    // Step 1: Copy static skills (not on ClawHub) from app bundle into skillsDir
    if (this.staticSkillsDir) {
      const { copied, failed: copyFailures } = copyStaticSkills({
        staticDir: this.staticSkillsDir,
        targetDir: this.skillsDir,
        skillDb: this.db,
      });
      if (copied.length > 0) {
        this.db.recordBulkInstall(copied, "managed");
        this.log("info", `curated static skills copied: ${copied.join(", ")}`);
      }
      if (copyFailures.length > 0) {
        for (const failure of copyFailures) {
          failed.push(failure.slug);
          this.log(
            "warn",
            `curated static skill copy failed: ${failure.slug} — ${failure.error}`,
          );
        }
      }
    }

    // Step 1b: Record any on-disk skills in skillsDir not yet tracked in DB
    if (this.skillsDir && existsSync(this.skillsDir)) {
      const untracked: string[] = [];
      try {
        for (const entry of readdirSync(this.skillsDir, {
          withFileTypes: true,
        })) {
          if (
            entry.isDirectory() &&
            existsSync(resolve(this.skillsDir, entry.name, "SKILL.md")) &&
            !this.db.isInstalled(entry.name, "managed") &&
            !this.db.isInstalled(entry.name, "managed") &&
            !this.db.isInstalled(entry.name, "custom")
          ) {
            untracked.push(entry.name);
          }
        }
      } catch {
        // Directory not readable — skip
      }
      if (untracked.length > 0) {
        this.db.recordBulkInstall(untracked, "managed");
        this.log(
          "info",
          `curated on-disk skills recorded: ${untracked.join(", ")}`,
        );
      }
    }

    // Step 2: Install remaining curated skills from ClawHub into skillsDir
    const { toInstall, toSkip } = resolveCuratedSkillsToInstall({
      targetDir: this.skillsDir,
      skillDb: this.db,
    });

    if (toInstall.length === 0) {
      this.log(
        "info",
        `curated skills: nothing to install (${toSkip.length} skipped)`,
      );
      return { installed: [], skipped: toSkip, failed };
    }

    this.log("info", `curated skills: installing ${toInstall.length} skills`);

    const clawHubBin = resolveClawHubBin();
    const CONCURRENCY = 5;

    const installOne = async (
      slug: string,
    ): Promise<{ slug: string; ok: boolean }> => {
      try {
        this.log("info", `curated installing: ${slug} -> ${this.skillsDir}`);
        const { stdout, stderr } = await execFileAsync(
          process.execPath,
          [
            clawHubBin,
            "--workdir",
            this.skillsDir,
            "--dir",
            ".",
            "install",
            slug,
            "--force",
          ],
          { env: this.clawHubEnv() },
        );
        if (stdout) this.log("info", `curated stdout: ${stdout.trim()}`);
        if (stderr) this.log("warn", `curated stderr: ${stderr.trim()}`);
        this.log("info", `curated install ok: ${slug}`);
        return { slug, ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log("error", `curated install failed: ${slug} — ${message}`);
        return { slug, ok: false };
      }
    };

    const installed: string[] = [];

    for (let i = 0; i < toInstall.length; i += CONCURRENCY) {
      const batch = toInstall.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(batch.map(installOne));
      for (const result of results) {
        if (result.status === "fulfilled" && result.value.ok) {
          installed.push(result.value.slug);
        } else {
          const slug =
            result.status === "fulfilled" ? result.value.slug : "unknown";
          failed.push(slug);
        }
      }
    }

    if (installed.length > 0) {
      await Promise.allSettled(
        installed.map((slug) =>
          this.installSkillDeps(resolve(this.skillsDir, slug), slug),
        ),
      );
    }

    if (installed.length > 0) {
      this.db.recordBulkInstall(installed, "managed");
    }

    return { installed, skipped: toSkip, failed };
  }

  async importSkillZip(
    zipBuffer: Buffer,
  ): Promise<{ ok: boolean; slug?: string; error?: string }> {
    this.log("info", "importing custom skill from zip");
    const result = extractZip(zipBuffer, this.skillsDir);
    if (result.ok && result.slug) {
      this.db.recordInstall(result.slug, "custom");
      this.log("info", `custom skill imported: ${result.slug}`);
      await this.installSkillDeps(
        resolve(this.skillsDir, result.slug),
        result.slug,
      );
    } else {
      this.log("error", `custom skill import failed: ${result.error}`);
    }
    return result;
  }

  /**
   * One-way sync: scan skillsDir for skills not tracked in DB and record them.
   * Also marks DB records as uninstalled if the skill folder is missing.
   */
  reconcileDbWithDisk(): void {
    if (!this.skillsDir || !existsSync(this.skillsDir)) return;

    // Clean up known junk that confuses clawhub CLI
    for (const junk of [".clawhub", "skills"]) {
      const junkPath = resolve(this.skillsDir, junk);
      if (existsSync(junkPath)) {
        const hasSkillMd = existsSync(resolve(junkPath, "SKILL.md"));
        if (!hasSkillMd) {
          rmSync(junkPath, { recursive: true, force: true });
          this.log("info", `reconcile: removed junk directory ${junk}`);
        }
      }
    }

    const dbRecords = this.db.getAllInstalled();

    // DB → disk: handle "installed" records whose SKILL.md is missing from disk
    const missingBySource = new Map<string, string[]>();
    for (const record of dbRecords) {
      const skillMd = resolve(this.resolveSkillMdDir(record), "SKILL.md");
      if (!existsSync(skillMd)) {
        const key =
          record.source === "workspace"
            ? `${record.source}:${record.agentId ?? ""}`
            : record.source;
        const list = missingBySource.get(key) ?? [];
        list.push(record.slug);
        missingBySource.set(key, list);
      }
    }

    let totalMissing = 0;
    for (const [key, slugs] of missingBySource) {
      const [source, agentId] = key.split(":");
      this.db.markUninstalledBySlugs(
        slugs,
        source as SkillSource,
        source === "workspace" ? agentId || null : undefined,
      );
      totalMissing += slugs.length;
    }
    if (totalMissing > 0) {
      this.log(
        "info",
        `reconcile: ${totalMissing} installed records marked uninstalled (missing from disk)`,
      );
    }

    // Disk → DB: record untracked skills as "managed"
    const trackedSlugs = new Set(this.db.getAllInstalled().map((r) => r.slug));
    const diskOnly: string[] = [];

    try {
      const entries = readdirSync(this.skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (
          entry.isDirectory() &&
          existsSync(resolve(this.skillsDir, entry.name, "SKILL.md")) &&
          !trackedSlugs.has(entry.name)
        ) {
          diskOnly.push(entry.name);
        }
      }
    } catch {
      // Directory not readable — skip
    }

    if (diskOnly.length > 0) {
      this.db.recordBulkInstall(diskOnly, "managed");
      this.log(
        "info",
        `reconcile: ${diskOnly.length} on-disk skills recorded in DB`,
      );
    }

    if (totalMissing === 0 && diskOnly.length === 0) {
      this.log("info", "reconcile: DB and disk are in sync");
    }
  }

  private clawHubEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      ...(this.clawHubRegistry
        ? { CLAWHUB_REGISTRY: this.clawHubRegistry }
        : {}),
    };
  }

  dispose(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.db.close();
  }

  private async installSkillDeps(
    skillDir: string,
    slug: string,
  ): Promise<void> {
    if (!existsSync(resolve(skillDir, "package.json"))) return;

    this.log("info", `installing npm deps: ${slug}`);
    try {
      const npmArgs = ["install", "--production", "--no-audit", "--no-fund"];
      await execFileAsync("npm", npmArgs, { cwd: skillDir });
      this.log("info", `npm deps installed: ${slug}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log("warn", `npm deps failed for ${slug}: ${message}`);
    }
  }

  private getSkillSelectionCandidates(
    records: readonly SkillRecord[],
  ): SkillSelectionCandidate[] {
    const cacheKey = buildSkillSelectionCacheKey(records);
    const now = Date.now();
    if (
      this.skillSelectionIndexCache &&
      this.skillSelectionIndexCache.key === cacheKey &&
      this.skillSelectionIndexCache.expiresAt > now
    ) {
      return this.skillSelectionIndexCache.candidates;
    }

    const catalogBySlug = new Map(
      this.readCachedSkills().map((skill) => [skill.slug, skill]),
    );
    const candidates = records.flatMap((record): SkillSelectionCandidate[] => {
      const skillMdPath = resolve(this.resolveSkillMdDir(record), "SKILL.md");
      if (!existsSync(skillMdPath)) {
        return [];
      }

      const cached = catalogBySlug.get(record.slug);
      const frontmatter =
        cached && record.source === "managed"
          ? { name: "", description: "" }
          : this.parseFrontmatter(skillMdPath);
      return [
        {
          record,
          name: frontmatter.name || cached?.name || record.slug,
          description: frontmatter.description || cached?.description || "",
          tags: cached?.tags ?? [],
          skillMdPath,
        },
      ];
    });

    this.skillSelectionIndexCache = {
      key: cacheKey,
      expiresAt: now + DYNAMIC_SKILL_INDEX_CACHE_MS,
      candidates,
    };
    return candidates;
  }

  /**
   * Resolves the directory containing SKILL.md for a given skill record.
   * Workspace skills live under `agents/<agentId>/skills/<slug>`,
   * while shared skills live under the common `skillsDir/<slug>`.
   */
  private resolveSkillMdDir(record: SkillRecord): string {
    if (record.source === "workspace" && record.agentId) {
      const stateDir = dirname(this.skillsDir);
      return join(stateDir, "agents", record.agentId, "skills", record.slug);
    }
    if (record.source === "user" && this.userSkillsDir) {
      return join(this.userSkillsDir, record.slug);
    }
    return resolve(this.skillsDir, record.slug);
  }

  private resolveInstalledRecord(
    records: readonly SkillRecord[],
    request: SkillUninstallRequest,
  ): SkillRecord | undefined {
    if (request.source === "workspace") {
      return records.find(
        (record) =>
          record.source === "workspace" && record.agentId === request.agentId,
      );
    }

    if (request.source) {
      return records.find((record) => record.source === request.source);
    }

    const sharedRecord = records.find(
      (record) => record.source !== "workspace",
    );
    if (sharedRecord) {
      return sharedRecord;
    }

    if (records.length === 1) {
      return records[0];
    }

    return undefined;
  }

  private parseFrontmatter(filePath: string): {
    name: string;
    description: string;
  } {
    try {
      const content = readFileSync(filePath, "utf8");
      const match = content.match(/^---\n([\s\S]*?)\n---/);
      if (!match?.[1]) return { name: "", description: "" };
      const frontmatter = match[1];
      const nameMatch = frontmatter.match(/^name:\s*['"]?(.+?)['"]?\s*$/m);

      // Match description: single line, or multiline block after | or >
      let description = "";
      const descMatch = frontmatter.match(
        /^description:\s*['"]?(.+?)['"]?\s*$/m,
      );
      const rawDesc = descMatch?.[1]?.trim() ?? "";
      if (rawDesc && rawDesc !== "|" && rawDesc !== ">") {
        description = rawDesc;
      } else {
        // Multiline: collect indented lines after description:
        const descBlockMatch = frontmatter.match(
          /^description:\s*[|>]?\s*\n((?:[ \t]+.+\n?)+)/m,
        );
        if (descBlockMatch?.[1]) {
          description = descBlockMatch[1]
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .join(" ");
        }
      }

      return {
        name: nameMatch?.[1]?.trim() ?? "",
        description,
      };
    } catch {
      return { name: "", description: "" };
    }
  }

  async searchRegistry(
    query: string,
    limit: number,
    marker?: string,
  ): Promise<{ skills: MinimalSkill[]; nextMarker: string | null }> {
    const searchBase = this.clawHubSearchApi ?? this.clawHubRegistry;
    if (!searchBase) {
      return { skills: [], nextMarker: null };
    }

    const url = new URL("/api/v1/search", searchBase);
    url.searchParams.set("q", query);
    url.searchParams.set("limit", String(limit));
    if (marker) url.searchParams.set("marker", marker);

    const response = await proxyFetch(url.toString());
    if (!response.ok) {
      throw new Error(`Search API failed: ${response.status}`);
    }

    const data = (await response.json()) as {
      results?: unknown[];
      nextMarker?: string;
    };

    const skills = mapRegistryResults(data.results ?? []);
    return { skills, nextMarker: data.nextMarker ?? null };
  }

  private async fetchCatalogFromRegistry(): Promise<MinimalSkill[]> {
    const baseUrl = this.clawHubSearchApi ?? this.clawHubRegistry;
    if (!baseUrl) {
      return [];
    }
    const all: MinimalSkill[] = [];
    let marker: string | undefined;

    for (;;) {
      const url = new URL("/api/v1/search", baseUrl);
      url.searchParams.set("q", "");
      url.searchParams.set("limit", String(CATALOG_API_PAGE_LIMIT));
      if (marker) url.searchParams.set("marker", marker);

      const response = await proxyFetch(url.toString());
      if (!response.ok) {
        throw new Error(`Catalog API failed: ${response.status}`);
      }

      const data = (await response.json()) as {
        results?: unknown[];
        nextMarker?: string;
      };

      all.push(...mapRegistryResults(data.results ?? []));

      if (
        !data.nextMarker ||
        (data.results ?? []).length < CATALOG_API_PAGE_LIMIT
      ) {
        break;
      }
      marker = data.nextMarker;
    }

    return all;
  }

  private readCachedSkills(): MinimalSkill[] {
    if (!existsSync(this.catalogPath)) {
      return [];
    }

    try {
      const skills = JSON.parse(
        readFileSync(this.catalogPath, "utf8"),
      ) as MinimalSkill[];
      return skills
        .filter((s) => !CATALOG_BLOCKLIST.has(s.slug))
        .map((s) => {
          const corrected = SLUG_CORRECTIONS[s.slug];
          return corrected ? { ...s, slug: corrected } : s;
        });
    } catch {
      return [];
    }
  }

  private readMeta(): CatalogMeta | null {
    if (!existsSync(this.metaPath)) {
      return null;
    }

    try {
      return JSON.parse(readFileSync(this.metaPath, "utf8")) as CatalogMeta;
    } catch {
      return null;
    }
  }

  private writeMeta(meta: CatalogMeta): void {
    writeFileSync(this.metaPath, JSON.stringify(meta, null, 2), "utf8");
  }
}
