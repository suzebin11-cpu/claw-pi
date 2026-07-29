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
});
