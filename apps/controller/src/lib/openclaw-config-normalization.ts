import { createHash } from "node:crypto";
import type { OpenClawConfig } from "@nexu/shared";

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * OpenClaw 2026.4.x ships xai as an enabled-by-default built-in plugin. Keep
 * that implicit default explicit in controller-owned config so OpenClaw's
 * plugin activation normalization cannot create an add/remove feedback loop.
 */
function normalizeBuiltInPluginDefaults(config: JsonObject): void {
  const plugins = isRecord(config.plugins) ? config.plugins : {};
  const entries = isRecord(plugins.entries) ? plugins.entries : {};
  const xai = isRecord(entries.xai) ? entries.xai : {};
  entries.xai = { ...xai, enabled: xai.enabled !== false };
  plugins.entries = entries;

  if (Array.isArray(plugins.allow) && !plugins.allow.includes("xai")) {
    plugins.allow = [...plugins.allow, "xai"];
  }
  config.plugins = plugins;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (!isRecord(value)) {
    return value;
  }

  const result: JsonObject = {};
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    if (child !== undefined) {
      result[key] = canonicalize(child);
    }
  }
  return result;
}

export function normalizeOpenClawConfig(
  config: OpenClawConfig,
): OpenClawConfig {
  const cloned = structuredClone(config) as JsonObject;
  normalizeBuiltInPluginDefaults(cloned);
  return canonicalize(cloned) as OpenClawConfig;
}

export function stableOpenClawConfigJson(config: OpenClawConfig): string {
  return JSON.stringify(normalizeOpenClawConfig(config));
}

export function openClawConfigRevision(config: OpenClawConfig): string {
  return createHash("sha256")
    .update(stableOpenClawConfigJson(config))
    .digest("hex");
}

export function diffOpenClawConfigPaths(
  previous: unknown,
  next: unknown,
  prefix = "",
): string[] {
  if (Object.is(previous, next)) {
    return [];
  }
  if (isRecord(previous) && isRecord(next)) {
    const paths: string[] = [];
    const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
    for (const key of [...keys].sort()) {
      paths.push(
        ...diffOpenClawConfigPaths(
          previous[key],
          next[key],
          prefix ? `${prefix}.${key}` : key,
        ),
      );
    }
    return paths;
  }
  if (
    Array.isArray(previous) &&
    Array.isArray(next) &&
    JSON.stringify(previous) === JSON.stringify(next)
  ) {
    return [];
  }
  return [prefix || "<root>"];
}
