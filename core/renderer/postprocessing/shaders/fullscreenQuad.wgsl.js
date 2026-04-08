// core/renderer/postprocessing/shaders/fullscreenQuad.wgsl.js
//
// Reusable full-screen triangle vertex shader. Draws a single triangle that
// covers the entire viewport using vertex_index (no vertex buffers needed).
// Import the WGSL snippet and prepend it to any fragment-only post-process shader.

export const fullscreenQuadVertexWGSL = /* wgsl */`
struct FullscreenVsOut {
    @builtin(position) position: vec4<f32>,
    @location(0)       uv:       vec2<f32>,
};

@vertex
fn vs_fullscreen(@builtin(vertex_index) vid: u32) -> FullscreenVsOut {
    // Single triangle covering clip space: (-1,-1) to (3,1) / (-1,3).
    // UV goes from (0,1) at top-left to (1,0) at bottom-right (WebGPU NDC).
    var out: FullscreenVsOut;
    let x = f32(i32(vid & 1u) * 4 - 1);
    let y = f32(i32(vid >> 1u) * 4 - 1);
    out.position = vec4<f32>(x, y, 0.0, 1.0);
    out.uv = vec2<f32>(
        (x + 1.0) * 0.5,
        (1.0 - y) * 0.5
    );
    return out;
}
`;
