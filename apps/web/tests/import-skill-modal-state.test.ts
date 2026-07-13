import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAutoCloseController,
  getSelectedZipFile,
} from "../src/components/skills/import-skill-modal-state";

describe("getSelectedZipFile", () => {
  it("keeps valid zip files", () => {
    const file = { name: "skill.zip" };

    expect(getSelectedZipFile(file)).toBe(file);
  });

  it("clears the selection for invalid files", () => {
    expect(getSelectedZipFile({ name: "skill.txt" })).toBeNull();
  });
});

describe("createAutoCloseController", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("cancels a scheduled close", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const controller = createAutoCloseController();

    controller.schedule(onClose, 1200);
    controller.cancel();
    vi.advanceTimersByTime(1200);

    expect(onClose).not.toHaveBeenCalled();
  });

  it("replaces an older scheduled close with the latest one", () => {
    vi.useFakeTimers();
    const firstClose = vi.fn();
    const secondClose = vi.fn();
    const controller = createAutoCloseController();

    controller.schedule(firstClose, 1200);
    vi.advanceTimersByTime(600);
    controller.schedule(secondClose, 1200);
    vi.advanceTimersByTime(600);

    expect(firstClose).not.toHaveBeenCalled();

    vi.advanceTimersByTime(600);

    expect(secondClose).toHaveBeenCalledTimes(1);
  });
});
