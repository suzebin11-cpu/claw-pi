# 修复：Controller 配置同步问题

## 问题描述

用户首次启动桌面应用并连接云服务后，如果直接使用开发模式的 Controller（`npm run dev:controller`），会遇到"无法连接 Claw-Pi Controller"错误，因为：

1. **桌面应用配置路径**：`AppData\Local\claw-pi-desktop\.claw-pi\config.json`
2. **开发 Controller 配置路径**：`~/.nexu/config.json`
3. 两者不共享配置，导致 Controller 没有云服务 API 密钥

## 解决方案

### 方案1：Controller 启动时同步配置（推荐）

在 Controller 启动时检测桌面应用配置，如果发现云服务已连接但自己的配置未连接，则自动同步。

**实现位置**：`apps/controller/src/index.ts` 或 `apps/controller/src/store/nexu-config-store.ts`

```typescript
async function syncDesktopConfigIfNeeded(configStore: NexuConfigStore) {
  const config = await configStore.getConfig();
  const controllerCloud = config.desktop?.cloud;
  
  // 如果 Controller 已连接，无需同步
  if (controllerCloud?.connected && controllerCloud?.apiKey) {
    return;
  }
  
  // 检查桌面应用配置
  const desktopConfigPath = path.join(
    process.env.LOCALAPPDATA || "",
    "claw-pi-desktop",
    ".claw-pi",
    "config.json"
  );
  
  if (!existsSync(desktopConfigPath)) {
    return;
  }
  
  try {
    const desktopConfig = JSON.parse(
      await readFile(desktopConfigPath, "utf-8")
    );
    const desktopCloud = desktopConfig.desktop?.cloud;
    
    // 如果桌面应用已连接，同步到 Controller
    if (desktopCloud?.connected && desktopCloud?.apiKey) {
      await configStore.store.update((current) => ({
        ...current,
        desktop: {
          ...current.desktop,
          cloud: {
            ...desktopCloud,
          },
        },
      }));
      
      logger.info(
        {
          linkUrl: desktopCloud.linkUrl,
          userName: desktopCloud.userName,
        },
        "desktop_cloud_config_synced_from_app"
      );
    }
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "desktop_cloud_config_sync_failed"
    );
  }
}

// 在 Controller 启动时调用
await syncDesktopConfigIfNeeded(configStore);
```

### 方案2：统一配置目录

修改开发模式下 Controller 使用的配置路径，与桌面应用保持一致。

**实现位置**：`apps/controller/src/app/env.ts`

```typescript
// 当前实现
NEXU_HOME: z.string().default("~/.nexu"),

// 修改为：检测桌面应用配置目录
NEXU_HOME: z.string().default(() => {
  // 优先使用环境变量
  if (process.env.NEXU_HOME) {
    return process.env.NEXU_HOME;
  }
  
  // 如果桌面应用配置存在，使用它
  const desktopConfigDir = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
    "claw-pi-desktop",
    ".claw-pi"
  );
  
  if (existsSync(desktopConfigDir)) {
    return desktopConfigDir;
  }
  
  // 否则使用默认路径
  return path.join(os.homedir(), ".nexu");
}),
```

**优点**：
- 配置自动共享
- 无需同步逻辑
- 用户体验无感知

**缺点**：
- 修改了默认行为
- 可能影响纯 Controller 模式的用户

### 方案3：环境变量配置

让桌面应用启动 Controller 时传递正确的 `NEXU_HOME` 环境变量。

**实现位置**：`apps/desktop/main/services/embedded-web-server.ts` 或启动 Controller 的地方

```typescript
// 启动 Controller 进程时
const controllerProcess = spawn("node", ["controller/index.js"], {
  env: {
    ...process.env,
    NEXU_HOME: getDesktopNexuHomeDir(app.getPath("userData")),
  },
});
```

### 方案4：配置文件符号链接（仅限开发）

为开发者提供一个脚本，创建符号链接连接两个配置目录。

```bash
# scripts/link-desktop-config.sh
DESKTOP_CONFIG="$LOCALAPPDATA/claw-pi-desktop/.claw-pi"
CONTROLLER_CONFIG="$HOME/.nexu"

if [ -d "$DESKTOP_CONFIG" ] && [ ! -L "$CONTROLLER_CONFIG" ]; then
  ln -s "$DESKTOP_CONFIG" "$CONTROLLER_CONFIG"
  echo "✅ Linked desktop config to controller"
fi
```

## 推荐实施方案

**阶段1：立即修复（方案1）**
- 在 Controller 启动时自动检测并同步桌面应用配置
- 影响范围小，仅在需要时触发
- 添加日志记录，便于追踪

**阶段2：长期优化（方案2）**
- 统一配置目录逻辑
- 确保所有模式下配置一致
- 提供环境变量覆盖机制

## 实施步骤

### Step 1: 创建同步函数

```typescript
// apps/controller/src/store/desktop-config-sync.ts
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { logger } from "../lib/logger.js";
import type { NexuConfigStore } from "./nexu-config-store.js";

function getDesktopAppConfigPath(): string {
  const localAppData =
    process.env.LOCALAPPDATA ||
    path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "claw-pi-desktop", ".claw-pi", "config.json");
}

export async function syncDesktopCloudConfigIfNeeded(
  configStore: NexuConfigStore
): Promise<void> {
  try {
    const config = await configStore.getConfig();
    const controllerCloud = config.desktop?.cloud;

    // 已连接，无需同步
    if (controllerCloud?.connected && controllerCloud?.apiKey) {
      logger.debug("controller_cloud_already_configured");
      return;
    }

    const desktopConfigPath = getDesktopAppConfigPath();
    if (!existsSync(desktopConfigPath)) {
      logger.debug(
        { path: desktopConfigPath },
        "desktop_app_config_not_found"
      );
      return;
    }

    const desktopConfigContent = await readFile(desktopConfigPath, "utf-8");
    const desktopConfig = JSON.parse(desktopConfigContent);
    const desktopCloud = desktopConfig.desktop?.cloud;

    if (!desktopCloud?.connected || !desktopCloud?.apiKey) {
      logger.debug("desktop_app_cloud_not_configured");
      return;
    }

    // 同步配置
    await configStore.store.update((current) => ({
      ...current,
      desktop: {
        ...current.desktop,
        cloud: desktopCloud,
      },
    }));

    logger.info(
      {
        linkUrl: desktopCloud.linkUrl,
        userName: desktopCloud.userName,
        connectedAt: desktopCloud.connectedAt,
      },
      "desktop_cloud_config_synced_from_app"
    );
  } catch (error) {
    logger.warn(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      "desktop_cloud_config_sync_failed"
    );
  }
}
```

### Step 2: 在 Controller 启动时调用

```typescript
// apps/controller/src/index.ts
import { syncDesktopCloudConfigIfNeeded } from "./store/desktop-config-sync.js";

// 在 Controller 初始化后
const configStore = container.configStore;
await syncDesktopCloudConfigIfNeeded(configStore);

logger.info(
  { host: env.host, port: env.port },
  "controller started"
);
```

### Step 3: 添加测试

```typescript
// tests/desktop/desktop-config-sync.test.ts
import { describe, expect, it } from "vitest";
import { syncDesktopCloudConfigIfNeeded } from "#controller/store/desktop-config-sync";

describe("Desktop Config Sync", () => {
  it("syncs cloud config from desktop app when controller not configured", async () => {
    // 测试逻辑
  });

  it("skips sync when controller already configured", async () => {
    // 测试逻辑
  });

  it("handles missing desktop config gracefully", async () => {
    // 测试逻辑
  });
});
```

## 验证

1. **清空 Controller 配置**
   ```bash
   rm ~/.nexu/config.json
   ```

2. **启动 Controller**
   ```bash
   npm run dev:controller
   ```

3. **检查日志**
   应该看到：
   ```
   desktop_cloud_config_synced_from_app
   ```

4. **测试生图**
   ```bash
   node scripts/diagnose-image-models.mjs --model gpt-image-1.5
   ```
   应该成功，不再报"云服务未连接"

## 影响范围

### 正面影响
- ✅ 首次启动体验流畅
- ✅ 开发者无需手动配置
- ✅ 桌面应用和 Controller 配置一致

### 潜在风险
- ⚠️ 可能覆盖 Controller 的手动配置（已通过检测 `connected` 状态避免）
- ⚠️ 跨平台路径处理需要测试

## 后续优化

1. **双向同步**：桌面应用配置更新时，通知 Controller 重新加载
2. **配置 UI**：在桌面应用中提供"同步到开发环境"按钮
3. **配置验证**：启动时检查配置完整性，自动修复常见问题

## 相关文档
- [生图模型兜底策略](./image-model-fallback.md)
- [生图空回复问题修复](./fix-image-generation-empty-response.md)
- [模型诊断脚本](../scripts/diagnose-image-models.mjs)
