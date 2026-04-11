// core/renderer/particles/shaders/particleRender.wgsl.js
//
// Vertex + fragment shader for rendering GPU-simulated particles as
// camera-aligned quads. Vertex expansion is done from @builtin(vertex_index)
// so no vertex buffer is bound. One instance per live particle (indexed
// through a live-list produced by the sim shader).
//
// Two render pipelines share this shader module — they differ only in
// blend state — so we use a single WGSL source with no blend-specific
// branches here.

import { buildParticleCommonWGSL } from './particleCommon.wgsl.js';

export function buildParticleRenderWGSL({ typeCapacity = 8 } = {}) {
    const common = buildParticleCommonWGSL({ typeCapacity });

    return /* wgsl */`
${common}

@group(0) @binding(0) var<uniform>           globals  : ParticleGlobals;
@group(0) @binding(1) var<storage, read>     particles: array<Particle>;
@group(0) @binding(2) var<storage, read>     liveList : array<u32>;
@group(0) @binding(3) var<uniform>           typeDefs : array<ParticleTypeDef, PARTICLE_TYPE_CAPACITY>;

struct VsOut {
    @builtin(position) clipPos: vec4<f32>,
    @location(0)       uv:      vec2<f32>,
    @location(1)       color:   vec4<f32>,
    @location(2) @interpolate(flat) ptype: u32,
};

// Six-vertex quad as a triangle list.
//   0: (-1,-1)   1: ( 1,-1)   2: (-1, 1)
//   3: (-1, 1)   4: ( 1,-1)   5: ( 1, 1)
fn quadCorner(vid: u32) -> vec2<f32> {
    var c: vec2<f32>;
    switch (vid) {
        case 0u: { c = vec2<f32>(-1.0, -1.0); }
        case 1u: { c = vec2<f32>( 1.0, -1.0); }
        case 2u: { c = vec2<f32>(-1.0,  1.0); }
        case 3u: { c = vec2<f32>(-1.0,  1.0); }
        case 4u: { c = vec2<f32>( 1.0, -1.0); }
        default: { c = vec2<f32>( 1.0,  1.0); }
    }
    return c;
}

@vertex
fn vs_main(@builtin(vertex_index) vid: u32,
           @builtin(instance_index) iid: u32) -> VsOut {
    let slot = liveList[iid];
    let p = particles[slot];

    var corner = quadCorner(vid);

    // In-plane rotation (SMOKE) — rotate the 2D corner BEFORE expanding into
    // world axes, so the quad stays camera-facing and only its texture spins.
    if ((p.flags & FLAG_ROTATE) != 0u) {
        let c = cos(p.rotation);
        let s = sin(p.rotation);
        corner = vec2<f32>(
            corner.x * c - corner.y * s,
            corner.x * s + corner.y * c
        );
    }

    // Default: camera-aligned quad in world space.
    var axisX = globals.cameraRight * (corner.x * p.size);
    var axisY = globals.cameraUp    * (corner.y * p.size);

    // Velocity stretch (FLAME): replace Y axis with velocity direction,
    // elongating the billboard along motion.
    if ((p.flags & FLAG_STRETCH_VEL) != 0u) {
        let speed = length(p.velocity);
        if (speed > 0.001) {
            let velDir = p.velocity / speed;
            // Project camera right onto the plane perpendicular to velDir so
            // the sprite stays facing the camera while being stretched along
            // its motion.
            let cr = globals.cameraRight;
            var sideRaw = cr - velDir * dot(cr, velDir);
            let sideLen = length(sideRaw);
            if (sideLen > 0.0001) {
                sideRaw = sideRaw / sideLen;
            } else {
                sideRaw = cr;
            }
            axisX = sideRaw * (corner.x * p.size);
            axisY = velDir  * (corner.y * p.size * 1.6);
        }
    }

    let worldPos = p.position + axisX + axisY;

    var out: VsOut;
    out.clipPos = globals.viewProj * vec4<f32>(worldPos, 1.0);
    // UV stays in 0..1 space for the falloff calculation, derived from the
    // rotated corner so the soft edge follows the rotation as well.
    out.uv = corner * 0.5 + vec2<f32>(0.5, 0.5);
    out.color = p.color;
    out.ptype = p.ptype;
    return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    // Keep a bright core, but let the glow decay gradually across the sprite.
    let d = length(in.uv - vec2<f32>(0.5, 0.5)) * 2.0;
    if (d >= 1.0) { discard; }
    let radial = clamp(1.0 - d, 0.0, 1.0);
    let a = pow(radial, 0.7);
    return vec4<f32>(in.color.rgb, in.color.a * a);
}

@fragment
fn fs_bloom(in: VsOut) -> @location(0) vec4<f32> {
    let d = length(in.uv - vec2<f32>(0.5, 0.5)) * 2.0;
    if (d >= 1.0) { discard; }

    let bloomWeight = typeDefs[in.ptype].bloomWeight;
    if (bloomWeight <= 0.0) { discard; }

    let radial = clamp(1.0 - d, 0.0, 1.0);
    let a = pow(radial, 0.28);
    let bloomColor = in.color.rgb * bloomWeight;
    if (max(max(bloomColor.r, bloomColor.g), bloomColor.b) <= 1e-5) { discard; }

    return vec4<f32>(bloomColor, in.color.a * a);
}
`;
}
