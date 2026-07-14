import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { logger } from "../lib/logger.js";
import type { NexuConfigStore } from "./nexu-config-store.js";

type ImportedDesktopCloudState = {
  connected: true;
  polling: boolean;
  userName?: string | null;
  userEmail?: string | null;
  connectedAt?: string | null;
  linkUrl?: string | null;
  apiKey: string;
  models?: Array<{ id: string; name: string; provider?: string }>;
};

function getDesktopAppConfigPath(): string {
  const localAppData =
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "claw-pi-desktop", ".claw-pi", "config.json");
}

function readOptionalString(value: unknown): string | null | undefined {
  return typeof value === "string" || value === null ? value : undefined;
}

function readDesktopCloudState(
  input: unknown,
): ImportedDesktopCloudState | null {
  if (typeof input !== "object" || input === null) {
    return null;
  }

  const desktop = (input as Record<string, unknown>).desktop;
  if (typeof desktop !== "object" || desktop === null) {
    return null;
  }

  const cloud = (desktop as Record<string, unknown>).cloud;
  if (typeof cloud !== "object" || cloud === null) {
    return null;
  }

  const record = cloud as Record<string, unknown>;
  if (
    record.connected !== true ||
    typeof record.apiKey !== "string" ||
    record.apiKey.length === 0
  ) {
    return null;
  }

  const models = Array.isArray(record.models)
    ? record.models.flatMap((model) => {
        if (typeof model !== "object" || model === null) {
          return [];
        }
        const candidate = model as Record<string, unknown>;
        if (
          typeof candidate.id !== "string" ||
          typeof candidate.name !== "string"
        ) {
          return [];
        }
        return [
          {
            id: candidate.id,
            name: candidate.name,
            ...(typeof candidate.provider === "string"
              ? { provider: candidate.provider }
              : {}),
          },
        ];
      })
    : undefined;

  return {
    connected: true,
    polling: record.polling === true,
    userName: readOptionalString(record.userName),
    userEmail: readOptionalString(record.userEmail),
    connectedAt: readOptionalString(record.connectedAt),
    linkUrl: readOptionalString(record.linkUrl),
    apiKey: record.apiKey,
    ...(models ? { models } : {}),
  };
}

export async function syncDesktopCloudConfigIfNeeded(
  configStore: NexuConfigStore,
): Promise<void> {
  try {
    const desktopConfigPath = getDesktopAppConfigPath();
    if (!existsSync(desktopConfigPath)) {
      logger.debug({ path: desktopConfigPath }, "desktop_app_config_not_found");
      return;
    }

    const desktopConfigContent = await readFile(desktopConfigPath, "utf-8");
    const desktopCloud = readDesktopCloudState(
      JSON.parse(desktopConfigContent) as unknown,
    );

    if (!desktopCloud) {
      logger.debug({}, "desktop_app_cloud_not_configured");
      return;
    }

    const imported =
      await configStore.importDesktopCloudStateIfNeeded(desktopCloud);
    if (!imported) {
      logger.debug({}, "controller_cloud_already_configured");
      return;
    }

    logger.info(
      {
        linkUrl: desktopCloud.linkUrl,
        userName: desktopCloud.userName,
        connectedAt: desktopCloud.connectedAt,
      },
      "desktop_cloud_config_synced_from_app",
    );
  } catch (error) {
    logger.warn(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      "desktop_cloud_config_sync_failed",
    );
  }
}
