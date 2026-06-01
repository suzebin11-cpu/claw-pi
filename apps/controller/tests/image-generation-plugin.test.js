import { describe, expect, it, vi } from "vitest";
import plugin from "../static/runtime-plugins/clawpi-image-generation/index.js";

function registerPlugin() {
  let tool = null;
  const api = {
    on: vi.fn(),
    registerTool: vi.fn((definition) => {
      tool = definition;
    }),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    config: {
      plugins: {
        entries: {
          "clawpi-image-generation": {
            config: { controllerUrl: "http://127.0.0.1:50800" },
          },
        },
      },
    },
  };

  plugin.register(api);
  return { api, tool };
}

describe("clawpi-image-generation plugin", () => {
  it("blocks image-to-image requests when no inputImages are available", async () => {
    const { tool } = registerPlugin();

    const result = await tool.execute("tool-call-1", {
      prompt: "基于上传图片生成一张海报，保留参考图片里的主体风格",
    });

    expect(result.content[0].text).toContain("没有收到可用的 inputImages");
    expect(result.details).toMatchObject({
      code: "missing_input_images",
      requiresInputImage: true,
      inputImagesCount: 0,
    });
  });
});
