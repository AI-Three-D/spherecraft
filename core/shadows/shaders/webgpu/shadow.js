
export const shadowDepthVertex = `
// SHADOW_DEPTH_SHADER
struct Uniforms {
    modelMatrix: mat4x4<f32>,
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
}

struct VertexInput {
    @location(0) position: vec3<f32>,
}

struct VertexOutput {
    @builtin(position) clipPosition: vec4<f32>,
    @location(0) vDepth: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

@vertex
fn main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;

    let worldPosition = uniforms.modelMatrix * vec4<f32>(input.position, 1.0);
    let viewPosition = uniforms.viewMatrix * worldPosition;
    let projectedPosition = uniforms.projectionMatrix * viewPosition;

    output.clipPosition = projectedPosition;
    output.vDepth = (projectedPosition.z / projectedPosition.w) * 0.5 + 0.5;

    return output;
}
`;

export const shadowDepthInstancedVertex = `
// SHADOW_DEPTH_INSTANCED_SHADER
struct Uniforms {
    modelMatrix: mat4x4<f32>,
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
}

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) instanceMatrix0: vec4<f32>,
    @location(2) instanceMatrix1: vec4<f32>,
    @location(3) instanceMatrix2: vec4<f32>,
    @location(4) instanceMatrix3: vec4<f32>,
}

struct VertexOutput {
    @builtin(position) clipPosition: vec4<f32>,
    @location(0) vDepth: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

@vertex
fn main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;

    let instanceMatrix = mat4x4<f32>(
        input.instanceMatrix0,
        input.instanceMatrix1,
        input.instanceMatrix2,
        input.instanceMatrix3
    );

    let worldPosition = uniforms.modelMatrix * instanceMatrix * vec4<f32>(input.position, 1.0);
    let viewPosition = uniforms.viewMatrix * worldPosition;
    let projectedPosition = uniforms.projectionMatrix * viewPosition;

    output.clipPosition = projectedPosition;
    output.vDepth = (projectedPosition.z / projectedPosition.w) * 0.5 + 0.5;

    return output;
}
`;

export const shadowDepthFragment = `
struct FragmentInput {
    @location(0) vDepth: f32,
}

@fragment
fn main(input: FragmentInput) -> @location(0) vec4<f32> {
    return vec4<f32>(input.vDepth, input.vDepth, input.vDepth, 1.0);
}
`;