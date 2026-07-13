import { describe, expect, it } from "vitest";
import {
  resolveBootGraceChannelStatus,
  shouldDelayChannelStatusTransition,
  shouldShowBootGrace,
} from "#web/lib/runtime-startup";

describe("runtime-startup helpers", () => {
  it("shows boot grace only within the controller boot window", () => {
    const bootTimestamp = 1_000;

    expect(
      shouldShowBootGrace({
        bootTimestamp,
        acknowledgedBootTimestamp: null,
        now: bootTimestamp + 10_000,
      }),
    ).toBe(true);

    expect(
      shouldShowBootGrace({
        bootTimestamp,
        acknowledgedBootTimestamp: null,
        now: bootTimestamp + 300_001,
      }),
    ).toBe(false);
  });

  it("stops showing boot grace once that boot has already reached fully online", () => {
    expect(
      shouldShowBootGrace({
        bootTimestamp: 1_000,
        acknowledgedBootTimestamp: 1_000,
        now: 5_000,
      }),
    ).toBe(false);
  });

  it("maps disconnected and undefined to connecting during boot grace only", () => {
    expect(resolveBootGraceChannelStatus("disconnected", true)).toBe(
      "connecting",
    );
    expect(resolveBootGraceChannelStatus(undefined, true)).toBe("connecting");
    expect(resolveBootGraceChannelStatus("restarting", true)).toBe(
      "restarting",
    );
    expect(resolveBootGraceChannelStatus("disconnected", false)).toBe(
      "disconnected",
    );
    expect(resolveBootGraceChannelStatus(undefined, false)).toBe(undefined);
  });

  it("applies hysteresis only for clean connected -> disconnected/restarting transitions", () => {
    expect(
      shouldDelayChannelStatusTransition("connected", "disconnected", null),
    ).toBe(true);
    expect(
      shouldDelayChannelStatusTransition("connected", "restarting", null),
    ).toBe(true);
    expect(shouldDelayChannelStatusTransition("connected", "error", null)).toBe(
      false,
    );
    expect(
      shouldDelayChannelStatusTransition(
        "connected",
        "disconnected",
        "session expired",
      ),
    ).toBe(false);
    expect(
      shouldDelayChannelStatusTransition("connecting", "disconnected", null),
    ).toBe(false);
  });
});
