export function getGenericMeshShaders() {
    const vertex = /* wgsl */`
struct VertexUniforms {
    modelMatrix: mat4x4<f32>,
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
    cameraPosition: vec3<f32>,
    _pad0: f32,
};

@group(0) @binding(0) var<uniform> uniforms: VertexUniforms;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) color: vec4<f32>,  // This might not be provided
};

struct VertexOutput {
    @builtin(position) clipPosition: vec4<f32>,
    @location(0) worldPosition: vec3<f32>,
    @location(1) worldNormal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) vertexColor: vec4<f32>,
    @location(4) viewDirection: vec3<f32>,
};

@vertex
fn main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    
    // Transform to world space
    let worldPos = uniforms.modelMatrix * vec4<f32>(input.position, 1.0);
    output.worldPosition = worldPos.xyz;
    
    // Transform normal (assuming uniform scale)
    let normalMatrix = mat3x3<f32>(
        uniforms.modelMatrix[0].xyz,
        uniforms.modelMatrix[1].xyz,
        uniforms.modelMatrix[2].xyz
    );
    output.worldNormal = normalize(normalMatrix * input.normal);
    
    // View direction
    output.viewDirection = normalize(uniforms.cameraPosition - worldPos.xyz);
    
    // Transform to clip space
    let viewPos = uniforms.viewMatrix * worldPos;
    output.clipPosition = uniforms.projectionMatrix * viewPos;
    
    output.uv = input.uv;
    output.vertexColor = input.color;
    
    return output;
}
`;

    const fragment = /* wgsl */`
struct FragmentUniforms {
    baseColor: vec3<f32>,
    metalness: f32,
    
    roughness: f32,
    emissiveIntensity: f32,
    time: f32,
    _pad0: f32,
    
    emissiveColor: vec3<f32>,
    _pad1: f32,
    
    sunDirection: vec3<f32>,
    sunIntensity: f32,
    
    sunColor: vec3<f32>,
    _pad2: f32,
    
    ambientColor: vec3<f32>,
    _pad3: f32,
};

@group(0) @binding(1) var<uniform> uniforms: FragmentUniforms;

struct FragmentInput {
    @location(0) worldPosition: vec3<f32>,
    @location(1) worldNormal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) vertexColor: vec4<f32>,
    @location(4) viewDirection: vec3<f32>,
};

@fragment
fn main(input: FragmentInput) -> @location(0) vec4<f32> {
    let N = normalize(input.worldNormal);
    let V = normalize(input.viewDirection);
    let L = normalize(uniforms.sunDirection);
    
    // Simple diffuse + ambient lighting
    let NdotL = max(dot(N, L), 0.0);
    
    // Use vertex color if provided (alpha > 0), otherwise use base color
    var albedo = uniforms.baseColor;
    var emissiveFactor = 0.0;
    
    // Check if we have valid vertex color (not all zeros)
    if (length(input.vertexColor.rgb) > 0.01 || input.vertexColor.a > 0.01) {
        // Use vertex color for part differentiation
        albedo = mix(uniforms.baseColor, input.vertexColor.rgb, 0.5);
        emissiveFactor = input.vertexColor.a;
    }
    
    // Basic lighting
    let diffuse = albedo * uniforms.sunColor * uniforms.sunIntensity * NdotL;
    let ambient = albedo * uniforms.ambientColor * 0.3;
    
    // Emissive
    let emissive = uniforms.emissiveColor * uniforms.emissiveIntensity * emissiveFactor;
    
    // Combine
    var color = ambient + diffuse + emissive;
    
    return vec4<f32>(color, 1.0);
}
`;

    return { vertex, fragment };
}
