#!/usr/bin/env node

/**
 * 生图模型健康诊断脚本
 * 用途：检测各个生图模型的可用性和响应时间
 * 使用：node scripts/diagnose-image-models.mjs [--model <model-id>] [--all]
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const MODELS_TO_TEST = [
  { id: "gpt-image-1-mini", name: "GPT Image 1 Mini", provider: "openai" },
  { id: "gpt-image-1.5", name: "GPT Image 1.5", provider: "openai" },
  { id: "gpt-image-2", name: "GPT Image 2", provider: "openai" },
  {
    id: "doubao-seedream-4-5-251128",
    name: "Doubao Seedream 4.5",
    provider: "doubao",
  },
];

const TEST_PROMPT = "a small red cube on a white background";
const TIMEOUT_MS = 60000;

async function getConfig() {
  // 尝试多个可能的配置路径
  const possiblePaths = [
    process.env.NEXU_HOME
      ? path.join(process.env.NEXU_HOME, "config.json")
      : null,
    path.join(homedir(), ".nexu", "config.json"),
    path.join(
      process.env.LOCALAPPDATA || "",
      "claw-pi-desktop",
      ".claw-pi",
      "config.json",
    ),
  ].filter(Boolean);

  for (const configPath of possiblePaths) {
    try {
      const content = await readFile(configPath, "utf-8");
      const config = JSON.parse(content);
      return config;
    } catch {}
  }

  console.error("❌ 无法读取配置文件，已尝试以下路径:");
  for (const p of possiblePaths) {
    console.error(`   - ${p}`);
  }
  console.error("   请确保已启动过 Claw-Pi 并连接了官方服务");
  return null;
}

async function testModel(modelId, apiKey, linkUrl) {
  const startTime = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${linkUrl}/v1/images/generations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        prompt: TEST_PROMPT,
        n: 1,
        size: "1024x1024",
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const duration = Date.now() - startTime;

    if (!response.ok) {
      const text = await response.text();
      let errorMessage = `HTTP ${response.status}`;

      try {
        const json = JSON.parse(text);
        errorMessage = json.error?.message || errorMessage;
      } catch {
        errorMessage = text.slice(0, 200);
      }

      return {
        success: false,
        duration,
        status: response.status,
        error: errorMessage,
      };
    }

    const data = await response.json();

    if (!data.data?.[0]?.url && !data.data?.[0]?.b64_json) {
      return {
        success: false,
        duration,
        status: response.status,
        error: "响应格式异常：缺少图片数据",
      };
    }

    return {
      success: true,
      duration,
      status: response.status,
    };
  } catch (error) {
    clearTimeout(timeoutId);
    const duration = Date.now() - startTime;

    let errorType = "未知错误";
    if (error.name === "AbortError") {
      errorType = "超时";
    } else if (error.message.includes("fetch failed")) {
      errorType = "网络连接失败";
    } else {
      errorType = error.message;
    }

    return {
      success: false,
      duration,
      error: errorType,
    };
  }
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function getStatusSymbol(result) {
  if (result.success) return "✅";
  if (result.error?.includes("余额不足")) return "💰";
  if (result.error?.includes("safety") || result.error?.includes("安全"))
    return "🛡️";
  if (result.error?.includes("超时") || result.error?.includes("timeout"))
    return "⏱️";
  if (result.status === 503 || result.status === 502) return "⚠️";
  return "❌";
}

async function diagnose(targetModel = null, testAll = false) {
  console.log("🔍 生图模型健康诊断\n");

  const config = await getConfig();
  if (!config) {
    process.exit(1);
  }

  const cloud = config.desktop?.cloud;
  if (!cloud?.connected || !cloud?.apiKey) {
    console.error("❌ Claw-Pi 官方服务未连接");
    console.error("   请先在桌面应用中连接官方服务");
    process.exit(1);
  }

  const { apiKey, linkUrl } = cloud;
  console.log(`📡 API端点: ${linkUrl}`);
  console.log(`🔑 API密钥: ${apiKey.slice(0, 8)}...${apiKey.slice(-4)}\n`);

  let modelsToTest = MODELS_TO_TEST;

  if (targetModel) {
    modelsToTest = MODELS_TO_TEST.filter(
      (m) => m.id === targetModel || m.id.includes(targetModel),
    );
    if (modelsToTest.length === 0) {
      console.error(`❌ 未找到模型: ${targetModel}`);
      console.log("\n可用模型:");
      for (const m of MODELS_TO_TEST) {
        console.log(`  - ${m.id}`);
      }
      process.exit(1);
    }
  } else if (!testAll) {
    modelsToTest = MODELS_TO_TEST.filter((m) => m.provider === "openai");
    console.log("ℹ️  默认测试 OpenAI 兜底链模型，使用 --all 测试所有模型\n");
  }

  console.log(`🧪 测试提示词: "${TEST_PROMPT}"`);
  console.log(`⏱️  超时时间: ${TIMEOUT_MS / 1000}s\n`);
  console.log("─".repeat(70));

  const results = [];

  for (const model of modelsToTest) {
    process.stdout.write(`测试 ${model.name} (${model.id})... `);

    const result = await testModel(model.id, apiKey, linkUrl);
    results.push({ model, result });

    const symbol = getStatusSymbol(result);
    const duration = formatDuration(result.duration);

    if (result.success) {
      console.log(`${symbol} 正常 (${duration})`);
    } else {
      console.log(`${symbol} 失败 (${duration})`);
      console.log(`   └─ ${result.error}`);
    }
  }

  console.log("─".repeat(70));

  const successCount = results.filter((r) => r.result.success).length;
  const failCount = results.length - successCount;

  console.log(`\n📊 测试结果: ${successCount}/${results.length} 成功`);

  if (failCount > 0) {
    console.log(`\n⚠️  ${failCount} 个模型不可用:`);
    for (const { model, result } of results.filter((r) => !r.result.success)) {
      console.log(`   • ${model.name}: ${result.error}`);
    }
  }

  console.log("\n💡 建议:");

  const healthyModels = results.filter((r) => r.result.success);
  if (healthyModels.length > 0) {
    const fastest = healthyModels.sort(
      (a, b) => a.result.duration - b.result.duration,
    )[0];
    console.log(
      `   • 最快的可用模型: ${fastest.model.name} (${formatDuration(fastest.result.duration)})`,
    );
  }

  const hasServiceError = results.some(
    (r) => r.result.status === 503 || r.result.status === 502,
  );
  if (hasServiceError) {
    console.log("   • 检测到上游服务不稳定（503/502），兜底策略会自动生效");
  }

  const hasBalanceError = results.some((r) =>
    r.result.error?.includes("余额不足"),
  );
  if (hasBalanceError) {
    console.log("   • 检测到余额不足，请及时充值");
  }

  console.log("");
}

const args = process.argv.slice(2);
const modelFlag = args.indexOf("--model");
const targetModel = modelFlag >= 0 ? args[modelFlag + 1] : null;
const testAll = args.includes("--all");

diagnose(targetModel, testAll).catch((error) => {
  console.error("\n❌ 诊断失败:", error.message);
  process.exit(1);
});
