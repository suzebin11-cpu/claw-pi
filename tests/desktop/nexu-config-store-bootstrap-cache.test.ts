import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerEnv } from "#controller/app/env";
import { NexuConfigStore } from "#controller/store/nexu-config-store";

function makeTempDir(): string {
  const dir = resolve(tmpdir(), `nexu-config-cache-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createEnv(homeDir: string): ControllerEnv {
  const openclawStateDir = resolve(homeDir, "runtime", "openclaw", "state");
  return {
    nodeEnv: "test",
    port: 3010,
    host: "127.0.0.1",
    webUrl: "http://localhost:5173",
    nexuCloudUrl: "https://api.clawpi.app:9443",
    nexuLinkUrl: null,
    nexuHomeDir: homeDir,
    nexuConfigPath: resolve(homeDir, "config.json"),
    artifactsIndexPath: resolve(homeDir, "artifacts", "index.json"),
    compiledOpenclawSnapshotPath: resolve(homeDir, "compiled-openclaw.json"),
    openclawStateDir,
    openclawConfigPath: resolve(openclawStateDir, "openclaw.json"),
    openclawSkillsDir: resolve(openclawStateDir, "skills"),
    openclawExtensionsDir: resolve(openclawStateDir, "extensions"),
    runtimePluginTemplatesDir: resolve(homeDir, "runtime-plugins"),
    openclawCuratedSkillsDir: resolve(homeDir, "bundled-skills"),
    openclawRuntimeModelStatePath: resolve(
      openclawStateDir,
      "nexu-runtime-model.json",
    ),
    skillhubCacheDir: resolve(homeDir, "skillhub-cache"),
    skillDbPath: resolve(homeDir, "skill-ledger.json"),
    staticSkillsDir: undefined,
    platformTemplatesDir: undefined,
    openclawWorkspaceTemplatesDir: resolve(
      openclawStateDir,
      "workspace-templates",
    ),
    openclawBin: "openclaw",
    litellmBaseUrl: null,
    litellmApiKey: null,
    openclawGatewayPort: 18789,
    openclawGatewayToken: "",
    manageOpenclawProcess: false,
    gatewayProbeEnabled: false,
    runtimeSyncIntervalMs: 2000,
    runtimeHealthIntervalMs: 5000,
    defaultModelId: "link/gpt-5.4",
    analyticsStatePath: resolve(homeDir, "analytics-state.json"),
  };
}

function writeConfig(
  env: ControllerEnv,
  desktop: Record<string, unknown>,
  activeCloudProfileName = "Default",
) {
  writeFileSync(
    env.nexuConfigPath,
    `${JSON.stringify(
      {
        $schema: "https://api.clawpi.app:9443/config.json",
        schemaVersion: 1,
        app: {},
        bots: [],
        runtime: {
          gateway: { port: 18789, bind: "loopback", authMode: "none" },
          defaultModelId: "link/gpt-5.4",
        },
        providers: [],
        integrations: [],
        channels: [],
        templates: {},
        desktop: {
          activeCloudProfileName,
          ...desktop,
        },
        secrets: {},
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

describe("NexuConfigStore.shouldSkipCloudHydrationForBootstrap", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-11T10:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("skips bootstrap hydration when cached models match the active profile", async () => {
    const env = createEnv(tempDir);
    writeConfig(env, {
      cloud: {
        connected: true,
        polling: false,
        userName: null,
        userEmail: null,
        connectedAt: null,
        linkUrl: "https://api.clawpi.app:9443",
        apiKey: "test-key",
        models: [{ id: "gpt-5.4", name: "gpt-5.4" }],
        cacheKey:
          "default::https://api.clawpi.app:9443::https://api.clawpi.app:9443",
        modelsUpdatedAt: Date.now(),
      },
    });

    const store = new NexuConfigStore(env);

    await expect(store.shouldSkipCloudHydrationForBootstrap()).resolves.toBe(
      true,
    );
  });

  it("does not skip when the cached profile/link no longer matches", async () => {
    const env = createEnv(tempDir);
    writeConfig(env, {
      cloud: {
        connected: true,
        polling: false,
        userName: null,
        userEmail: null,
        connectedAt: null,
        linkUrl: "https://other.example",
        apiKey: "test-key",
        models: [{ id: "gpt-5.4", name: "gpt-5.4" }],
        cacheKey:
          "default::https://api.clawpi.app:9443::https://other.example",
        modelsUpdatedAt: Date.now(),
      },
    });

    const store = new NexuConfigStore(env);

    await expect(store.shouldSkipCloudHydrationForBootstrap()).resolves.toBe(
      false,
    );
  });

  it("does not skip when the cached model inventory is stale", async () => {
    const env = createEnv(tempDir);
    const oneDayAndOneMs = 24 * 60 * 60 * 1000 + 1;
    writeConfig(env, {
      cloud: {
        connected: true,
        polling: false,
        userName: null,
        userEmail: null,
        connectedAt: null,
        linkUrl: "https://api.clawpi.app:9443",
        apiKey: "test-key",
        models: [{ id: "gpt-5.4", name: "gpt-5.4" }],
        cacheKey:
          "default::https://api.clawpi.app:9443::https://api.clawpi.app:9443",
        modelsUpdatedAt: Date.now() - oneDayAndOneMs,
      },
    });

    const store = new NexuConfigStore(env);

    await expect(store.shouldSkipCloudHydrationForBootstrap()).resolves.toBe(
      false,
    );
  });
});
