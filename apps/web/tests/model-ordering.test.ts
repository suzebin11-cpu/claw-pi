import { describe, expect, it } from "vitest";
import { isModelSelected, sortSelectedFirst } from "../src/pages/models";

describe("model ordering", () => {
  it("moves the current model to the front without changing other order", () => {
    const models = [
      { id: "link/gemini-3.1-pro" },
      { id: "link/claude-sonnet-4.6" },
      { id: "link/gpt-5.4-mini" },
      { id: "link/gpt-5.5" },
    ];

    const ordered = sortSelectedFirst(models, (model) =>
      isModelSelected(model.id, "link/gpt-5.4-mini"),
    );

    expect(ordered.map((model) => model.id)).toEqual([
      "link/gpt-5.4-mini",
      "link/gemini-3.1-pro",
      "link/claude-sonnet-4.6",
      "link/gpt-5.5",
    ]);
  });

  it("matches scoped and unscoped ids for the same model", () => {
    expect(isModelSelected("gpt-5.4-mini", "link/gpt-5.4-mini")).toBe(true);
    expect(isModelSelected("link/gpt-5.4-mini", "gpt-5.4-mini")).toBe(true);
    expect(isModelSelected("link/gpt-5.5", "link/gpt-5.4-mini")).toBe(false);
  });
});
