export type ImageClipboardResult = "image" | "link";

export async function copyImageToClipboard(
  src: string,
): Promise<ImageClipboardResult> {
  try {
    const response = await fetch(src);
    if (!response.ok) {
      throw new Error(`Image request failed with status ${response.status}`);
    }
    const blob = await response.blob();
    if (
      "ClipboardItem" in window &&
      typeof navigator.clipboard.write === "function"
    ) {
      await navigator.clipboard.write([
        new ClipboardItem({ [blob.type || "image/png"]: blob }),
      ]);
      return "image";
    }
  } catch {
    // Some embedded browsers cannot write image blobs. Copy the URL instead.
  }

  await navigator.clipboard.writeText(src);
  return "link";
}

export async function downloadImage(src: string, name: string): Promise<void> {
  const response = await fetch(src);
  if (!response.ok) {
    throw new Error(`Image request failed with status ${response.status}`);
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = name || "image.png";
  anchor.rel = "noopener noreferrer";
  anchor.style.display = "none";
  document.body.append(anchor);

  try {
    anchor.click();
  } finally {
    anchor.remove();
    // Keep the URL alive until Chromium has handed the blob to its downloader.
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
  }
}
