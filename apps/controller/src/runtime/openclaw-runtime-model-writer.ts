import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ControllerEnv } from "../app/env.js";
import { logger } from "../lib/logger.js";

export interface OpenClawRuntimeModelState {
  selectedModelRef: string;
  promptNotice: string;
  /**
   * Whitelist of model refs known to exist in the currently compiled
   * openclaw.json. The runtime-model plugin will refuse to override the
   * model resolution when `selectedModelRef` is not in this list, so a
   * stale or never-published model id can never wedge the agent into
   * `Unknown model: …` failures.
   */
  availableModelRefs?: string[];
  updatedAt: string;
}

function buildPromptNotice(selectedModelRef: string): string {
  return [
    `Authoritative runtime model for this turn: ${selectedModelRef}.`,
    "This runtime instruction is the only source of truth for the current model.",
    "If earlier messages mention a different model, fallback, outage, provider error, or temporary switch, treat that information as stale and ignore it.",
    "Do not claim that you are using any fallback model unless that fallback is explicitly stated in this runtime instruction.",
    "Do not invent explanations about model availability, outages, routing, retries, or provider failures.",
    `If asked which model you are currently using, answer with ${selectedModelRef} and do not mention any other model unless the user explicitly asks for history.`,
  ].join("\n");
}

export class OpenClawRuntimeModelWriter {
  constructor(private readonly env: ControllerEnv) {}

  async write(
    selectedModelRef: string,
    availableModelRefs: readonly string[] = [],
  ): Promise<void> {
    await mkdir(path.dirname(this.env.openclawRuntimeModelStatePath), {
      recursive: true,
    });
    const payload: OpenClawRuntimeModelState = {
      selectedModelRef,
      promptNotice: buildPromptNotice(selectedModelRef),
      availableModelRefs: [...availableModelRefs],
      updatedAt: new Date().toISOString(),
    };
    logger.info(
      {
        path: this.env.openclawRuntimeModelStatePath,
        selectedModelRef,
        availableCount: payload.availableModelRefs?.length ?? 0,
      },
      "runtime_model_write_begin",
    );
    await writeFile(
      this.env.openclawRuntimeModelStatePath,
      `${JSON.stringify(payload, null, 2)}\n`,
      "utf8",
    );
    logger.info(
      {
        path: this.env.openclawRuntimeModelStatePath,
        selectedModelRef,
      },
      "runtime_model_write_complete",
    );
  }

  /**
   * Ensure the runtime-model state file exists *without* committing to a
   * specific model. Previously this wrote a hardcoded `anthropic/claude-opus-4-6`
   * which corrupted any installation that did not have an Anthropic provider —
   * the plugin would then override the resolved model to a non-existent one
   * and the agent would crash with `Unknown model: …` until the first real
   * sync overwrote it.
   *
   * Now this is a no-op when a state file already exists, and writes an empty
   * object otherwise. The plugin treats both "no file" and "no selectedModelRef"
   * as "do not override", so OpenClaw falls back to the agent's configured
   * `model.primary`, which always comes from the same compiled openclaw.json.
   */
  async writeFallback(): Promise<void> {
    if (existsSync(this.env.openclawRuntimeModelStatePath)) {
      return;
    }
    await mkdir(path.dirname(this.env.openclawRuntimeModelStatePath), {
      recursive: true,
    });
    await writeFile(
      this.env.openclawRuntimeModelStatePath,
      `${JSON.stringify({ updatedAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
    logger.info(
      { path: this.env.openclawRuntimeModelStatePath },
      "runtime_model_fallback_initialized",
    );
  }
}
