// A periodic 3D material volume. RGB stores a signed height gradient, A
// stores pigment. Averaging the signed gradient in each mip flattens relief
// as it becomes too small to resolve, without putting noise in the shader.
export function createTerrainSurfaceTexture(device) {
    const size = 64;
    const mipLevelCount = Math.log2(size) + 1;
    const texture = device.createTexture({
        label: 'Terrain surface relief and pigment',
        size: [size, size, size],
        dimension: '3d',
        format: 'rgba8unorm',
        mipLevelCount,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    const index = (x, y, z) => ((z & 63) * size + (y & 63)) * size + (x & 63);
    const gradientSource = new Float32Array(size ** 3);
    const pigment = new Float32Array(gradientSource.length);
    const mix = (a, b, t) => a + (b - a) * t;
    const smooth = x => x * x * (3 - 2 * x);
    const noise = (x, y, z, period, seed) => {
        const mask = period - 1;
        const ix = Math.floor(x);
        const iy = Math.floor(y);
        const iz = Math.floor(z);
        const tx = smooth(x - ix);
        const ty = smooth(y - iy);
        const tz = smooth(z - iz);
        const corner = (dx, dy, dz) => {
            let h = Math.imul((ix + dx) & mask, 1597334677) ^
                Math.imul((iy + dy) & mask, 3812015801) ^ Math.imul((iz + dz) & mask, 958282453) ^ seed;
            h = Math.imul(h ^ (h >>> 16), 2246822519);
            return ((h ^ (h >>> 13)) >>> 0) / 4294967295;
        };
        const row = (dy, dz) => mix(corner(0, dy, dz), corner(1, dy, dz), tx);
        return mix(mix(row(0, 0), row(1, 0), ty), mix(row(0, 1), row(1, 1), ty), tz);
    };

    for (let z = 0; z < size; z++) {
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const pockets = noise(x / 8, y / 8, z / 8, 8, 809);
                const warp = 1.8 * pockets;
                const grains = noise(x / 4 + warp, y / 4 - warp, z / 4 + warp, 16, 211);
                const chips = noise(x / 2, y / 2, z / 2, 32, 761);
                const ridges = 1 - Math.abs(2 * grains - 1);
                const i = index(x, y, z);
                gradientSource[i] = 0.32 * pockets + 0.40 * ridges ** 2 + 0.28 * chips;
                pigment[i] = Math.min(1, Math.max(0, 0.5 + 0.75 * (pockets - 0.5) + 0.55 * (chips - 0.5)
                    - 0.13 * (1 - ridges)));
            }
        }
    }

    const encode = value => Math.round(Math.min(1, Math.max(0, value)) * 255);
    let data = new Uint8Array(gradientSource.length * 4);
    for (let z = 0; z < size; z++) {
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const i = index(x, y, z);
                data[4 * i] = encode(0.5 + 1.7 * (gradientSource[index(x + 1, y, z)] - gradientSource[index(x - 1, y, z)]));
                data[4 * i + 1] = encode(0.5 + 1.7 * (gradientSource[index(x, y + 1, z)] - gradientSource[index(x, y - 1, z)]));
                data[4 * i + 2] = encode(0.5 + 1.7 * (gradientSource[index(x, y, z + 1)] - gradientSource[index(x, y, z - 1)]));
                data[4 * i + 3] = encode(pigment[i]);
            }
        }
    }

    for (let mipLevel = 0, width = size; mipLevel < mipLevelCount; mipLevel++, width /= 2) {
        device.queue.writeTexture({ texture, mipLevel }, data,
            { bytesPerRow: 4 * width, rowsPerImage: width }, [width, width, width]);
        if (width === 1) break;

        const half = width / 2;
        const next = new Uint8Array(half ** 3 * 4);
        for (let z = 0; z < half; z++) {
            for (let y = 0; y < half; y++) {
                for (let x = 0; x < half; x++) {
                    const src = 8 * ((z * width + y) * width + x);
                    const dst = 4 * ((z * half + y) * half + x);
                    for (let c = 0; c < 4; c++) {
                        let sum = 0;
                        for (const dz of [0, 1]) {
                            for (const dy of [0, 1]) {
                                const row = src + c + 4 * (dz * width + dy) * width;
                                sum += data[row] + data[row + 4];
                            }
                        }
                        next[dst + c] = Math.round(sum / 8);
                    }
                }
            }
        }
        data = next;
    }
    return { _gpuTexture: { texture } };
}
