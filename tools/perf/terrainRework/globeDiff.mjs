// Difference of two globe height dumps from shoot.mjs (spec.globe): writes a
// PNG (red = raised, blue = lowered, grey = land unchanged) and lists the
// directions of the largest changed clusters, for finding feature sites.
//
//   node tools/perf/terrainRework/globeDiff.mjs off.i16 on.i16 out.png [w h]
import fs from 'node:fs';
import zlib from 'node:zlib';

const [a, b, out, w = '720', h = '360'] = process.argv.slice(2);
const W = +w, H = +h;
const read = file => {
    const bytes = fs.readFileSync(file);
    if (bytes.byteLength !== W * H * 2) throw new Error(`Height dump dimensions do not match ${W} x ${H}: ${file}`);
    return new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
};
const A = read(a), B = read(b);
const rgb = new Uint8Array(W * H * 3);
let changed = 0, land = 0;
const cells = new Map();
for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i, d = B[k] - A[k];
    if (A[k] > 0) land++;
    const o = k * 3, m = Math.min(1, Math.abs(d) / 400);
    if (Math.abs(d) > 20) {
        changed++;
        const key = `${Math.floor(i / 12)},${Math.floor(j / 12)}`;
        const c = cells.get(key) ?? { n: 0, sum: 0, i: 0, j: 0 };
        c.n++; c.sum += Math.abs(d); c.i += i; c.j += j; cells.set(key, c);
    }
    const base = A[k] < 0 ? [30, 40, 70] : [110, 110, 100];
    const col = Math.abs(d) <= 20 ? base : d > 0 ? [base[0] + (255 - base[0]) * m, base[1] * (1 - m), base[2] * (1 - m)]
        : [base[0] * (1 - m), base[1] * (1 - m), base[2] + (255 - base[2]) * m];
    for (let c = 0; c < 3; c++) rgb[o + c] = col[c];
}
function crc32(buf) {
    let c, crc = 0xffffffff;
    for (let n = 0; n < buf.length; n++) {
        c = (crc ^ buf[n]) & 0xff;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
}
const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
};
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W * 3; x++) raw[y * (W * 3 + 1) + 1 + x] = rgb[y * W * 3 + x];
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
fs.writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
const top = [...cells.values()].sort((p, q) => q.sum - p.sum).slice(0, 8).map(c => {
    const i = c.i / c.n, j = c.j / c.n;
    const lat = Math.PI / 2 - (j + 0.5) / H * Math.PI, lon = (i + 0.5) / W * 2 * Math.PI - Math.PI;
    return { dir: [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)].map(v => +v.toFixed(4)),
        changedSamples: c.n, meanAbsM: Math.round(c.sum / c.n) };
});
console.log(JSON.stringify({ landFraction: +(land / (W * H)).toFixed(3), changedOfLand: +(changed / Math.max(1, land)).toFixed(3), top }, null, 1));
