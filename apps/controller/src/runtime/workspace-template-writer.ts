import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { ControllerEnv } from "../app/env.js";
import { logger } from "../lib/logger.js";

interface BotInfo {
  id: string;
  status: string;
}

const DEFAULT_AGENT_ID = "main";

const LEGACY_AGENTS_EVERY_SESSION_BLOCK = `Before doing anything else:

1. Read \`SOUL.md\` — this is who you are
2. Read \`USER.md\` — this is who you're helping
3. Read \`memory/YYYY-MM-DD.md\` (today + yesterday) for recent context
4. **If in MAIN SESSION** (direct chat with your human): Also read \`MEMORY.md\`

Don't ask permission. Just do it.`;

const LIGHTWEIGHT_AGENTS_EVERY_SESSION_BLOCK = `Keep startup lightweight. Before answering, do **not** blindly read memory files.

Use these files only when the current request needs identity, user preferences,
recent context, or long-term memory:

- \`SOUL.md\` — who you are
- \`USER.md\` — who you're helping
- \`memory/YYYY-MM-DD.md\` — recent context
- \`MEMORY.md\` — long-term memory, main sessions only`;

const TASK_EXECUTION_BLOCK = `## Claw Pi Task Execution

- For desktop, file, browser, app, image, or local-machine tasks, actually use the available tools. A plan or status sentence is not a final answer.
- Continue until the task has a concrete result, a produced artifact/path/link, or a real blocker with the exact missing input.
- Treat read, search, extract, summarize, and analyze requests as read-only by default. Do not create, save, export, or modify files unless the user explicitly asks for that.
- If the user provides uploaded attachment paths, read those exact paths first. Do not ignore them and search the desktop for same-named files.
- If a model or API error says quota, balance, credits, or billing is insufficient, reply exactly: \`余额不足，请及时充值\``;

export class WorkspaceTemplateWriter {
  constructor(private readonly env: ControllerEnv) {}

  async write(bots: BotInfo[]): Promise<void> {
    const activeBots = bots.filter((bot) => bot.status === "active");
    const targetBotIds = new Set([
      DEFAULT_AGENT_ID,
      ...activeBots.map((bot) => bot.id).filter(Boolean),
    ]);
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

    for (const botId of targetBotIds) {
      await this.seedPlatformTemplates(botId, sourceDir);
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
          if (entry.name === "AGENTS.md") {
            await this.migrateLegacyAgentsTemplate(targetPath, botId);
            await this.ensureTaskExecutionBlock(targetPath, botId);
          }
          continue;
        }

        await cp(sourcePath, targetPath, { recursive: true });
        if (entry.name === "AGENTS.md") {
          await this.migrateLegacyAgentsTemplate(targetPath, botId);
          await this.ensureTaskExecutionBlock(targetPath, botId);
        }
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

  private async migrateLegacyAgentsTemplate(
    targetPath: string,
    botId: string,
  ): Promise<void> {
    try {
      const content = await readFile(targetPath, "utf8");
      if (!content.includes(LEGACY_AGENTS_EVERY_SESSION_BLOCK)) {
        return;
      }

      const nextContent = content.replace(
        LEGACY_AGENTS_EVERY_SESSION_BLOCK,
        LIGHTWEIGHT_AGENTS_EVERY_SESSION_BLOCK,
      );
      if (nextContent === content) {
        return;
      }

      await writeFile(targetPath, nextContent, "utf8");
      logger.info(
        { botId, targetPath },
        "migrated legacy AGENTS.md startup instructions",
      );
    } catch (err) {
      logger.warn(
        { botId, targetPath, error: err instanceof Error ? err.message : err },
        "failed to migrate legacy AGENTS.md startup instructions",
      );
    }
  }

  private async ensureTaskExecutionBlock(
    targetPath: string,
    botId: string,
  ): Promise<void> {
    try {
      const content = await readFile(targetPath, "utf8");
      if (content.includes("## Claw Pi Task Execution")) {
        return;
      }

      const nextContent = `${content.trimEnd()}\n\n${TASK_EXECUTION_BLOCK}\n`;
      await writeFile(targetPath, nextContent, "utf8");
      logger.info(
        { botId, targetPath },
        "added task execution instructions to AGENTS.md",
      );
    } catch (err) {
      logger.warn(
        { botId, targetPath, error: err instanceof Error ? err.message : err },
        "failed to add task execution instructions to AGENTS.md",
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
