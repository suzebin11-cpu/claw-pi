import { describe, expect, it } from "vitest";
import {
  reduceUpdateError,
  restorePhaseAfterInstall as restoreDesktopPhase,
} from "../apps/desktop/src/hooks/use-auto-update";
import { restorePhaseAfterInstall as restoreWebPhase } from "../apps/web/src/hooks/use-auto-update";

const baseDesktopState = {
  phase: "idle" as const,
  version: null,
  releaseNotes: null,
  percent: 0,
  errorMessage: null,
  dismissed: false,
  userInitiated: false,
};

describe("desktop reduceUpdateError", () => {
  it("suppresses errors from automatic/background checks", () => {
    const next = reduceUpdateError(
      { ...baseDesktopState, phase: "checking", userInitiated: false },
      "HTTP 404 fetching latest.yml",
    );
    // Background feed failures must never surface a scary banner on launch.
    expect(next.phase).toBe("idle");
    expect(next.errorMessage).toBeNull();
  });

  it("leaves a non-checking background phase untouched while clearing the error", () => {
    const next = reduceUpdateError(
      { ...baseDesktopState, phase: "downloading", userInitiated: false },
      "network blip",
    );
    expect(next.phase).toBe("downloading");
    expect(next.errorMessage).toBeNull();
  });

  it("surfaces errors the user explicitly triggered", () => {
    const next = reduceUpdateError(
      { ...baseDesktopState, phase: "checking", userInitiated: true },
      "boom",
    );
    expect(next.phase).toBe("error");
    expect(next.errorMessage).toBe("boom");
    // Consumed the user-initiated flag so later background errors stay quiet.
    expect(next.userInitiated).toBe(false);
  });
});

describe("desktop useAutoUpdate", () => {
  it("restores the prior actionable phase after install returns without quitting", () => {
    expect(
      restoreDesktopPhase(
        {
          phase: "installing",
          version: "1.2.3",
          releaseNotes: null,
          percent: 100,
          errorMessage: null,
          dismissed: false,
          userInitiated: false,
        },
        "ready",
      ).phase,
    ).toBe("ready");
  });

  it("keeps later non-installing phases intact", () => {
    expect(
      restoreDesktopPhase(
        {
          phase: "error",
          version: "1.2.3",
          releaseNotes: null,
          percent: 100,
          errorMessage: "failed",
          dismissed: false,
          userInitiated: false,
        },
        "available",
      ).phase,
    ).toBe("error");
  });
});

describe("web useAutoUpdate", () => {
  it("restores the prior actionable phase after install returns without quitting", () => {
    expect(
      restoreWebPhase(
        {
          phase: "installing",
          version: "1.2.3",
          percent: 100,
          errorMessage: null,
        },
        "ready",
      ).phase,
    ).toBe("ready");
  });

  it("keeps later phase changes intact", () => {
    expect(
      restoreWebPhase(
        {
          phase: "error",
          version: "1.2.3",
          percent: 100,
          errorMessage: "failed",
        },
        "ready",
      ).phase,
    ).toBe("error");
  });
});
