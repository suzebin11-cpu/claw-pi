import { describe, expect, it } from "vitest";
import { __test__ } from "../src/pages/ask";

function classify(text: string, recentTexts: string[] = []) {
  return __test__.classifyWorkbenchRequest({
    text,
    attachments: [],
    recentMessages: recentTexts.map((recentText, index) => ({
      id: `recent-${index}`,
      role: "assistant",
      text: recentText,
      createdAt: Date.now() - index,
    })) as never,
  });
}

describe("ask workbench routing", () => {
  it("routes explicit open requests to write_agent", () => {
    expect(classify("打开刚才你做好的网页")).toBe("write_agent");
    expect(classify("帮我打开这个 html 文件")).toBe("write_agent");
  });

  it("routes short direct-open continuations to write_agent with recent artifact context", () => {
    expect(
      classify("直接打开", ["已生成网页文件：有色金属财经简报.html"]),
    ).toBe("write_agent");
  });

  it("routes webpage analysis to the full write-capable agent", () => {
    expect(classify("帮我总结这个网页内容")).toBe("write_agent");
  });

  it("routes ordinary chat through the full write-capable agent and preserves image generation", () => {
    expect(classify("你好")).toBe("write_agent");
    expect(classify("生成一张图片")).toBe("image_generation");
  });
});
