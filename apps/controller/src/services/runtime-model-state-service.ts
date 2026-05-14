import { readFile } from "node:fs/promises";
import type { ControllerEnv } from "../app/env.js";

type RuntimeModelState = {
  selectedModelRef?: string;
};

export class RuntimeModelStateService {
  constructor(private readonly env: ControllerEnv) {}

  async getEffectiveModelId(): Promise<string | null> {
    try {
      const raw = await readFile(
        this.env.openclawRuntimeModelStatePath,
        "utf8",
      );
      const parsed = JSON.parse(raw) as RuntimeModelState;
      return typeof parsed.selectedModelRef === "string" &&
        parsed.selectedModelRef.length > 0
        ? parsed.selectedModelRef
        : null;
    } catch {
      return null;
    }
  }

  async waitForEffectiveModelId(
    expectedModelId: string,
    opts?: { timeoutMs?: number; intervalMs?: number },
  ): Promise<{ ok: boolean; modelId: string | null }> {
    const timeoutMs = opts?.timeoutMs ?? 5000;
    const intervalMs = opts?.intervalMs ?? 150;
    const deadline = Date.now() + timeoutMs;
    let current = await this.getEffectiveModelId();

    while (current !== expectedModelId && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      current = await this.getEffectiveModelId();
    }

    return { ok: current === expectedModelId, modelId: current };
  }
}
