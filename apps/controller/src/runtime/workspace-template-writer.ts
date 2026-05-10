import { existsSync } from "node:fs";
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ControllerEnv } from "../app/env.js";
import { logger } from "../lib/logger.js";

interface BotInfo {
  id: string;
  status: string;
}

export class WorkspaceTemplateWriter {
  constructor(private readonly env: ControllerEnv) {}

  async write(bots: BotInfo[]): Promise<void> {
    const activeBots = bots.filter((bot) => bot.status === "active");
    const sourceDir = this.env.platformTemplatesDir;

    if (!sourceDir) {
      logger.debug({}, "platformTemplatesDir not configured, skipping");
      return;
    }

    const sourceDirExists = await this.directoryExists(sourceDir);
    if (!sourceDirExists) {
      logger.warn({ sourceDir }, "platform templates directory not found");
      return;
    }

    for (const bot of activeBots) {
      await this.seedPlatformTemplates(bot.id, sourceDir);
    }
  }

  /**
   * Seed platform templates into the bot workspace. Only writes files that
   * don't already exist — never overwrites user-customized files like
   * SOUL.md, MEMORY.md, or IDENTITY.md.
   */
  private async seedPlatformTemplates(
    botId: string,
    sourceDir: string,
  ): Promise<void> {
    const workspaceDir = path.join(this.env.openclawStateDir, "agents", botId);

    await mkdir(workspaceDir, { recursive: true });

    try {
      const entries = await readdir(sourceDir, { withFileTypes: true });
      let seeded = 0;

      for (const entry of entries) {
        const sourcePath = path.join(sourceDir, entry.name);
        const targetPath = path.join(workspaceDir, entry.name);

        if (existsSync(targetPath)) {
          continue;
        }

        await cp(sourcePath, targetPath, { recursive: true });
        seeded++;
      }

      if (seeded > 0) {
        logger.debug(
          { botId, workspaceDir, seeded },
          "seeded platform templates into workspace",
        );
      }
    } catch (err) {
      logger.error(
        { botId, sourceDir, error: err instanceof Error ? err.message : err },
        "failed to seed platform templates",
      );
    }
  }

  private async directoryExists(dirPath: string): Promise<boolean> {
    try {
      const stats = await stat(dirPath);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }
}
