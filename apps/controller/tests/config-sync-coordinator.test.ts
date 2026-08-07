import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "@nexu/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ControllerEnv } from "../src/app/env.js";
import {
  diffOpenClawConfigPaths,
  openClawConfigRevision,
} from "../src/lib/openclaw-config-normalization.js";
import { OpenClawConfigWriter } from "../src/runtime/openclaw-config-writer.js";
import { ConfigSyncCoordinator } from "../src/services/config-sync-coordinator.js";

function makeConfig(overrides: Partial<OpenClawConfig> = {}): OpenClawConfig {
  return {
    gateway: {
      port: 18789,
      mode: "local",
      bind: "127.0.0.1",
      reload: { mode: "hybrid" },
    },
    agents: { list: [], defaults: {} },
    channels: {},
    bindings: [],
    models: { providers: {} },
    plugins: {
      load: { paths: [] },
      entries: { xai: { enabled: true } },
    },
    skills: { load: { watch: true } },
    commands: { native: "auto" },
    ...overrides,
  } as OpenClawConfig;
}

class FakeWsClient {
  connected = true;
  lastClose: { code: number; reason: string; at: number } | null = null;
  disconnected = new Set<() => void>();

  isConnected(): boolean {
    return this.connected;
  }

  onDisconnected(listener: () => void): () => void {
    this.disconnected.add(listener);
    return () => this.disconnected.delete(listener);
  }

  emitRestart(): void {
    this.connected = false;
    this.lastClose = { code: 1012, reason: "service restart", at: Date.now() };
    for (const listener of this.disconnected) listener();
  }

  emitReady(): void {
    this.connected = true;
    this.lastClose = null;
  }
}

function createGatewayService(writer: OpenClawConfigWriter) {
  return {
    noteConfigWritten: () => undefined,
    planConfigChange: async (
      previous: OpenClawConfig | null,
      next: OpenClawConfig,
    ) => {
      const changedPaths = previous
        ? diffOpenClawConfigPaths(previous, next)
        : ["<root>"];
      const restartRequiredPaths = changedPaths.filter((item) =>
        item.startsWith("plugins"),
      );
      const hotReloadPaths = changedPaths.filter((item) =>
        item.startsWith("models"),
      );
      return {
        changedPaths,
        hotReloadPaths,
        restartRequiredPaths,
        noopPaths: changedPaths.filter(
          (item) =>
            !restartRequiredPaths.includes(item) &&
            !hotReloadPaths.includes(item),
        ),
        restartRequired: restartRequiredPaths.length > 0,
        configRevision: openClawConfigRevision(next),
      };
    },
    writer,
  };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("ConfigSyncCoordinator", () => {
  let rootDir: string;
  let env: ControllerEnv;
  let writer: OpenClawConfigWriter;
  let ws: FakeWsClient;
  let coordinator: ConfigSyncCoordinator;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-config-coordinator-"));
    env = {
      openclawStateDir: path.join(rootDir, ".openclaw"),
      openclawConfigPath: path.join(rootDir, ".openclaw", "openclaw.json"),
    } as ControllerEnv;
    writer = new OpenClawConfigWriter(env);
    ws = new FakeWsClient();
    coordinator = new ConfigSyncCoordinator(
      env,
      writer,
      createGatewayService(writer) as never,
      ws as never,
      { probe: async () => ({ ok: true, status: 200 }) } as never,
      {
        pollIntervalMs: 5,
        restartObserveTimeoutMs: 1000,
        gatewayReadyTimeoutMs: 1000,
      },
    );
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("defers a plugin restart until the active Agent Chat completes", async () => {
    const original = makeConfig();
    const candidate = makeConfig({
      plugins: {
        load: { paths: [] },
        entries: { xai: { enabled: true }, testPlugin: { enabled: true } },
      },
    });
    await writer.write(original);
    const before = await stat(env.openclawConfigPath);
    const lease = await coordinator.beginAgentChat("run-1");
    await lease.markSubmitted();

    await coordinator.submitConfig(candidate);

    expect(coordinator.snapshot()).toMatchObject({
      state: "RESTART_PENDING",
      activeAgentStreams: 1,
      acceptingNewChats: true,
    });
    expect((await stat(env.openclawConfigPath)).mtimeMs).toBe(before.mtimeMs);

    await lease.release("completed");
    await waitFor(async () => {
      const written = JSON.parse(
        await readFile(env.openclawConfigPath, "utf8"),
      );
      return written.plugins.entries.testPlugin?.enabled === true;
    });
    ws.emitRestart();
    ws.emitReady();
    await waitFor(() => coordinator.snapshot().state === "READY");
    expect(coordinator.snapshot().activeAgentStreams).toBe(0);
  });

  it("coalesces multiple pending syncs to the latest revision and one restart", async () => {
    await writer.write(makeConfig());
    const lease = await coordinator.beginAgentChat("run-2");
    await lease.markSubmitted();
    const first = makeConfig({
      plugins: {
        load: { paths: [] },
        entries: { xai: { enabled: true }, first: { enabled: true } },
      },
    });
    const latest = makeConfig({
      plugins: {
        load: { paths: [] },
        entries: { xai: { enabled: true }, latest: { enabled: true } },
      },
      models: { providers: { link: { models: [{ id: "new", name: "new" }] } } },
    });
    await coordinator.submitConfig(first);
    await coordinator.submitConfig(latest);
    expect(coordinator.snapshot().pendingRevision).toBe(
      openClawConfigRevision(latest),
    );

    await lease.release("completed");
    await waitFor(async () => {
      const written = JSON.parse(
        await readFile(env.openclawConfigPath, "utf8"),
      );
      return written.plugins.entries.latest?.enabled === true;
    });
    ws.emitRestart();
    ws.emitReady();
    await waitFor(() => coordinator.snapshot().state === "READY");
    const written = JSON.parse(await readFile(env.openclawConfigPath, "utf8"));
    expect(written.plugins.entries.first).toBeUndefined();
    expect(written.models.providers.link.models[0].id).toBe("new");
  });

  it("atomically closes admission before applying an idle restart", async () => {
    await writer.write(makeConfig());
    const candidate = makeConfig({
      plugins: {
        load: { paths: [] },
        entries: { xai: { enabled: true }, update: { enabled: true } },
      },
    });
    await coordinator.submitConfig(candidate);
    await expect(coordinator.beginAgentChat("late-run")).rejects.toThrow(
      "Gateway 正在安全应用配置更新",
    );
    await waitFor(async () => {
      const written = JSON.parse(
        await readFile(env.openclawConfigPath, "utf8"),
      );
      return written.plugins.entries.update?.enabled === true;
    });
    ws.emitRestart();
    ws.emitReady();
    await waitFor(() => coordinator.snapshot().state === "READY");
  });

  it("applies models.providers.link.models as hot reload without restart", async () => {
    await writer.write(makeConfig());
    const candidate = makeConfig({
      models: { providers: { link: { models: [{ id: "hot", name: "hot" }] } } },
    });
    const result = await coordinator.submitConfig(candidate);
    expect(result).toMatchObject({ applied: true, deferred: false });
    expect(coordinator.snapshot()).toMatchObject({
      state: "RUNNING",
      acceptingNewChats: true,
    });
    expect(ws.lastClose).toBeNull();
  });

  it("recovers a persisted pending config before Gateway startup", async () => {
    await writer.write(makeConfig());
    const lease = await coordinator.beginAgentChat("run-crash");
    await lease.markSubmitted();
    const candidate = makeConfig({
      plugins: {
        load: { paths: [] },
        entries: { xai: { enabled: true }, recovered: { enabled: true } },
      },
    });
    await coordinator.submitConfig(candidate);

    const restartedWriter = new OpenClawConfigWriter(env);
    const restartedCoordinator = new ConfigSyncCoordinator(
      env,
      restartedWriter,
      createGatewayService(restartedWriter) as never,
      ws as never,
      { probe: async () => ({ ok: true, status: 200 }) } as never,
    );
    await expect(
      restartedCoordinator.recoverPendingBeforeGatewayStart(),
    ).resolves.toBe(true);
    const written = JSON.parse(await readFile(env.openclawConfigPath, "utf8"));
    expect(written.plugins.entries.recovered.enabled).toBe(true);
    await expect(
      access(path.join(env.openclawStateDir, "claw-pi-config-pending.json")),
    ).rejects.toThrow();
  });

  it("rolls back and retains pending state when Gateway restart fails", async () => {
    const original = makeConfig();
    await writer.write(original);
    const failing = new ConfigSyncCoordinator(
      env,
      writer,
      createGatewayService(writer) as never,
      ws as never,
      { probe: async () => ({ ok: false, status: 503 }) } as never,
      {
        pollIntervalMs: 5,
        restartObserveTimeoutMs: 30,
        gatewayReadyTimeoutMs: 30,
      },
    );
    await failing.submitConfig(
      makeConfig({
        plugins: {
          load: { paths: [] },
          entries: { xai: { enabled: true }, broken: { enabled: true } },
        },
      }),
    );
    await waitFor(
      () =>
        failing.snapshot().restartDeferredReason ===
        "restart_failed_pending_retained",
    );
    expect(failing.snapshot()).toMatchObject({
      state: "RESTART_PENDING",
      acceptingNewChats: true,
    });
    const written = JSON.parse(await readFile(env.openclawConfigPath, "utf8"));
    expect(written.plugins.entries.broken).toBeUndefined();
    await expect(
      access(path.join(env.openclawStateDir, "claw-pi-config-pending.json")),
    ).resolves.toBeUndefined();
  });
});
