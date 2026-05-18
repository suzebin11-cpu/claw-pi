import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CatalogManager } from "../src/services/skillhub/catalog-manager.js";
import { SkillDb } from "../src/services/skillhub/skill-db.js";

describe("CatalogManager.getCatalog() workspace skills", () => {
  let tmpDir: string;
  let skillDb: SkillDb;
  let skillsDir: string;
  let stateDir: string;
  let cacheDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "nexu-catalog-ws-"));
    stateDir = path.join(tmpDir, "openclaw-state");
    skillsDir = path.join(stateDir, "skills");
    cacheDir = path.join(tmpDir, "skillhub-cache");
    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(cacheDir, { recursive: true });

    const dbPath = path.join(tmpDir, "skill-ledger.json");
    skillDb = await SkillDb.create(dbPath);
  });

  afterEach(async () => {
    skillDb.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns agentId: null for managed skills", () => {
    // Setup: managed skill on disk
    const skillDir = path.join(skillsDir, "web-search");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: Web Search\ndescription: Search the web\n---\n",
    );
    skillDb.recordInstall("web-search", "managed");

    const catalog = new CatalogManager(cacheDir, {
      skillsDir,
      skillDb,
    });

    const result = catalog.getCatalog();
    const managed = result.installedSkills.find((s) => s.slug === "web-search");

    expect(managed).toBeDefined();
    expect(managed?.agentId).toBeNull();
    expect(managed?.source).toBe("managed");
  });

  it("returns agentId for workspace skills", () => {
    // Setup: workspace skill on disk under agents dir
    const agentSkillDir = path.join(
      stateDir,
      "agents",
      "bot-abc",
      "skills",
      "my-tool",
    );
    mkdirSync(agentSkillDir, { recursive: true });
    writeFileSync(
      path.join(agentSkillDir, "SKILL.md"),
      "---\nname: My Tool\ndescription: A workspace tool\n---\n",
    );
    skillDb.recordInstall("my-tool", "workspace", undefined, "bot-abc");

    const catalog = new CatalogManager(cacheDir, {
      skillsDir,
      skillDb,
    });

    const result = catalog.getCatalog();
    const ws = result.installedSkills.find((s) => s.slug === "my-tool");

    expect(ws).toBeDefined();
    expect(ws?.agentId).toBe("bot-abc");
    expect(ws?.source).toBe("workspace");
    expect(ws?.name).toBe("My Tool");
    expect(ws?.description).toBe("A workspace tool");
  });

  it("resolves workspace skill SKILL.md from agents dir, not shared skills dir", () => {
    // The workspace skill dir is under agents/<agentId>/skills/<slug>
    // NOT under the shared skills dir
    const agentSkillDir = path.join(
      stateDir,
      "agents",
      "bot-xyz",
      "skills",
      "private-tool",
    );
    mkdirSync(agentSkillDir, { recursive: true });
    writeFileSync(
      path.join(agentSkillDir, "SKILL.md"),
      "---\nname: Private Tool\ndescription: Agent-specific tool\n---\n",
    );
    skillDb.recordInstall("private-tool", "workspace", undefined, "bot-xyz");

    const catalog = new CatalogManager(cacheDir, {
      skillsDir,
      skillDb,
    });

    const result = catalog.getCatalog();
    const ws = result.installedSkills.find((s) => s.slug === "private-tool");

    expect(ws).toBeDefined();
    expect(ws?.name).toBe("Private Tool");
    expect(ws?.description).toBe("Agent-specific tool");
  });

  it("returns slug as name fallback when SKILL.md not found for workspace skill", () => {
    // No SKILL.md on disk, but DB record exists
    skillDb.recordInstall("ghost-skill", "workspace", undefined, "bot-404");

    const catalog = new CatalogManager(cacheDir, {
      skillsDir,
      skillDb,
    });

    const result = catalog.getCatalog();
    const ws = result.installedSkills.find((s) => s.slug === "ghost-skill");

    expect(ws).toBeDefined();
    expect(ws?.agentId).toBe("bot-404");
    expect(ws?.name).toBe("ghost-skill");
    expect(ws?.description).toBe("");
  });

  it("mixes managed and workspace skills in one catalog result", () => {
    // Managed skill
    const managedDir = path.join(skillsDir, "calendar");
    mkdirSync(managedDir, { recursive: true });
    writeFileSync(
      path.join(managedDir, "SKILL.md"),
      "---\nname: Calendar\ndescription: Manage calendar\n---\n",
    );
    skillDb.recordInstall("calendar", "managed");

    // Workspace skill
    const wsDir = path.join(stateDir, "agents", "bot-1", "skills", "deploy");
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(
      path.join(wsDir, "SKILL.md"),
      "---\nname: Deploy\ndescription: Deploy to prod\n---\n",
    );
    skillDb.recordInstall("deploy", "workspace", undefined, "bot-1");

    const catalog = new CatalogManager(cacheDir, {
      skillsDir,
      skillDb,
    });

    const result = catalog.getCatalog();

    expect(result.installedSkills).toHaveLength(2);
    expect(result.installedSlugs).toEqual(
      expect.arrayContaining(["calendar", "deploy"]),
    );

    const managed = result.installedSkills.find((s) => s.slug === "calendar");
    const workspace = result.installedSkills.find((s) => s.slug === "deploy");

    expect(managed?.agentId).toBeNull();
    expect(workspace?.agentId).toBe("bot-1");
  });

  it("selects relevant installed skill content without loading unrelated skills", () => {
    const imageDir = path.join(skillsDir, "image-maker");
    mkdirSync(imageDir, { recursive: true });
    writeFileSync(
      path.join(imageDir, "SKILL.md"),
      [
        "---",
        "name: Image Maker",
        "description: Generate and edit images",
        "---",
        "Use this skill when the user asks to create an image.",
      ].join("\n"),
    );
    const webDir = path.join(skillsDir, "web-search");
    mkdirSync(webDir, { recursive: true });
    writeFileSync(
      path.join(webDir, "SKILL.md"),
      [
        "---",
        "name: Web Search",
        "description: Search web pages",
        "---",
        "Use this skill for browser research.",
      ].join("\n"),
    );
    skillDb.recordInstall("image-maker", "managed");
    skillDb.recordInstall("web-search", "managed");

    const catalog = new CatalogManager(cacheDir, {
      skillsDir,
      skillDb,
    });

    const selected = catalog.selectRelevantSkills({
      query: "帮我生成一张图片",
      limit: 3,
    });

    expect(selected.map((skill) => skill.slug)).toContain("image-maker");
    expect(selected.map((skill) => skill.slug)).not.toContain("web-search");
    expect(selected[0]?.content).toContain("Use this skill");
  });

  it("limits workspace skill selection to the active agent", () => {
    const botOneSkillDir = path.join(
      stateDir,
      "agents",
      "bot-1",
      "skills",
      "deploy-helper",
    );
    mkdirSync(botOneSkillDir, { recursive: true });
    writeFileSync(
      path.join(botOneSkillDir, "SKILL.md"),
      "---\nname: Deploy Helper\ndescription: Deploy production services\n---\n",
    );
    const botTwoSkillDir = path.join(
      stateDir,
      "agents",
      "bot-2",
      "skills",
      "deploy-helper",
    );
    mkdirSync(botTwoSkillDir, { recursive: true });
    writeFileSync(
      path.join(botTwoSkillDir, "SKILL.md"),
      "---\nname: Other Deploy Helper\ndescription: Deploy another service\n---\n",
    );
    skillDb.recordInstall("deploy-helper", "workspace", undefined, "bot-1");
    skillDb.recordInstall("deploy-helper", "workspace", undefined, "bot-2");

    const catalog = new CatalogManager(cacheDir, {
      skillsDir,
      skillDb,
    });

    const selected = catalog.selectRelevantSkills({
      query: "deploy production",
      agentId: "bot-1",
    });

    expect(selected).toHaveLength(1);
    expect(selected[0]?.agentId).toBe("bot-1");
    expect(selected[0]?.name).toBe("Deploy Helper");
  });

  it("does not select skills for weak unmatched chat", () => {
    const skillDir = path.join(skillsDir, "web-search");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: Web Search\ndescription: Search web pages\n---\n",
    );
    skillDb.recordInstall("web-search", "managed");

    const catalog = new CatalogManager(cacheDir, {
      skillsDir,
      skillDb,
    });

    expect(catalog.selectRelevantSkills({ query: "你好" })).toEqual([]);
  });
});
