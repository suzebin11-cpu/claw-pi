import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncDesktopCloudConfigIfNeeded } from "#controller/store/desktop-config-sync";
import type { NexuConfigStore } from "#controller/store/nexu-config-store";

describe("syncDesktopCloudConfigIfNeeded", () => {
  let localAppData: string;
  let previousLocalAppData: string | undefined;

  beforeEach(() => {
    previousLocalAppData = process.env.LOCALAPPDATA;
    localAppData = resolve(
      tmpdir(),
      `desktop-config-sync-test-${Date.now()}-${Math.random()}`,
    );
    process.env.LOCALAPPDATA = localAppData;
  });

  afterEach(() => {
    if (previousLocalAppData === undefined) {
      process.env.LOCALAPPDATA = undefined;
    } else {
      process.env.LOCALAPPDATA = previousLocalAppData;
    }
    rmSync(localAppData, { recursive: true, force: true });
  });

  function writeDesktopConfig(value: unknown): void {
    const configDir = resolve(localAppData, "claw-pi-desktop", ".claw-pi");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      resolve(configDir, "config.json"),
      JSON.stringify(value),
      "utf8",
    );
  }

  it("imports valid desktop cloud credentials", async () => {
    writeDesktopConfig({
      desktop: {
        cloud: {
          connected: true,
          polling: false,
          apiKey: "desktop-key",
          linkUrl: "https://cloud.example",
          models: [{ id: "model-1", name: "Model 1" }],
        },
      },
    });
    const importState = vi.fn().mockResolvedValue(true);
    const configStore = {
      importDesktopCloudStateIfNeeded: importState,
    } as unknown as NexuConfigStore;

    await syncDesktopCloudConfigIfNeeded(configStore);

    expect(importState).toHaveBeenCalledWith(
      expect.objectContaining({
        connected: true,
        apiKey: "desktop-key",
        linkUrl: "https://cloud.example",
        models: [{ id: "model-1", name: "Model 1" }],
      }),
    );
  });

  it("does not import incomplete desktop cloud state", async () => {
    writeDesktopConfig({
      desktop: { cloud: { connected: true, apiKey: "" } },
    });
    const importState = vi.fn();
    const configStore = {
      importDesktopCloudStateIfNeeded: importState,
    } as unknown as NexuConfigStore;

    await syncDesktopCloudConfigIfNeeded(configStore);

    expect(importState).not.toHaveBeenCalled();
  });

  it("keeps existing controller credentials", async () => {
    writeDesktopConfig({
      desktop: {
        cloud: { connected: true, apiKey: "desktop-key" },
      },
    });
    const importState = vi.fn().mockResolvedValue(false);
    const configStore = {
      importDesktopCloudStateIfNeeded: importState,
    } as unknown as NexuConfigStore;

    await syncDesktopCloudConfigIfNeeded(configStore);

    expect(importState).toHaveBeenCalledOnce();
  });
});
