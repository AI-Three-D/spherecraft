export function gridIndices(W, L) {
    const idx = new Uint32Array((W - 1) * (L - 1) * 6);
    let q = 0;
    for (let j = 0; j < L - 1; j++) {
        for (let i = 0; i < W - 1; i++) {
            const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
            idx[q++] = a; idx[q++] = c; idx[q++] = b;
            idx[q++] = b; idx[q++] = c; idx[q++] = d;
        }
    }
    return idx;
}

