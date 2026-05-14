import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ControllerEnv } from "../src/app/env.js";
import { WorkspaceTemplateWriter } from "../src/runtime/workspace-template-writer.js";

const legacyAgents = `# AGENTS.md - Your Workspace

## Every Session

Before doing anything else:

1. Read \`SOUL.md\` — this is who you are
2. Read \`USER.md\` — this is who you're helping
3. Read \`memory/YYYY-MM-DD.md\` (today + yesterday) for recent context
4. **If in MAIN SESSION** (direct chat with your human): Also read \`MEMORY.md\`

Don't ask permission. Just do it.

## Memory
`;

describe("WorkspaceTemplateWriter", () => {
  let rootDir = "";
  let env: ControllerEnv;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-template-writer-"));
    env = {
      nodeEnv: "test",
      port: 3010,
      host: "127.0.0.1",
      webUrl: "http://localhost:5173",
      nexuHomeDir: path.join(rootDir, ".nexu"),
      nexuConfigPath: path.join(rootDir, ".nexu", "config.json"),
      artifactsIndexPath: path.join(
        rootDir,
        ".nexu",
        "artifacts",
        "index.json",
      ),
      compiledOpenclawSnapshotPath: path.join(
        rootDir,
        ".nexu",
        "compiled-openclaw.json",
      ),
      openclawStateDir: path.join(rootDir, ".openclaw"),
      openclawConfigPath: path.join(rootDir, ".openclaw", "openclaw.json"),
      openclawSkillsDir: path.join(rootDir, ".openclaw", "skills"),
      userSkillsDir: path.join(rootDir, ".agents", "skills"),
      openclawBuiltinExtensionsDir: null,
      openclawExtensionsDir: path.join(rootDir, ".openclaw", "extensions"),
      bundledRuntimePluginsDir: path.join(rootDir, "plugins"),
      runtimePluginTemplatesDir: path.join(rootDir, "runtime-plugins"),
      openclawCuratedSkillsDir: path.join(
        rootDir,
        ".openclaw",
        "bundled-skills",
      ),
      openclawRuntimeModelStatePath: path.join(
        rootDir,
        ".openclaw",
        "nexu-runtime-model.json",
      ),
      skillhubCacheDir: path.join(rootDir, ".nexu", "skillhub-cache"),
      skillDbPath: path.join(rootDir, ".nexu", "skill-ledger.json"),
      analyticsStatePath: path.join(rootDir, ".nexu", "analytics-state.json"),
      staticSkillsDir: undefined,
      platformTemplatesDir: path.join(rootDir, "platform-templates"),
      openclawWorkspaceTemplatesDir: path.join(
        rootDir,
        ".openclaw",
        "workspace-templates",
      ),
      openclawBin: "openclaw",
      openclawLaunchdLabel: null,
      litellmBaseUrl: null,
      litellmApiKey: null,
      openclawGatewayPort: 18789,
      openclawGatewayToken: undefined,
      manageOpenclawProcess: false,
      gatewayProbeEnabled: false,
      runtimeSyncIntervalMs: 2000,
      runtimeHealthIntervalMs: 5000,
      defaultModelId: "link/gpt-5.4-mini",
      amplitudeApiKey: undefined,
      clawHubRegistry: "https://cn.clawhub-mirror.com",
      clawHubSearchApi: "https://skills.volces.com",
    };
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("migrates legacy AGENTS.md startup instructions without overwriting custom files", async () => {
    await mkdir(env.platformTemplatesDir!, { recursive: true });
    await writeFile(
      path.join(env.platformTemplatesDir!, "AGENTS.md"),
      legacyAgents,
      "utf8",
    );

    const workspaceDir = path.join(env.openclawStateDir, "agents", "bot-1");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(path.join(workspaceDir, "AGENTS.md"), legacyAgents, "utf8");
    await writeFile(path.join(workspaceDir, "SOUL.md"), "custom soul", "utf8");

    await new WorkspaceTemplateWriter(env).write([
      { id: "bot-1", status: "active" },
    ]);

    const migratedAgents = await readFile(
      path.join(workspaceDir, "AGENTS.md"),
      "utf8",
    );
    expect(migratedAgents).toContain("Keep startup lightweight");
    expect(migratedAgents).not.toContain("Before doing anything else:");
    expect(await readFile(path.join(workspaceDir, "SOUL.md"), "utf8")).toBe(
      "custom soul",
    );
  });
});
