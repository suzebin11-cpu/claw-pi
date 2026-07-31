import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getDesktopRuntimeConfig } from "../../apps/desktop/shared/runtime-config";

describe("desktop runtime config", () => {
  it("defaults updates to the stable channel", () => {
    const config = getDesktopRuntimeConfig({}, { useBuildConfig: false });

    expect(config.updates.channel).toBe("stable");
    expect(config.updates.autoUpdateEnabled).toBe(true);
  });

  it("accepts nightly as a packaged update channel", () => {
    const config = getDesktopRuntimeConfig(
      {
        NEXU_DESKTOP_UPDATE_CHANNEL: "nightly",
      },
      { useBuildConfig: false },
    );

    expect(config.updates.channel).toBe("nightly");
  });

  it("keeps portable builds out of the auto-update flow", () => {
    const config = getDesktopRuntimeConfig(
      {
        NEXU_DESKTOP_PORTABLE: "1",
      },
      { useBuildConfig: false },
    );

    expect(config.updates.autoUpdateEnabled).toBe(false);
  });

  it("allows packaged builds to explicitly disable auto-update", () => {
    const config = getDesktopRuntimeConfig(
      {
        NEXU_DESKTOP_AUTO_UPDATE_ENABLED: "false",
      },
      { useBuildConfig: false },
    );

    expect(config.updates.autoUpdateEnabled).toBe(false);
  });

  it("reads cloud endpoints from the runtime environment", () => {
    const config = getDesktopRuntimeConfig(
      {
        NEXU_CLOUD_URL: "https://cloud.example.com",
        NEXU_LINK_URL: "https://link.example.com",
      },
      { useBuildConfig: false },
    );

    expect(config.urls.cloudBase).toBe("https://cloud.example.com");
    expect(config.urls.linkBase).toBe("https://link.example.com");
  });

  it("reads cloud endpoints from packaged build-config.json", async () => {
    const resourcesPath = await mkdtemp(
      path.join(tmpdir(), "clawpi-runtime-config-"),
    );

    try {
      await writeFile(
        path.join(resourcesPath, "build-config.json"),
        JSON.stringify({
          NEXU_CLOUD_URL: "https://packaged-cloud.example.com",
          NEXU_LINK_URL: "https://packaged-link.example.com",
        }),
        "utf8",
      );

      const config = getDesktopRuntimeConfig(
        {},
        {
          resourcesPath,
        },
      );

      expect(config.urls.cloudBase).toBe(
        "https://packaged-cloud.example.com",
      );
      expect(config.urls.linkBase).toBe("https://packaged-link.example.com");
    } finally {
      await rm(resourcesPath, { recursive: true, force: true });
    }
  });
});
