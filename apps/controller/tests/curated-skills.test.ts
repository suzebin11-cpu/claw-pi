import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyStaticSkills } from "../src/services/skillhub/curated-skills.js";
import type { SkillDb } from "../src/services/skillhub/skill-db.js";

function createSkillDbMock(knownSlugs: readonly string[] = []): SkillDb {
  const trackedSlugs = new Set(knownSlugs);
  return {
    getAllKnownSlugs: () => new Set(trackedSlugs),
    recordUninstall: (slug: string) => {
      trackedSlugs.add(slug);
    },
  } as unknown as SkillDb;
}

describe("copyStaticSkills", () => {
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-curated-skills-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("continues copying later skills after one static skill copy fails, and retries on next run", () => {
    const staticDir = path.join(rootDir, "static-skills");
    const targetDir = path.join(rootDir, "target-skills");
    // Track every recordUninstall call across both invocations. The whole
    // point of the regression fix is that transient cpSync failures must
    // NEVER mark the slug as "uninstalled" in the ledger — otherwise the
    // next startup sees it in `getAllKnownSlugs()` and skips the retry
    // forever, permanently bricking that internal skill from a single
    // EPERM/EACCES (Windows antivirus, file handle, …).
    const recordedUninstalls: Array<{ slug: string; source: string }> = [];
    const knownSlugs = new Set<string>();
    const skillDb = {
      getAllKnownSlugs: () => new Set(knownSlugs),
      recordUninstall: (slug: string, source: string) => {
        recordedUninstalls.push({ slug, source });
        knownSlugs.add(slug);
      },
    } as unknown as SkillDb;

    mkdirSync(path.join(staticDir, "libtv-video"), { recursive: true });
    writeFileSync(
      path.join(staticDir, "libtv-video", "SKILL.md"),
      "# libtv-video\n",
      "utf8",
    );

    mkdirSync(path.join(staticDir, "coding-agent"), { recursive: true });
    writeFileSync(
      path.join(staticDir, "coding-agent", "SKILL.md"),
      "# coding-agent\n",
      "utf8",
    );

    mkdirSync(targetDir, { recursive: true });
    writeFileSync(path.join(targetDir, "libtv-video"), "blocked", "utf8");

    const result = copyStaticSkills({
      staticDir,
      targetDir,
      skillDb,
    });

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.slug).toBe("libtv-video");
    expect(result.copied).toContain("coding-agent");
    expect(
      readFileSync(path.join(targetDir, "coding-agent", "SKILL.md"), "utf8"),
    ).toContain("coding-agent");

    // The blocking file in `targetDir/libtv-video` should be cleaned up by
    // the catch-block's best-effort rmSync (so the next startup can retry).
    expect(existsSync(path.join(targetDir, "libtv-video"))).toBe(false);

    // Re-introduce the blocker to simulate the same transient condition
    // persisting across a process restart. The failure must remain just
    // that — a failure — without being demoted to a silent "skipped"
    // entry on subsequent runs.
    writeFileSync(path.join(targetDir, "libtv-video"), "blocked", "utf8");

    const secondResult = copyStaticSkills({
      staticDir,
      targetDir,
      skillDb,
    });

    expect(secondResult.failed).toHaveLength(1);
    expect(secondResult.failed[0]?.slug).toBe("libtv-video");
    expect(secondResult.skipped).not.toContain("libtv-video");
    expect(secondResult.skipped).toContain("coding-agent");

    expect(recordedUninstalls).toEqual([]);
  });

  it("skips ledger-known static skills without reporting failures", () => {
    const staticDir = path.join(rootDir, "static-skills");
    const targetDir = path.join(rootDir, "target-skills");

    mkdirSync(path.join(staticDir, "libtv-video"), { recursive: true });
    writeFileSync(
      path.join(staticDir, "libtv-video", "SKILL.md"),
      "# libtv-video\n",
      "utf8",
    );

    const result = copyStaticSkills({
      staticDir,
      targetDir,
      skillDb: createSkillDbMock(["libtv-video"]),
    });

    expect(result.copied).not.toContain("libtv-video");
    expect(result.skipped).toContain("libtv-video");
    expect(result.failed).toHaveLength(0);
  });
});
