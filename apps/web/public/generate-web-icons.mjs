import sharp from "sharp";
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const svgSource = readFileSync(
  join(__dirname, "..", "..", "desktop", "build", "icon.svg"),
);

function createIcoBuffer(pngBuffers, sizes) {
  const numImages = pngBuffers.length;
  const headerSize = 6;
  const dirEntrySize = 16;
  let dataOffset = headerSize + dirEntrySize * numImages;
  const dirEntries = [];
  const imageDataParts = [];

  for (let i = 0; i < numImages; i++) {
    const size = sizes[i];
    const data = pngBuffers[i];
    const entry = Buffer.alloc(dirEntrySize);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(dataOffset, 12);
    dirEntries.push(entry);
    imageDataParts.push(data);
    dataOffset += data.length;
  }

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(numImages, 4);

  return Buffer.concat([header, ...dirEntries, ...imageDataParts]);
}

async function renderPng(size) {
  return sharp(svgSource, { density: 300 }).resize(size, size).png().toBuffer();
}

async function main() {
  const faviconDir = join(__dirname, "favicon");

  console.log("Generating favicon PNGs...");
  for (const size of [16, 32]) {
    const buf = await renderPng(size);
    writeFileSync(join(faviconDir, `favicon-${size}x${size}.png`), buf);
    console.log(`  -> favicon-${size}x${size}.png`);
  }

  console.log("Generating apple-touch-icon.png (180x180)...");
  writeFileSync(join(faviconDir, "apple-touch-icon.png"), await renderPng(180));

  console.log("Generating android-chrome PNGs...");
  for (const size of [192, 512]) {
    const buf = await renderPng(size);
    writeFileSync(join(faviconDir, `android-chrome-${size}x${size}.png`), buf);
    console.log(`  -> android-chrome-${size}x${size}.png`);
  }

  console.log("Generating favicon.ico...");
  const icoSizes = [16, 24, 32, 48];
  const icoBuffers = await Promise.all(icoSizes.map(renderPng));
  writeFileSync(join(faviconDir, "favicon.ico"), createIcoBuffer(icoBuffers, icoSizes));
  console.log("  -> favicon.ico");

  console.log("Generating claw-pi-avatar.png (512x512)...");
  writeFileSync(join(__dirname, "claw-pi-avatar.png"), await renderPng(512));
  console.log("  -> claw-pi-avatar.png");

  console.log("Done! All web icon assets generated.");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
