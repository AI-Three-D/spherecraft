import { Geometry, Material, Texture, TextureFormat } from '../renderer/resources/index.js';
import { Matrix4 } from '../../shared/math/index.js';
import { GroundProfile } from './GroundProfile.js';
import { PlaneSlice } from './PlaneSlice.js';
import { RibbonBuilder } from './lineRibbon.js';
import { composeClipFromLocal } from './cameraRelative.js';
import { noiseWGSL } from './noise.js';
import { rockStructsWGSL, rockFunctionsWGSL } from './rockShader.wgsl.js';
import { SparseVolumeGPU } from './SparseVolumeGPU.js';
import { volumeDeclarationsWGSL, volumeFunctionsWGSL } from './volumeShader.wgsl.js';

// ---- ground line ribbons --------------------------------------------------------------------
const linePrelude = /* wgsl */ `
struct View { clipFromLocal: mat4x4<f32>, params: vec4<f32> }
@group(0) @binding(0) var<uniform> view: View;
struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) color: vec4<f32>,
}
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) edge: vec2<f32>,
}
`;
const lineVertexShader = `${linePrelude}
@vertex fn main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let reach = input.uv.y + 1.0;
    let local = input.position + input.normal * (input.uv.x * reach * view.params.x);
    output.position = view.clipFromLocal * vec4<f32>(local, 1.0);
    output.color = input.color;
    output.edge = vec2<f32>(input.uv.x * reach, input.uv.y);
    return output;
}
`;
const lineFragmentShader = `${linePrelude}
@fragment fn main(input: VertexOutput) -> @location(0) vec4<f32> {
    let coverage = clamp(input.edge.y + 0.5 - abs(input.edge.x), 0.0, 1.0);
    return vec4<f32>(input.color.rgb, input.color.a * coverage);
}
`;

// ---- cut face -------------------------------------------------------------------------------
// View: clipFromLocal, params (x = metres per pixel), cutOrigin (s0, y0, texel size), cutSize
// (width, height in texels, density range in voxels, voxel size).
const facePrelude = /* wgsl */ `
struct View {
    clipFromLocal: mat4x4<f32>,
    params: vec4<f32>,
    cutOrigin: vec4<f32>,
    cutSize: vec4<f32>,
}
${rockStructsWGSL}
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var<uniform> rock: Rock;
@group(0) @binding(2) var heights: texture_2d<f32>;
@group(0) @binding(3) var cut: texture_2d<f32>;
${volumeDeclarationsWGSL}
struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
}
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) local: vec3<f32>,
    @location(1) plane: vec2<f32>,
}
`;
const faceVertexShader = `${facePrelude}
@vertex fn main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = view.clipFromLocal * vec4<f32>(input.position, 1.0);
    output.local = input.position;
    output.plane = input.uv;
    return output;
}
`;
const faceFragmentShader = `${facePrelude}
${noiseWGSL}
${rockFunctionsWGSL}
${volumeFunctionsWGSL}
@fragment fn main(input: VertexOutput) -> @location(0) vec4<f32> {
    let metersPerPixel = view.params.x;
    let texel = view.cutOrigin.z;
    let size = vec2<i32>(view.cutSize.xy);
    // Manual bilinear on exact texel values: hardware filtering has too few weight bits when one
    // texel covers a hundred pixels.
    let g = clamp((input.plane - view.cutOrigin.xy) / texel, vec2<f32>(0.0), vec2<f32>(size - vec2<i32>(1)));
    let i = min(vec2<i32>(floor(g)), size - vec2<i32>(2));
    let t = g - vec2<f32>(i);
    let a = textureLoad(cut, i, 0).r;
    let b = textureLoad(cut, i + vec2<i32>(1, 0), 0).r;
    let c = textureLoad(cut, i + vec2<i32>(0, 1), 0).r;
    let d = textureLoad(cut, i + vec2<i32>(1, 1), 0).r;
    let stored = mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
    let slope = vec2<f32>(mix(b - a, d - c, t.y), mix(c - a, d - b, t.x));
    let toVoxels = 255.0 / 127.0 * view.cutSize.z;
    let density = (stored * 255.0 - 128.0) / 127.0 * view.cutSize.z;
    let perPixel = length(slope) * toVoxels * metersPerPixel / texel;
    let coverage = clamp(density / max(perPixel, 0.000001) + 0.5, 0.0, 1.0);
    let faceColor = rockColor(input.local, metersPerPixel);
    if (coverage < 1.0 && volumeDensity(input.local) <= 0.0) {
        let hit = farWall(input.local);
        if (hit.w >= 0.0) {
            return vec4<f32>(mix(wallShade(hit), faceColor, coverage), 1.0);
        }
    }
    if (coverage <= 0.0) { discard; }
    return vec4<f32>(faceColor, coverage);
}
`;

const DEFAULT_STYLE = {
    captured: { color: [1.0, 0.76, 0.33, 1], width: 2 },
    queried: { color: [0.42, 0.8, 1.0, 1], width: 2 },
    marker: { color: [1, 1, 1, 0.25], width: 1, top: 0.75, depth: 100 },
};

/**
 * Side ("anthill") view of a voxel region: the cut face (rock layers and veins where the plane
 * passes through rock), shaded far walls through air, and the ground line.
 * Requires an orthographic camera looking straight at the cut plane (see AnthillCamera).
 *
 * Backend notes:
 *  - each material is drawn once per frame: uniforms are written at draw() time, last write wins;
 *  - depthTest stays on (a pipeline without depth state cannot run in the main pass);
 *  - a texture whose data changed is NOT re-uploaded by draw(); call backend.updateTexture;
 *  - attribute types in VertexInput must be spelled vec3<f32> etc., the layout is parsed from them.
 */
export class AnthillViewModule {
    id = 'voxel-anthill-view';

    constructor({ region, plane, queryHeights = null, style = {}, onError = null,
        visibilityDepth = Math.min(24, region.volume.voxelSize * 1024) }) {
        if (!(visibilityDepth > 0) || !Number.isFinite(visibilityDepth) || visibilityDepth > region.volume.voxelSize * 1024) {
            throw new RangeError('AnthillViewModule: visibilityDepth must be positive and at most 1024 voxels');
        }
        this.visibilityDepth = visibilityDepth;
        this.region = region;
        this.frame = region.frame;
        this.plane = plane;
        this.style = {
            captured: { ...DEFAULT_STYLE.captured, ...style.captured },
            queried: { ...DEFAULT_STYLE.queried, ...style.queried },
            marker: { ...DEFAULT_STYLE.marker, ...style.marker },
        };
        this.profile = new GroundProfile({ heightfield: region.surface, plane, queryHeights, onError });
        this.slice = new PlaneSlice({ volume: region.volume, plane });
        this.lineData = new Float32Array(20);
        this.faceData = new Float32Array(28);
        this.rockData = region.rock.pack();
        this.volumeData = new Float32Array(16);
        this.volumeGPU = null;
        /** The slice grid drawn this frame (null when the plane misses the region). */
        this.cut = null;
        this.lineGeometry = null;
        this.lineMaterial = null;
        this.faceGeometry = null;
        this.faceMaterial = null;
        this.heightTexture = null;
        this._sliceTextures = new Map();
        this._faceEpoch = -1;
        this._faceIndexCount = 0;
        this._clipFromLocal = new Matrix4();
        this._local = { x: 0, y: 0, z: 0 };
        this._linesRevision = -1;
        this._lineIndexCount = 0;
    }

    initialize({ backend }) {
        this.backend = backend;
        this.volumeGPU = new SparseVolumeGPU(this.region.volume, backend.device);
        const v = this.region.volume;
        this.volumeData.set([v.minX, v.minY, v.minZ, v.voxelSize]);
        const integers = new Uint32Array(this.volumeData.buffer);
        integers.set([v.countX, v.countY, v.countZ, v.chunkSize], 4);
        integers.set([v.chunksX, v.chunksY, v.chunksZ, this.volumeGPU.wordsPerChunk], 8);
        const surface = this.region.surface;
        this.lineGeometry = new Geometry();
        this.lineMaterial = new Material({
            name: 'Voxel anthill lines',
            vertexShader: lineVertexShader,
            fragmentShader: lineFragmentShader,
            uniforms: { view: { value: this.lineData } },
            side: 'double', transparent: true, depthWrite: false, depthCompare: 'always',
            bindGroupLayoutSpec: [{ entries: [
                { binding: 0, name: 'view', visibility: 'vertex', buffer: { type: 'uniform' } },
            ] }],
        });
        this.faceGeometry = new Geometry();
        this.heightTexture = new Texture({
            width: surface.countX, height: surface.countZ, format: TextureFormat.R32F,
            data: surface.heights, generateMipmaps: false,
        });
        this.faceMaterial = new Material({
            name: 'Voxel cut face',
            vertexShader: faceVertexShader,
            fragmentShader: faceFragmentShader,
            uniforms: {
                view: { value: this.faceData },
                rock: { value: this.rockData },
                heights: { value: this.heightTexture },
                cut: { value: null },
                volume: { value: this.volumeData },
            },
            storageBuffers: { columns: this.volumeGPU.columns, chunkMap: this.volumeGPU.chunkMap, densities: this.volumeGPU.density },
            side: 'double', transparent: true,
            bindGroupLayoutSpec: [{ entries: [
                { binding: 0, name: 'view', visibility: 'vertex|fragment', buffer: { type: 'uniform' } },
                { binding: 1, name: 'rock', visibility: 'fragment', buffer: { type: 'uniform' } },
                { binding: 2, name: 'heights', visibility: 'fragment', texture: { sampleType: 'unfilterable-float' } },
                { binding: 3, name: 'cut', visibility: 'fragment', texture: { sampleType: 'float' } },
                { binding: 4, name: 'volume', visibility: 'fragment', buffer: { type: 'uniform' } },
                { binding: 5, name: 'columns', visibility: 'fragment', buffer: { type: 'read-only-storage' } },
                { binding: 6, name: 'chunkMap', visibility: 'fragment', buffer: { type: 'read-only-storage' } },
                { binding: 7, name: 'densities', visibility: 'fragment', buffer: { type: 'read-only-storage' } },
            ] }],
        });
    }

    /** Synchronous frame hook; the height query is started here but never awaited. */
    update({ camera, viewport }) {
        const p = camera.projectionMatrix.elements;
        if (p[15] !== 1 || p[11] !== 0) throw new Error('AnthillViewModule requires an orthographic camera');
        this.volumeGPU.sync();
        this.faceMaterial.storageBuffers.densities = this.volumeGPU.density;
        this.volumeData.set([this.plane.normalX, 0, this.plane.normalZ, this.visibilityDepth], 12);
        const metersPerPixel = 2 / (p[5] * viewport.height);
        const halfWidth = 1 / p[0], halfHeight = 1 / p[5];
        const local = this.frame.worldToLocal(camera.position.x, camera.position.y, camera.position.z, this._local);
        const centerS = this.plane.project(local.x, local.z).s;

        this.profile.update(centerS - halfWidth, centerS + halfWidth, metersPerPixel);
        if (this.profile.revision !== this._linesRevision) this._rebuildLines();

        const cut = this.slice.ensure(this.slice.levelFor(metersPerPixel),
            centerS - halfWidth, centerS + halfWidth, local.y - halfHeight, local.y + halfHeight);
        this._syncFace(cut);

        composeClipFromLocal(this.frame, camera, this._clipFromLocal);
        this.lineData.set(this._clipFromLocal.elements, 0);
        this.lineData[16] = metersPerPixel;
        this.faceData.set(this._clipFromLocal.elements, 0);
        this.faceData[16] = metersPerPixel;
        if (cut) {
            this.faceData[20] = cut.s0;
            this.faceData[21] = cut.y0;
            this.faceData[22] = cut.texel;
            this.faceData[24] = cut.width;
            this.faceData[25] = cut.height;
            this.faceData[26] = this.region.volume.densityRange;
            this.faceData[27] = this.region.volume.voxelSize;
        }
    }

    render({ backend }) {
        if (this.cut && this._faceIndexCount > 0) backend.draw(this.faceGeometry, this.faceMaterial);
    }

    renderTransparent({ backend }) {
        if (this._lineIndexCount > 0) backend.draw(this.lineGeometry, this.lineMaterial);
    }

    dispose() {
        this.profile.dispose();
        this.slice.dispose();
        this.volumeGPU?.dispose();
        for (const entry of this._sliceTextures.values()) this._release(entry.texture);
        this._sliceTextures.clear();
        if (this.heightTexture) this._release(this.heightTexture);
        this.lineGeometry?.dispose();
        this.faceGeometry?.dispose();
        if (this.lineMaterial) this.backend.destroyMaterial(this.lineMaterial);
        if (this.faceMaterial) this.backend.destroyMaterial(this.faceMaterial);
        this.lineGeometry = this.faceGeometry = this.lineMaterial = this.faceMaterial = this.heightTexture = null;
    }

    _release(texture) {
        this.backend.deleteTexture(texture);
        texture.dispose();
    }

    _syncFace(cut) {
        if (this.slice.epoch !== this._faceEpoch) {
            // The plane moved: every grid is new. Safe to destroy here, last frame is already submitted.
            for (const entry of this._sliceTextures.values()) this._release(entry.texture);
            this._sliceTextures.clear();
            this._faceEpoch = this.slice.epoch;
            this._rebuildFace();
        }
        this.cut = cut;
        if (!cut) return;
        let entry = this._sliceTextures.get(cut.level);
        if (!entry) {
            entry = {
                texture: new Texture({ width: cut.width, height: cut.height, format: TextureFormat.R8, data: cut.data, generateMipmaps: false }),
                revision: cut.revision,
            };
            this._sliceTextures.set(cut.level, entry);                 // first upload happens in draw()
        } else if (entry.revision !== cut.revision) {
            this.backend.updateTexture(entry.texture);                  // draw() does not re-upload changed data
            entry.revision = cut.revision;
        }
        this.faceMaterial.uniforms.cut.value = entry.texture;
    }

    _rebuildFace() {
        const span = this.slice.span;
        if (!span) {
            this._faceIndexCount = 0;
            return;
        }
        const { plane } = this, { minY, maxY } = this.region.volume;
        const corners = [[span[0], minY], [span[1], minY], [span[1], maxY], [span[0], maxY]];
        const position = new Float32Array(12), normal = new Float32Array(12), uv = new Float32Array(8);
        corners.forEach(([s, y], n) => {
            position.set([plane.x(s), y, plane.z(s)], n * 3);
            normal.set([plane.normalX, 0, plane.normalZ], n * 3);
            uv.set([s, y], n * 2);
        });
        this.faceGeometry
            .setAttribute('position', position, 3)
            .setAttribute('normal', normal, 3)
            .setAttribute('uv', uv, 2)
            .setIndex(new Uint32Array([0, 1, 2, 0, 2, 3]));
        this._faceIndexCount = 6;
    }

    _rebuildLines() {
        const { plane, profile, style } = this;
        const builder = new RibbonBuilder();
        for (const seam of profile.seams) {
            builder.addPolyline(
                [seam.s, seam.captured - style.marker.depth, seam.s, seam.captured - style.marker.top],
                plane, style.marker.color, style.marker.width);
        }
        for (const run of profile.runs) builder.addPolyline(run.points, plane, style[run.source].color, style[run.source].width);
        const arrays = builder.toArrays();
        this.lineGeometry
            .setAttribute('position', arrays.position, 3)
            .setAttribute('normal', arrays.normal, 3)
            .setAttribute('uv', arrays.uv, 2)
            .setAttribute('color', arrays.color, 4)
            .setIndex(arrays.index);
        this._lineIndexCount = arrays.index.length;
        this._linesRevision = profile.revision;
    }
}
