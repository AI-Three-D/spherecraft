/* global Buffer */
// tools/perf/riverMetrics/png.js
//
// 8-bit RGB(A) PNG reading and RGB writing for the river metrics, Node only
// (zlib), no dependencies. readPng as tools/perf/lakeRecovery/renderedWaterDiff.mjs.
import zlib from 'node:zlib';

/** { w, h, px: Uint8Array rgb } from an 8-bit, non-interlaced RGB or RGBA PNG buffer. */
export function readPng(buf) {
    let w = 0, h = 0, ct = 0;
    const idat = [];
    for (let o = 8; o < buf.length;) {
        const len = buf.readUInt32BE(o), type = buf.toString('ascii', o + 4, o + 8), data = buf.subarray(o + 8, o + 8 + len);
        if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; if (data[8] !== 8 || data[12] !== 0) throw new Error('8-bit non-interlaced only'); }
        else if (type === 'IDAT') idat.push(data);
        o += 12 + len;
    }
    const bpp = ct === 6 ? 4 : ct === 2 ? 3 : (() => { throw new Error(`colour type ${ct}`); })();
    const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, px = new Uint8Array(w * h * 3);
    let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
    for (let y = 0; y < h; y++) {
        const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        for (let x = 0; x < stride; x++) {
            const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
            let p = 0;
            if (f === 1) p = a; else if (f === 2) p = b; else if (f === 3) p = (a + b) >> 1;
            else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
            cur[x] = (line[x] + p) & 255;
        }
        for (let x = 0; x < w; x++) for (let k = 0; k < 3; k++) px[(y * w + x) * 3 + k] = cur[x * bpp + k];
        [prev, cur] = [cur, prev];
    }
    return { w, h, px };
}

/** PNG buffer (8-bit RGB, no filtering) of w x h rgb pixels. */
export function writePng(w, h, px) {
    const chunk = (type, data) => {
        const len = Buffer.alloc(4), crc = Buffer.alloc(4), td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        len.writeUInt32BE(data.length);
        crc.writeUInt32BE(zlib.crc32(td) >>> 0);
        return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const raw = Buffer.alloc(h * (3 * w + 1));
    for (let y = 0; y < h; y++) Buffer.from(px.buffer, px.byteOffset + y * 3 * w, 3 * w).copy(raw, y * (3 * w + 1) + 1);
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
