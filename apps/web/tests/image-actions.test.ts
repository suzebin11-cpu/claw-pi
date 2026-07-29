import { afterEach, describe, expect, it, vi } from "vitest";
import {
  copyImageToClipboard,
  downloadImage,
} from "../src/lib/image-actions";

describe("copyImageToClipboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reports when the image bytes were copied", async () => {
    const write = vi.fn(async () => undefined);
    const writeText = vi.fn(async () => undefined);
    class ClipboardItemMock {
      constructor(public readonly items: Record<string, Blob>) {}
    }

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Blob(["image"], { type: "image/png" }), {
            status: 200,
          }),
      ),
    );
    vi.stubGlobal("navigator", { clipboard: { write, writeText } });
    vi.stubGlobal("window", { ClipboardItem: ClipboardItemMock });
    vi.stubGlobal("ClipboardItem", ClipboardItemMock);

    await expect(copyImageToClipboard("http://127.0.0.1/image.png"))
      .resolves.toBe("image");
    expect(write).toHaveBeenCalledOnce();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("reports the URL fallback when image clipboard writes are unavailable", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Blob(["image"], { type: "image/png" }), {
            status: 200,
          }),
      ),
    );
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("window", {});

    await expect(copyImageToClipboard("http://127.0.0.1/image.png"))
      .resolves.toBe("link");
    expect(writeText).toHaveBeenCalledWith("http://127.0.0.1/image.png");
  });
});

describe("downloadImage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("downloads through a blob URL instead of navigating to the image URL", async () => {
    const blob = new Blob(["image"], { type: "image/png" });
    const click = vi.fn();
    const remove = vi.fn();
    const anchor = {
      href: "",
      download: "",
      rel: "",
      style: { display: "" },
      click,
      remove,
    };
    const append = vi.fn();
    const createObjectURL = vi.fn(() => "blob:generated-image");
    const revokeObjectURL = vi.fn();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(blob, { status: 200 })),
    );
    vi.stubGlobal("document", {
      createElement: vi.fn(() => anchor),
      body: { append },
    });
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    vi.stubGlobal("window", {
      setTimeout: (callback: () => void) => {
        callback();
        return 1;
      },
    });

    await downloadImage(
      "http://127.0.0.1:50800/api/internal/desktop/generated-images/a.png",
      "generated.png",
    );

    expect(anchor.href).toBe("blob:generated-image");
    expect(anchor.download).toBe("generated.png");
    expect(anchor.href).not.toContain("/generated-images/");
    expect(append).toHaveBeenCalledWith(anchor);
    expect(click).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:generated-image");
  });

  it("does not create a navigation target when fetching the image fails", async () => {
    const createElement = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("missing", { status: 404 })),
    );
    vi.stubGlobal("document", {
      createElement,
      body: { append: vi.fn() },
    });

    await expect(downloadImage("http://127.0.0.1/missing.png", "x.png"))
      .rejects.toThrow("status 404");
    expect(createElement).not.toHaveBeenCalled();
  });
});
