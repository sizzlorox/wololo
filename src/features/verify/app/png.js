import { inflateSync } from 'node:zlib';

/**
 * Just enough PNG decoding to tell a drawn screen from a blank one: 8-bit greyscale, RGB and RGBA,
 * not interlaced (what browsers and OS screenshot tools write).
 * @param {Buffer} buf
 * @returns {{ width: number, height: number, channels: number, pixels: Buffer } | null}  null when the format is one we do not read
 */
export function decodePng(buf) {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let width = 0;
  let height = 0;
  let channels = 0;
  /** @type {Buffer[]} */
  const data = [];
  for (let at = 8; at + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString('ascii', at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const colour = body[9];
      channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[/** @type {0 | 2 | 4 | 6} */ (colour)] ?? 0;
      if (depth !== 8 || !channels || body[12] !== 0) return null;
    } else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') break;
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[y * stride + x - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      const add = [0, a, b, (a + b) >> 1, paeth][filter] ?? 0;
      pixels[y * stride + x] = (line[x] + add) & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

/**
 * Whether a region shows nothing: one colour covers almost all of it (a cleared canvas, an empty
 * window with only a resize grip or a cursor on it).
 * @param {Buffer} png @param {{ x: number, y: number, width: number, height: number }} [region]
 * @returns {{ blank: boolean, share: number } | null}  share: how much of it the commonest colour covers; null when the PNG could not be read
 */
export function blankness(png, region) {
  const img = decodePng(png);
  if (!img) return null;
  const r = region ?? { x: 0, y: 0, width: img.width, height: img.height };
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(img.width, Math.ceil(r.x + r.width));
  const y1 = Math.min(img.height, Math.ceil(r.y + r.height));
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 40000)));
  /** @type {Map<number, number>} */
  const counts = new Map();
  let n = 0;
  for (let y = y0; y < y1; y += step)
    for (let x = x0; x < x1; x += step) {
      const i = (y * img.width + x) * img.channels;
      const k = img.channels >= 3 ? ((img.pixels[i] >> 3) << 10) | ((img.pixels[i + 1] >> 3) << 5) | (img.pixels[i + 2] >> 3) : img.pixels[i] >> 3;
      counts.set(k, (counts.get(k) ?? 0) + 1);
      n++;
    }
  const share = n ? Math.max(...counts.values()) / n : 1;
  return { blank: share >= 0.97, share };
}
