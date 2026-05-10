import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { SkillDb } from "./skill-db.js";

/**
 * Skills to install from ClawHub on first launch.
 */
export const CURATED_SKILL_SLUGS: readonly string[] = [
  // Security & tools
  "healthcheck",
  "skill-vetter",
  // Search & information
  "multi-search-engine",
  // Notes & content
  "humanize-ai-text",
  // File & system
  "file-organizer-skill",
  "video-frames",
  "session-logs",
  // Skill discovery
  "find-skill",
  // Search & content (ClawHub mirror)
  "wechat-article-search",
] as const;

/**
 * Skills shipped as static files in the app bundle (apps/desktop/static/bundled-skills/).
 * These are NOT on ClawHub, so they're copied directly to the skills directory.
 */
export const STATIC_SKILL_SLUGS: readonly string[] = [
  "libtv-video",
  "coding-agent",
  "clawhub",
  "nano-banana-one-shop",
  "deep-research",
  "research-to-diagram",
  "qiaomu-mondo-poster-design",
  "medeo-video",
  "self-improving",
] as const;

/**
 * Copies static skills from the app bundle to the target skills directory.
 * Respects the user's removal ledger — won't re-copy skills the user uninstalled.
 */
export type StaticSkillCopyFailure = {
  slug: string;
  error: string;
};

export function copyStaticSkills(params: {
  staticDir: string;
  targetDir: string;
  skillDb: SkillDb;
}): {
  copied: string[];
  skipped: string[];
  failed: StaticSkillCopyFailure[];
} {
  const copied: string[] = [];
  const skipped: string[] = [];
  const failed: StaticSkillCopyFailure[] = [];

  if (!existsSync(params.staticDir)) {
    return { copied, skipped, failed };
  }

  const knownSlugs = params.skillDb.getAllKnownSlugs();

  for (const slug of STATIC_SKILL_SLUGS) {
    const destDir = resolve(params.targetDir, slug);
    if (existsSync(resolve(destDir, "SKILL.md"))) {
      skipped.push(slug);
      continue;
    }

    // Skip if ledger already knows this slug (user uninstalled it, or it's tracked)
    if (knownSlugs.has(slug)) {
      skipped.push(slug);
      continue;
    }

    const srcDir = resolve(params.staticDir, slug);
    if (!existsSync(srcDir)) {
      skipped.push(slug);
      continue;
    }

    try {
      mkdirSync(destDir, { recursive: true });
      cpSync(srcDir, destDir, { recursive: true });
      copied.push(slug);
    } catch (error) {
      failed.push({
        slug,
        error: error instanceof Error ? error.message : String(error),
      });
      // Intentionally do NOT recordUninstall(slug, "managed") here. A
      // transient cpSync failure (EPERM/EACCES from antivirus, EBUSY from
      // a file handle, ENOSPC, …) is not the same as the user removing
      // the skill — using the same ledger row for both meant a single
      // failed copy permanently bricked that internal skill, because
      // `getAllKnownSlugs()` does not distinguish installed-vs-uninstalled
      // and the next startup short-circuits at the `knownSlugs.has(slug)`
      // gate above. Leaving the ledger untouched lets the next startup
      // retry the copy until it succeeds, while still respecting genuine
      // user uninstalls (those go through `CatalogManager.uninstallSkill`
      // and write `recordUninstall("managed")` themselves).
      try {
        rmSync(destDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failures; startup should continue regardless.
      }
    }
  }

  return { copied, skipped, failed };
}

export type CuratedInstallResult = {
  installed: string[];
  skipped: string[];
  failed: string[];
};

/**
 * Returns the list of curated skill slugs that need to be installed.
 * Skips slugs the user explicitly removed and slugs already present on disk.
 *
 * @deprecated Use {@link CatalogManager.getCuratedSlugsToEnqueue} instead,
 * which checks only the ledger (no disk I/O). This function is retained for
 * backward compatibility with {@link CatalogManager.installCuratedSkills}.
 */
export function resolveCuratedSkillsToInstall(params: {
  targetDir: string;
  skillDb: SkillDb;
}): { toInstall: string[]; toSkip: string[] } {
  const toInstall: string[] = [];
  const toSkip: string[] = [];

  for (const slug of CURATED_SKILL_SLUGS) {
    const skillDir = resolve(params.targetDir, slug);
    if (existsSync(resolve(skillDir, "SKILL.md"))) {
      toSkip.push(slug);
      continue;
    }
    toInstall.push(slug);
  }

  return { toInstall, toSkip };
}
