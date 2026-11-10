import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(name, data) {
  const type = Buffer.from(name, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, checksum]);
}

function roundedRect(x, y, width, height, radius, px, py) {
  const cx = Math.max(x + radius, Math.min(px, x + width - radius));
  const cy = Math.max(y + radius, Math.min(py, y + height - radius));
  return (px - cx) ** 2 + (py - cy) ** 2 <= radius ** 2;
}

function makePng(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const scale = size / 180;
  const card = { x: 39 * scale, y: 31 * scale, width: 102 * scale, height: 118 * scale, radius: 20 * scale };
  const line = { x: 57 * scale, width: 62 * scale, height: 7 * scale, radius: 3.5 * scale };
  const rowYs = [76, 96, 116].map((value) => value * scale);
  const coin = { x: 118 * scale, y: 57 * scale, radius: 10 * scale };

  for (let y = 0; y < size; y++) {
    const rowOffset = y * (size * 4 + 1);
    raw[rowOffset] = 0;
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let color = [31, 107, 87, 255];
      if (roundedRect(card.x, card.y, card.width, card.height, card.radius, px, py)) color = [246, 249, 247, 255];
      for (let i = 0; i < rowYs.length; i++) {
        if (roundedRect(line.x, rowYs[i], line.width, line.height, line.radius, px, py)) color = [31, 107, 87, 255];
      }
      if ((px - coin.x) ** 2 + (py - coin.y) ** 2 <= coin.radius ** 2) color = [242, 200, 117, 255];
      const offset = rowOffset + 1 + x * 4;
      raw[offset] = color[0];
      raw[offset + 1] = color[1];
      raw[offset + 2] = color[2];
      raw[offset + 3] = color[3];
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

await mkdir(resolve(root, "icons"), { recursive: true });
for (const size of [180, 192, 512]) {
  const name = size === 180 ? "apple-touch-icon.png" : `icon-${size}.png`;
  await writeFile(resolve(root, "icons", name), makePng(size));
}
