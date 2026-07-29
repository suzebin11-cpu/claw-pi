import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MODEL_DISPLAY_ALIASES,
  isAliasDisplayId,
  resolveBackendModelId,
  resolveDisplayModelId,
  withDisplayAliasModels,
} from "#web/lib/model-display-alias";

// The module persists the user's display choice in localStorage and is
// guarded for SSR (no window). Provide a minimal in-memory window/localStorage
// so the preference-backed behavior can be exercised in the node test env.
function installBrowserStubs(): void {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  };
  vi.stubGlobal("window", {
    localStorage,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    CustomEvent: class {
      constructor(
        public type: string,
        public init?: unknown,
      ) {}
    },
  });
  vi.stubGlobal("localStorage", localStorage);
}

type Model = {
  id: string;
  name: string;
  provider: string;
  isDefault?: boolean;
};

const REAL_MODELS: Model[] = [
  { id: "link/gpt-5.4", name: "GPT-5.4", provider: "nexu" },
  { id: "link/gpt-5.5", name: "GPT-5.5", provider: "nexu", isDefault: true },
  { id: "link/claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "nexu" },
];

describe("model display alias (gpt-5.6 placeholder)", () => {
  beforeEach(() => {
    installBrowserStubs();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("declares gpt-5.6 as a display alias of gpt-5.5", () => {
    expect(MODEL_DISPLAY_ALIASES).toContainEqual({
      displayId: "link/gpt-5.6",
      displayName: "GPT-5.6",
      backingBareId: "gpt-5.5",
    });
  });

  it("adds a GPT-5.6 card in front of its gpt-5.5 backing card", () => {
    const expanded = withDisplayAliasModels(REAL_MODELS);
    const ids = expanded.map((m) => m.id);
    expect(ids).toEqual([
      "link/gpt-5.4",
      "link/gpt-5.6",
      "link/gpt-5.5",
      "link/claude-sonnet-4-6",
    ]);
    const placeholder = expanded.find((m) => m.id === "link/gpt-5.6");
    expect(placeholder?.name).toBe("GPT-5.6");
    // The placeholder never claims the default; the real backing card keeps it.
    expect(placeholder?.isDefault).toBe(false);
    expect(expanded.find((m) => m.id === "link/gpt-5.5")?.isDefault).toBe(true);
  });

  it("does not duplicate the placeholder when it already exists", () => {
    const withPlaceholder = withDisplayAliasModels(REAL_MODELS);
    const twice = withDisplayAliasModels(withPlaceholder);
    expect(twice.filter((m) => m.id === "link/gpt-5.6")).toHaveLength(1);
  });

  it("omits the placeholder when its backing model is absent", () => {
    const expanded = withDisplayAliasModels([
      { id: "link/gpt-5.4", name: "GPT-5.4", provider: "nexu" },
    ]);
    expect(expanded.some((m) => m.id === "link/gpt-5.6")).toBe(false);
  });

  it("recognizes placeholder display ids", () => {
    expect(isAliasDisplayId("link/gpt-5.6")).toBe(true);
    expect(isAliasDisplayId("gpt-5.6")).toBe(true);
    expect(isAliasDisplayId("link/gpt-5.5")).toBe(false);
  });

  it("selecting GPT-5.6 sends gpt-5.5 to the backend and is remembered", () => {
    // User picks the placeholder card.
    expect(resolveBackendModelId("link/gpt-5.6")).toBe("link/gpt-5.5");
    // The real backend model now displays as the placeholder everywhere.
    expect(resolveDisplayModelId("link/gpt-5.5")).toBe("link/gpt-5.6");
  });

  it("defaults to showing GPT-5.6 when no choice has been stored", () => {
    // Fresh install: backend default is gpt-5.5 but it presents as GPT-5.6.
    expect(resolveDisplayModelId("link/gpt-5.5")).toBe("link/gpt-5.6");
  });

  it("selecting the real GPT-5.5 card pins the real identity", () => {
    // Default shows the placeholder.
    expect(resolveDisplayModelId("link/gpt-5.5")).toBe("link/gpt-5.6");

    // Picking the real gpt-5.5 card pins the real identity (overrides default).
    expect(resolveBackendModelId("link/gpt-5.5")).toBe("link/gpt-5.5");
    expect(resolveDisplayModelId("link/gpt-5.5")).toBe("link/gpt-5.5");

    // Switching back to the placeholder card restores the GPT-5.6 identity.
    expect(resolveBackendModelId("link/gpt-5.6")).toBe("link/gpt-5.5");
    expect(resolveDisplayModelId("link/gpt-5.5")).toBe("link/gpt-5.6");
  });

  it("leaves unrelated models untouched", () => {
    expect(resolveBackendModelId("link/claude-sonnet-4-6")).toBe(
      "link/claude-sonnet-4-6",
    );
    expect(resolveDisplayModelId("link/claude-sonnet-4-6")).toBe(
      "link/claude-sonnet-4-6",
    );
  });
});
