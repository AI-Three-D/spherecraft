// Compile a trained MLP (tools/neural/mlp.py JSON) into unrolled WGSL with literal weights.
// Unrolled constants let the compiler keep everything in registers: no buffer loads per weight.

const lit = v => {
    const s = Number(v).toPrecision(7);
    return s.includes('.') || s.includes('e') ? s : `${s}.0`;
};

function activation(kind, x) {
    if (kind === 'relu') return `max(${x}, 0.0)`;
    if (kind === 'tanh') return `tanh(${x})`;
    return `(${x}) / (1.0 + abs(${x}))`;
}

/**
 * Returns WGSL for `fn <name>(x: array<f32, N>) -> f32` evaluating exp(net(x)) (positive radiance).
 * precision: 'f32' or 'f16' (needs `enable f16;` and the shader-f16 feature).
 */
export function mlpWgsl(name, model, { precision = 'f32', vectorized = true } = {}) {
    const { sizes, W, b, mean, scale, outBias, activation: kind } = model;
    const T = precision;
    const lines = [];
    const n0 = sizes[0];
    for (let i = 0; i < n0; i++) {
        lines.push(`let i${i} = ${T}((x[${i}] - ${lit(mean[i])}) * ${lit(scale[i])});`);
    }
    let prev = Array.from({ length: n0 }, (_, i) => `i${i}`);
    for (let layer = 0; layer < W.length; layer++) {
        const [nIn, nOut] = [sizes[layer], sizes[layer + 1]];
        const last = layer === W.length - 1;
        const outs = [];
        if (vectorized && nIn % 4 === 0) {
            // Pack the inputs into vec4s once, then each neuron is nIn/4 dot products.
            const packs = [];
            for (let k = 0; k < nIn; k += 4) {
                const pname = `p${layer}_${k / 4}`;
                lines.push(`let ${pname} = vec4<${T}>(${prev.slice(k, k + 4).join(', ')});`);
                packs.push(pname);
            }
            for (let j = 0; j < nOut; j++) {
                const terms = packs.map((p, q) => `dot(${p}, vec4<${T}>(${[0, 1, 2, 3].map(r => lit(W[layer][4 * q + r][j])).join(', ')}))`);
                const pre = `${T}(${lit(b[layer][j])}) + ${terms.join(' + ')}`;
                const v = `h${layer}_${j}`;
                lines.push(last ? `let ${v} = ${pre};` : `let ${v}_pre = ${pre};\n    let ${v} = ${activation(kind, `${v}_pre`)};`);
                outs.push(v);
            }
        } else {
            for (let j = 0; j < nOut; j++) {
                const terms = prev.map((p, i) => `${p} * ${T}(${lit(W[layer][i][j])})`);
                const pre = `${T}(${lit(b[layer][j])}) + ${terms.join(' + ')}`;
                const v = `h${layer}_${j}`;
                lines.push(last ? `let ${v} = ${pre};` : `let ${v}_pre = ${pre};\n    let ${v} = ${activation(kind, `${v}_pre`)};`);
                outs.push(v);
            }
        }
        prev = outs;
    }
    lines.push(`return exp(clamp(f32(${prev[0]}) + ${lit(outBias[0])}, -30.0, 10.0));`);
    return `fn ${name}(x: array<f32, ${n0}>) -> f32 {\n    ${lines.join('\n    ')}\n}\n`;
}

export function mlpMacs(model) {
    return model.sizes.slice(0, -1).reduce((sum, n, i) => sum + n * model.sizes[i + 1], 0);
}
