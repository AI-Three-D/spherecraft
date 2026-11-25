import { LIGHTING_MODELS } from './lightingModels.js';

const literal = value => {
    const digits = value.toPrecision(8);
    return /[.e]/.test(digits) ? digits : digits + '.0';
};

function shaderNetwork(name, model, raw = false) {
    if (Array.isArray(model)) {
        // Ensemble: geometric mean of the members (mean of their log outputs).
        const members = model.map((member, i) => shaderNetwork(`${name}_${i}`, member, true));
        const sum = model.map((_, i) => `${name}_${i}(x)`).join(' + ');
        return members.join('') + `fn ${name}(x: array<vec4f, ${Math.ceil(model[0].sizes[0] / 4)}>) -> f32 {\n`
            + `    return exp(clamp((${sum}) / ${literal(model.length)}, -30.0, 10.0));\n}\n`;
    }
    const { sizes, W, b, mean, scale, outBias } = model;
    const inputs = Math.ceil(sizes[0] / 4);
    const declarations = Array.from({ length: inputs }, (_, i) => {
        const vec = values => `vec4f(${Array.from({ length: 4 }, (_, j) => literal(values[4 * i + j] ?? 0)).join(', ')})`;
        return `let p0_${i} = (x[${i}] - ${vec(mean)}) * ${vec(scale)};`;
    });
    for (let layer = 0; layer < W.length; layer++) {
        const inputPacks = Math.ceil(sizes[layer] / 4);
        const neurons = Array.from({ length: sizes[layer + 1] }, (_, output) => {
            const products = Array.from({ length: inputPacks }, (_, i) => {
                const row = Array.from({ length: 4 }, (_, j) => literal(W[layer][4 * i + j]?.[output] ?? 0));
                return `dot(p${layer}_${i}, vec4f(${row.join(', ')}))`;
            });
            return [literal(b[layer][output]), ...products].join(' + ');
        });
        if (neurons.length === 1) {
            declarations.push(raw ? `return ${neurons[0]} + ${literal(outBias[0])};`
                : `return exp(clamp(${neurons[0]} + ${literal(outBias[0])}, -30.0, 10.0));`);
        } else {
            for (let i = 0; i < neurons.length / 4; i++) {
                const pack = `h${layer}_${i}`;
                declarations.push(`let ${pack} = vec4f(${neurons.slice(4 * i, 4 * i + 4).join(', ')});`);
                declarations.push(`let p${layer + 1}_${i} = ${pack} / (vec4f(1.0) + abs(${pack}));`);
            }
        }
    }
    return `fn ${name}(x: array<vec4f, ${inputs}>) -> f32 {\n    ${declarations.join('\n    ')}\n}\n`;
}

// WGSL of the trained networks: inferMultipleScattering, inferSkyScattering and inferDirectTransmittance. All take the bake's
// packed feature array.
export const CLOUD_LIGHTING_INFERENCE_WGSL = shaderNetwork('inferMultipleScattering', LIGHTING_MODELS.ms)
    + shaderNetwork('inferSkyScattering', LIGHTING_MODELS.sky) + shaderNetwork('inferDirectTransmittance', LIGHTING_MODELS.direct);
