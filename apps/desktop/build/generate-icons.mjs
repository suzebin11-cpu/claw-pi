import sharp from "sharp";
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const ICON_SIZES_ICO = [16, 24, 32, 48, 64, 128, 256];
const ICON_SIZES_ICNS = [16, 32, 64, 128, 256, 512, 1024];

function createIcoBuffer(pngBuffers, sizes) {
  const numImages = pngBuffers.length;
  const headerSize = 6;
  const dirEntrySize = 16;
  const dirSize = dirEntrySize * numImages;
  let dataOffset = headerSize + dirSize;
  const dirEntries = [];
  const imageDataParts = [];

  for (let i = 0; i < numImages; i++) {
    const size = sizes[i];
    const data = pngBuffers[i];
    const w = size >= 256 ? 0 : size;
    const h = size >= 256 ? 0 : size;

    const entry = Buffer.alloc(dirEntrySize);
    entry.writeUInt8(w, 0);
    entry.writeUInt8(h, 1);
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

const ICNS_TYPES = {
  16: "icp4",
  32: "icp5",
  64: "icp6",
  128: "ic07",
  256: "ic08",
  512: "ic09",
  1024: "ic10",
};

function createIcnsBuffer(pngBuffers, sizes) {
  const entries = [];
  let totalSize = 8;

  for (let i = 0; i < sizes.length; i++) {
    const type = ICNS_TYPES[sizes[i]];
    if (!type) continue;
    const data = pngBuffers[i];
    const entrySize = 8 + data.length;
    const entryHeader = Buffer.alloc(8);
    entryHeader.write(type, 0, 4, "ascii");
    entryHeader.writeUInt32BE(entrySize, 4);
    entries.push(Buffer.concat([entryHeader, data]));
    totalSize += entrySize;
  }

  const fileHeader = Buffer.alloc(8);
  fileHeader.write("icns", 0, 4, "ascii");
  fileHeader.writeUInt32BE(totalSize, 4);

  return Buffer.concat([fileHeader, ...entries]);
}

async function main() {
  const svgPath = join(__dirname, "icon.svg");
  const svgBuffer = readFileSync(svgPath);

  console.log("Generating icon.png (1024x1024)...");
  const png1024 = await sharp(svgBuffer, { density: 300 })
    .resize(1024, 1024)
    .png()
    .toBuffer();
  writeFileSync(join(__dirname, "icon.png"), png1024);
  console.log("  -> icon.png written");

  console.log("Generating icon.ico...");
  const icoBuffers = [];
  for (const size of ICON_SIZES_ICO) {
    const buf = await sharp(svgBuffer, { density: 300 })
      .resize(size, size)
      .png()
      .toBuffer();
    icoBuffers.push(buf);
  }
  const icoBuffer = createIcoBuffer(icoBuffers, ICON_SIZES_ICO);
  writeFileSync(join(__dirname, "icon.ico"), icoBuffer);
  console.log("  -> icon.ico written");

  console.log("Generating icon.icns...");
  const icnsBuffers = [];
  for (const size of ICON_SIZES_ICNS) {
    const buf = await sharp(svgBuffer, { density: 300 })
      .resize(size, size)
      .png()
      .toBuffer();
    icnsBuffers.push(buf);
  }
  const icnsBuffer = createIcnsBuffer(icnsBuffers, ICON_SIZES_ICNS);
  writeFileSync(join(__dirname, "icon.icns"), icnsBuffer);
  console.log("  -> icon.icns written");

  console.log("Done! All icon files generated.");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
