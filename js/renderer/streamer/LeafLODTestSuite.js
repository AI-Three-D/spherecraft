// js/renderer/streamer/LeafLODTestSuite.js
//
// Two-press LOD diagnostic tool for the leaf canopy pipeline.
//
// Press 1 (IDLE → LOCKED):
//   Locks to the closest tree. Renders a semi-transparent ghost overlay
//   of the coarser LOD in the main render pass, colored by LOD level:
//     L1 = blue,  L2 = yellow,  L3 = red
//   The overlay tracks the tree's LOD as the camera moves. Zero GPU
//   cost when idle — all compute/render is behind state guards.
//
// Press 2 (LOCKED → diagnostic or deselect):
//   If the tree's current band is the coarsest: deselects only.
//   Otherwise: runs a single-shot diagnostic capture (shape + shading
//   metrics between the current band and one coarser), then deselects.

import { Logger } from '../../config/Logger.js';
import { buildLeafScatterDetailedShader } from './shaders/leafScatterDetailed.wgsl.js';
import { buildLeafVertexShader } from './shaders/leafRender.wgsl.js';
import {
    BIRCH_MASK_VARIANTS,
    SPRUCE_MASK_VARIANTS,
    SPRUCE_MASK_LAYER_OFFSET,
} from './LeafMaskBaker.js';

const TEST_RT_SIZE    = 512;
const MAX_TEST_LEAVES = 10000;
const CLOSE_TREE_BYTES = 128;
const PIXEL_BYTES     = 4;

// ── State machine ────────────────────────────────────────────────────────
const S_IDLE              = 'idle';
const S_LOCKING           = 'locking';
const S_LOCKED            = 'locked';
const S_CAPTURING         = 'capturing';
const S_CAP_ENCODED       = 'capEncoded';
const S_CAP_AWAIT_SUBMIT  = 'capAwaitSubmit';
const S_CAP_AWAIT_READ    = 'capAwaitRead';
const S_CAP_READING       = 'capReading';

export class LeafLODTestSuite {
    constructor(device, streamer, config = {}) {
        this.device   = device;
        this.streamer = streamer;
        this.lodController = config.lodController;

        this._state           = S_IDLE;
        this._initialized     = false;
        this._sampleCount     = 0;
        this._framesSinceSubmit = 0;

        // CPU-side cache (updated from GPU readback while locked)
        this._lockedCurrentBand = -1;
        this._lockedTreeFound   = false;

        // ── Buffers ──────────────────────────────────────────────────
        this._lockedTreeBuffer  = null; // locked tree seed+position
        this._refTreeBuffer     = null; // current LOD (written by updateOverlay)
        this._overlayTreeBuffer = null; // LOD+1 (overlay + diagnostic test)
        this._oneCountBuffer    = null; // always [1]
        this._overlayStatusBuffer = null; // [found, currentBand, overlayActive, pad]
        this._overlayStatusReadbackBuffer = null;

        // Overlay leaf rendering
        this._overlayLeafBuffer    = null;
        this._overlayCounterBuffer = null;
        this._overlayDrawArgsBuffer = null;

        // Diagnostic leaf rendering
        this._refLeafBuffer       = null;
        this._testLeafBuffer      = null;
        this._refCounterBuffer    = null;
        this._testCounterBuffer   = null;
        this._refDrawArgsBuffer   = null;
        this._testDrawArgsBuffer  = null;
        this._refCounterReadbackBuffer  = null;
        this._testCounterReadbackBuffer = null;

        // Render targets (diagnostic only)
        this._refColorTex = null; this._refColorView = null;
        this._testColorTex = null; this._testColorView = null;
        this._refDepthTex = null; this._refDepthView = null;
        this._testDepthTex = null; this._testDepthView = null;
        this._refReadbackBuffer  = null;
        this._testReadbackBuffer = null;

        // Quad geometry
        this._quadPosBuffer = null; this._quadNormBuffer = null;
        this._quadUVBuffer = null; this._quadIdxBuffer = null;

        // ── Pipelines ────────────────────────────────────────────────
        this._findAndLockPipeline = null; this._findAndLockBGL = null;
        this._findAndLockBG = null; this._findAndLockBGDirty = true;

        this._updateOverlayPipeline = null; this._updateOverlayBGL = null;
        this._updateOverlayBG = null; this._updateOverlayBGDirty = true;

        this._scatterPipeline = null; this._scatterBGL = null;
        this._overlayScatterBG = null;
        this._refScatterBG = null; this._testScatterBG = null;
        this._scatterBGDirty = true;

        this._drawArgsPipeline = null; this._drawArgsBGL = null;
        this._overlayDrawArgsBG = null;
        this._refDrawArgsBG = null; this._testDrawArgsBG = null;
        this._drawArgsBGDirty = true;

        this._overlayRenderPipeline = null;
        this._diagRenderPipeline    = null;
        this._renderBGLs   = [];
        this._overlayRenderBGs = [];
        this._refRenderBGs  = [];
        this._testRenderBGs = [];
        this._renderBGsDirty = true;
    }

    // ══════════════════════════════════════════════════════════════════════
    // Lifecycle
    // ══════════════════════════════════════════════════════════════════════

    async initialize() {
        if (this._initialized) return;
        this._createBuffers();
        this._createRenderTargets();
        this._createLeafQuad();
        this._createFindAndLockPipeline();
        this._createUpdateOverlayPipeline();
        this._createScatterPipeline();
        this._createDrawArgsPipeline();
        this._createRenderPipelines();
        this._initialized = true;
        Logger.info('[LeafLODTestSuite] Initialized');
    }

    handleKeyPress() {
        if (!this._initialized) return;
        if (this._state === S_IDLE) {
            this._state = S_LOCKING;
            Logger.info('[LeafLODTestSuite] Locking to closest tree...');
        } else if (this._state === S_LOCKED) {
            this._state = S_CAPTURING;
            Logger.info('[LeafLODTestSuite] Unlocking — running diagnostics...');
        }
        // Ignore presses in transient states
    }

    isActive()   { return this._state !== S_IDLE; }
    isLocked()   { return this._state === S_LOCKED; }
    getState()   { return this._state; }

    dispose() {
        const d = (b) => b?.destroy?.();
        d(this._lockedTreeBuffer);
        d(this._refTreeBuffer); d(this._overlayTreeBuffer);
        d(this._oneCountBuffer);
        d(this._overlayStatusBuffer); d(this._overlayStatusReadbackBuffer);
        d(this._overlayLeafBuffer); d(this._overlayCounterBuffer);
        d(this._overlayDrawArgsBuffer);
        d(this._refLeafBuffer); d(this._testLeafBuffer);
        d(this._refCounterBuffer); d(this._testCounterBuffer);
        d(this._refDrawArgsBuffer); d(this._testDrawArgsBuffer);
        d(this._refCounterReadbackBuffer); d(this._testCounterReadbackBuffer);
        d(this._refColorTex); d(this._testColorTex);
        d(this._refDepthTex); d(this._testDepthTex);
        d(this._refReadbackBuffer); d(this._testReadbackBuffer);
        d(this._quadPosBuffer); d(this._quadNormBuffer);
        d(this._quadUVBuffer); d(this._quadIdxBuffer);
        this._initialized = false;
    }

    // ══════════════════════════════════════════════════════════════════════
    // Buffers + RTs
    // ══════════════════════════════════════════════════════════════════════

    _createBuffers() {
        const g = this.device;
        const mkBuf = (label, size, usage) =>
            g.createBuffer({ label, size: Math.max(256, size), usage });

        const STG  = GPUBufferUsage.STORAGE;
        const CPY  = GPUBufferUsage.COPY_DST;
        const CPYS = GPUBufferUsage.COPY_SRC;
        const UNI  = GPUBufferUsage.UNIFORM;
        const VTX  = GPUBufferUsage.VERTEX;
        const IND  = GPUBufferUsage.INDIRECT;
        const MR   = GPUBufferUsage.MAP_READ;
        const leafBytes = MAX_TEST_LEAVES * 64;

        this._lockedTreeBuffer  = mkBuf('LODTest-LockedTree', CLOSE_TREE_BYTES, STG|CPY);
        this._refTreeBuffer     = mkBuf('LODTest-RefTree',    CLOSE_TREE_BYTES, STG|CPY);
        this._overlayTreeBuffer = mkBuf('LODTest-OverlayTree',CLOSE_TREE_BYTES, STG|CPY);
        this._oneCountBuffer    = mkBuf('LODTest-OneCount',   256, STG|CPY);
        g.queue.writeBuffer(this._oneCountBuffer, 0, new Uint32Array([1]));

        this._overlayStatusBuffer         = mkBuf('LODTest-OvStatus',    256, STG|CPY|CPYS);
        this._overlayStatusReadbackBuffer = mkBuf('LODTest-OvStatusRB',  256, MR|CPY);

        this._overlayLeafBuffer    = mkBuf('LODTest-OvLeaves',  leafBytes, STG|VTX|CPY);
        this._overlayCounterBuffer = mkBuf('LODTest-OvCounter', 256, STG|CPY|CPYS);
        this._overlayDrawArgsBuffer= mkBuf('LODTest-OvDrawArgs',256, STG|IND|CPY);

        this._refLeafBuffer     = mkBuf('LODTest-RefLeaves',  leafBytes, STG|VTX|CPY);
        this._testLeafBuffer    = mkBuf('LODTest-TestLeaves', leafBytes, STG|VTX|CPY);
        this._refCounterBuffer  = mkBuf('LODTest-RefCtr',     256, STG|CPY|CPYS);
        this._testCounterBuffer = mkBuf('LODTest-TestCtr',    256, STG|CPY|CPYS);
        this._refDrawArgsBuffer = mkBuf('LODTest-RefDraw',    256, STG|IND|CPY);
        this._testDrawArgsBuffer= mkBuf('LODTest-TestDraw',   256, STG|IND|CPY);
        this._refCounterReadbackBuffer  = mkBuf('LODTest-RefCtrRB',  256, MR|CPY);
        this._testCounterReadbackBuffer = mkBuf('LODTest-TestCtrRB', 256, MR|CPY);

        const rtBytes = TEST_RT_SIZE * TEST_RT_SIZE * PIXEL_BYTES;
        this._refReadbackBuffer  = mkBuf('LODTest-RefRB',  rtBytes, MR|CPY);
        this._testReadbackBuffer = mkBuf('LODTest-TestRB', rtBytes, MR|CPY);
    }

    _createRenderTargets() {
        const g = this.device; const sz = TEST_RT_SIZE;
        const mkColor = (label) => {
            const t = g.createTexture({ label, size:[sz,sz], format:'rgba8unorm',
                usage: GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC });
            return { tex: t, view: t.createView() };
        };
        const mkDepth = (label) => {
            const t = g.createTexture({ label, size:[sz,sz], format:'depth24plus',
                usage: GPUTextureUsage.RENDER_ATTACHMENT });
            return { tex: t, view: t.createView() };
        };
        const rc = mkColor('LODTest-RefColor');
        this._refColorTex = rc.tex; this._refColorView = rc.view;
        const tc = mkColor('LODTest-TestColor');
        this._testColorTex = tc.tex; this._testColorView = tc.view;
        const rd = mkDepth('LODTest-RefDepth');
        this._refDepthTex = rd.tex; this._refDepthView = rd.view;
        const td = mkDepth('LODTest-TestDepth');
        this._testDepthTex = td.tex; this._testDepthView = td.view;
    }

    _createLeafQuad() {
        const pos = new Float32Array([-0.5,0,0, 0.5,0,0, 0.5,1,0, -0.5,1,0]);
        const nrm = new Float32Array([0,0,1, 0,0,1, 0,0,1, 0,0,1]);
        const uv  = new Float32Array([0,0, 1,0, 1,1, 0,1]);
        const idx = new Uint16Array([0,1,2, 0,2,3]);
        const mkVB = (data,l) => { const b = this.device.createBuffer({label:l,
            size:data.byteLength, usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST,
            mappedAtCreation:true}); new Float32Array(b.getMappedRange()).set(data);
            b.unmap(); return b; };
        this._quadPosBuffer  = mkVB(pos,'LODTest-QP');
        this._quadNormBuffer = mkVB(nrm,'LODTest-QN');
        this._quadUVBuffer   = mkVB(uv, 'LODTest-QU');
        const ib = this.device.createBuffer({label:'LODTest-QI',
            size:Math.ceil(idx.byteLength/4)*4,
            usage:GPUBufferUsage.INDEX|GPUBufferUsage.COPY_DST, mappedAtCreation:true});
        new Uint16Array(ib.getMappedRange(0,idx.byteLength)).set(idx);
        ib.unmap(); this._quadIdxBuffer = ib;
    }

    // ══════════════════════════════════════════════════════════════════════
    // Pipelines
    // ══════════════════════════════════════════════════════════════════════

    _closeTreeStructWGSL() {
        return /* wgsl */`struct CloseTreeInfo {
    worldPosX:f32,worldPosY:f32,worldPosZ:f32,rotation:f32,
    scaleX:f32,scaleY:f32,scaleZ:f32,distanceToCamera:f32,
    speciesIndex:u32,variantSeed:u32,detailLevel:u32,sourceIndex:u32,
    foliageR:f32,foliageG:f32,foliageB:f32,foliageA:f32,
    barkR:f32,barkG:f32,barkB:f32,barkA:f32,
    leafStart:u32,leafCount:u32,clusterStart:u32,clusterCount:u32,
    windPhase:f32,health:f32,age:f32,tileTypeId:u32,
    bandBlend:f32,_res0:f32,_res1:f32,_res2:f32,
}`;
    }

    _createFindAndLockPipeline() {
        const maxClose = this.lodController.maxCloseTrees;
        const code = /* wgsl */`
const MAX_CLOSE_TREES:u32=${maxClose}u;
${this._closeTreeStructWGSL()}
@group(0)@binding(0) var<storage,read>       closeTrees:array<CloseTreeInfo>;
@group(0)@binding(1) var<storage,read>       closeTreeCount:array<u32>;
@group(0)@binding(2) var<storage,read_write> lockedOut:array<CloseTreeInfo>;
@group(0)@binding(3) var<storage,read_write> status:array<u32>;
@compute @workgroup_size(1)
fn main(){
    let count=min(closeTreeCount[0],MAX_CLOSE_TREES);
    status[3]=count;
    if(count==0u){status[0]=0xFFFFFFFFu;status[1]=1u;status[2]=0u;return;}
    var minD:f32=1e30;var minI:u32=0u;
    for(var i=0u;i<count;i++){
        let d=closeTrees[i].distanceToCamera;
        if(d>0.001&&d<minD){minD=d;minI=i;}
    }
    if(minD>=1e29){status[0]=0xFFFFFFFFu;status[1]=1u;status[2]=0u;return;}
    lockedOut[0]=closeTrees[minI];
    status[0]=minI;status[1]=0u;status[2]=closeTrees[minI].detailLevel;
}`;
        const mod = this.device.createShaderModule({label:'LODTest-FindLock-SM',code});
        this._findAndLockBGL = this.device.createBindGroupLayout({label:'LODTest-FindLock-BGL',
            entries:[
                {binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:'read-only-storage'}},
                {binding:1,visibility:GPUShaderStage.COMPUTE,buffer:{type:'read-only-storage'}},
                {binding:2,visibility:GPUShaderStage.COMPUTE,buffer:{type:'storage'}},
                {binding:3,visibility:GPUShaderStage.COMPUTE,buffer:{type:'storage'}},
            ]});
        this._findAndLockPipeline = this.device.createComputePipeline({label:'LODTest-FindLock',
            layout:this.device.createPipelineLayout({bindGroupLayouts:[this._findAndLockBGL]}),
            compute:{module:mod,entryPoint:'main'}});
    }

    _createUpdateOverlayPipeline() {
        const maxClose = this.lodController.maxCloseTrees;
        const coarsest = this.lodController.detailBandCount - 1;
        const code = /* wgsl */`
const MAX_CLOSE_TREES:u32=${maxClose}u;
const COARSEST_BAND:u32=${coarsest}u;
${this._closeTreeStructWGSL()}
@group(0)@binding(0) var<storage,read>       closeTrees:array<CloseTreeInfo>;
@group(0)@binding(1) var<storage,read>       closeTreeCount:array<u32>;
@group(0)@binding(2) var<storage,read>       lockedTree:array<CloseTreeInfo>;
@group(0)@binding(3) var<storage,read_write> refOut:array<CloseTreeInfo>;
@group(0)@binding(4) var<storage,read_write> overlayOut:array<CloseTreeInfo>;
@group(0)@binding(5) var<storage,read_write> status:array<u32>;
@compute @workgroup_size(1)
fn main(){
    let seed=lockedTree[0].variantSeed;
    let count=min(closeTreeCount[0],MAX_CLOSE_TREES);
    status[3]=count;
    var found=false;var idx=0u;
    for(var i=0u;i<count;i++){
        if(closeTrees[i].variantSeed==seed){found=true;idx=i;break;}
    }
    if(!found){status[0]=0u;status[1]=0u;status[2]=0u;return;}
    let tree=closeTrees[idx];
    let band=tree.detailLevel;
    status[0]=1u; status[1]=band;
    // Ref copy at current LOD
    var rc=tree; rc.bandBlend=0.0; rc.leafStart=0u; rc.leafCount=0u;
    refOut[0]=rc;
    if(band>=COARSEST_BAND){status[2]=0u;return;}
    // Overlay copy at LOD+1
    var oc=tree; oc.detailLevel=band+1u; oc.bandBlend=0.0;
    oc.leafStart=0u; oc.leafCount=0u;
    overlayOut[0]=oc;
    status[2]=1u;
}`;
        const mod = this.device.createShaderModule({label:'LODTest-UpdOverlay-SM',code});
        this._updateOverlayBGL = this.device.createBindGroupLayout({label:'LODTest-UpdOverlay-BGL',
            entries:[
                {binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:'read-only-storage'}},
                {binding:1,visibility:GPUShaderStage.COMPUTE,buffer:{type:'read-only-storage'}},
                {binding:2,visibility:GPUShaderStage.COMPUTE,buffer:{type:'read-only-storage'}},
                {binding:3,visibility:GPUShaderStage.COMPUTE,buffer:{type:'storage'}},
                {binding:4,visibility:GPUShaderStage.COMPUTE,buffer:{type:'storage'}},
                {binding:5,visibility:GPUShaderStage.COMPUTE,buffer:{type:'storage'}},
            ]});
        this._updateOverlayPipeline = this.device.createComputePipeline({
            label:'LODTest-UpdOverlay',
            layout:this.device.createPipelineLayout({bindGroupLayouts:[this._updateOverlayBGL]}),
            compute:{module:mod,entryPoint:'main'}});
    }

    _createScatterPipeline() {
        const cfg = this.lodController.getLeafScatterShaderConfig();
        const code = buildLeafScatterDetailedShader({
            workgroupSize:256, maxCloseTrees:1, maxLeaves:MAX_TEST_LEAVES, ...cfg });
        const mod = this.device.createShaderModule({label:'LODTest-Scatter-SM',code});
        this._scatterBGL = this.device.createBindGroupLayout({label:'LODTest-Scatter-BGL',
            entries:[
                {binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:'uniform'}},
                {binding:1,visibility:GPUShaderStage.COMPUTE,buffer:{type:'storage'}},
                {binding:2,visibility:GPUShaderStage.COMPUTE,buffer:{type:'read-only-storage'}},
                {binding:3,visibility:GPUShaderStage.COMPUTE,buffer:{type:'storage'}},
                {binding:4,visibility:GPUShaderStage.COMPUTE,buffer:{type:'storage'}},
                {binding:5,visibility:GPUShaderStage.COMPUTE,buffer:{type:'read-only-storage'}},
                {binding:6,visibility:GPUShaderStage.COMPUTE,buffer:{type:'read-only-storage'}},
            ]});
        this._scatterPipeline = this.device.createComputePipeline({label:'LODTest-Scatter',
            layout:this.device.createPipelineLayout({bindGroupLayouts:[this._scatterBGL]}),
            compute:{module:mod,entryPoint:'main'}});
    }

    _createDrawArgsPipeline() {
        const code = /* wgsl */`
${this._closeTreeStructWGSL()}
@group(0)@binding(0) var<storage,read>       tree:array<CloseTreeInfo>;
@group(0)@binding(1) var<storage,read_write> drawArgs:array<u32>;
@compute @workgroup_size(1) fn main(){
    drawArgs[0]=6u; drawArgs[1]=tree[0].leafCount;
    drawArgs[2]=0u; drawArgs[3]=0u; drawArgs[4]=0u;
}`;
        const mod = this.device.createShaderModule({label:'LODTest-DrawArgs-SM',code});
        this._drawArgsBGL = this.device.createBindGroupLayout({label:'LODTest-DrawArgs-BGL',
            entries:[
                {binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:'read-only-storage'}},
                {binding:1,visibility:GPUShaderStage.COMPUTE,buffer:{type:'storage'}},
            ]});
        this._drawArgsPipeline = this.device.createComputePipeline({label:'LODTest-DrawArgs',
            layout:this.device.createPipelineLayout({bindGroupLayouts:[this._drawArgsBGL]}),
            compute:{module:mod,entryPoint:'main'}});
    }

    _createRenderPipelines() {
        const vsCode = buildLeafVertexShader({ enableWind: false });
        const vsMod  = this.device.createShaderModule({label:'LODTest-VS',code:vsCode});

        const group0 = this.device.createBindGroupLayout({label:'LODTest-RG0', entries:[
            {binding:0,visibility:GPUShaderStage.VERTEX,buffer:{type:'uniform'}},
            {binding:1,visibility:GPUShaderStage.VERTEX,buffer:{type:'read-only-storage'}},
        ]});
        const group1 = this.device.createBindGroupLayout({label:'LODTest-RG1', entries:[
            {binding:0,visibility:GPUShaderStage.FRAGMENT,buffer:{type:'uniform'}},
            {binding:1,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'float',viewDimension:'2d-array'}},
            {binding:2,visibility:GPUShaderStage.FRAGMENT,sampler:{type:'filtering'}},
        ]});
        this._renderBGLs = [group0, group1];
        const layout = this.device.createPipelineLayout({bindGroupLayouts:this._renderBGLs});

        const vtxBufs = [
            {arrayStride:12,stepMode:'vertex',attributes:[{shaderLocation:0,offset:0,format:'float32x3'}]},
            {arrayStride:12,stepMode:'vertex',attributes:[{shaderLocation:1,offset:0,format:'float32x3'}]},
            {arrayStride:8, stepMode:'vertex',attributes:[{shaderLocation:2,offset:0,format:'float32x2'}]},
        ];
        const prim = {topology:'triangle-list',cullMode:'none',frontFace:'ccw'};

        // ── Overlay pipeline (main pass, ghost tint, no depth write) ─
        const ovFS = this.device.createShaderModule({label:'LODTest-OverlayFS',
            code: this._buildOverlayFragShader()});
        this._overlayRenderPipeline = this.device.createRenderPipeline({
            label:'LODTest-OverlayPipeline', layout,
            vertex:{module:vsMod,entryPoint:'main',buffers:vtxBufs},
            fragment:{module:ovFS,entryPoint:'main',targets:[{
                format:navigator.gpu.getPreferredCanvasFormat(),
                blend:{
                    color:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'},
                    alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'},
                }}]},
            primitive:prim,
            depthStencil:{format:'depth24plus',depthWriteEnabled:false,depthCompare:'less'},
        });

        // ── Diagnostic pipeline (separate RT, premultiplied linear) ──
        const diagFS = this.device.createShaderModule({label:'LODTest-DiagFS',
            code: this._buildDiagFragShader()});
        this._diagRenderPipeline = this.device.createRenderPipeline({
            label:'LODTest-DiagPipeline', layout,
            vertex:{module:vsMod,entryPoint:'main',buffers:vtxBufs},
            fragment:{module:diagFS,entryPoint:'main',targets:[{
                format:'rgba8unorm',
                blend:{
                    color:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'},
                    alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'},
                }}]},
            primitive:prim,
            depthStencil:{format:'depth24plus',depthWriteEnabled:true,depthCompare:'less'},
        });
    }

    _fragCommon() {
        return /* wgsl */`
const BIRCH_VARIANTS:u32=${BIRCH_MASK_VARIANTS}u;
const SPRUCE_VARIANTS:u32=${SPRUCE_MASK_VARIANTS}u;
const SPRUCE_LAYER_OFFSET:u32=${SPRUCE_MASK_LAYER_OFFSET}u;
struct LeafFragUniforms{
    lightDirection:vec3<f32>,lightIntensity:f32,
    lightColor:vec3<f32>,_pad0:f32,
    ambientColor:vec3<f32>,ambientIntensity:f32,
    fogColor:vec3<f32>,fogDensity:f32,
}
struct FragInput{
    @builtin(position) fragCoord:vec4<f32>,
    @location(0) vUv:vec2<f32>,
    @location(1) vNormal:vec3<f32>,
    @location(2) vWorldPosition:vec3<f32>,
    @location(3) vColor:vec4<f32>,
    @location(4) vDistanceToCamera:f32,
    @location(5) vCluster:f32,
    @location(6) @interpolate(flat) vFlags:u32,
}
@group(1)@binding(0) var<uniform> fragUniforms:LeafFragUniforms;
@group(1)@binding(1) var leafMaskTex:texture_2d_array<f32>;
@group(1)@binding(2) var leafMaskSamp:sampler;

fn sampleMask(input:FragInput)->vec2<f32>{
    let isConifer=(input.vFlags&0x10u)!=0u;
    let emitBand=input.vFlags&0x7u;
    var layer:u32;
    if(isConifer){layer=SPRUCE_LAYER_OFFSET+min(u32(input.vCluster*f32(SPRUCE_VARIANTS)),SPRUCE_VARIANTS-1u);}
    else{layer=min(u32(input.vCluster*f32(BIRCH_VARIANTS)),BIRCH_VARIANTS-1u);}
    let mask=textureSample(leafMaskTex,leafMaskSamp,input.vUv,i32(layer));
    var conn=mask.g; if(emitBand>0u){conn=0.0;}
    let alpha=max(mask.r,conn*0.94);
    return vec2<f32>(alpha,conn);
}
`;
    }

    _buildOverlayFragShader() {
        return /* wgsl */`
${this._fragCommon()}

fn getLODColor(lod:u32)->vec3<f32>{
    switch(lod){
        case 1u:{return vec3<f32>(0.25,0.50,1.00);}
        case 2u:{return vec3<f32>(1.00,0.85,0.10);}
        case 3u:{return vec3<f32>(1.00,0.20,0.10);}
        default:{return vec3<f32>(0.50,0.50,0.50);}
    }
}

@fragment fn main(input:FragInput)->@location(0) vec4<f32>{
    let m=sampleMask(input);
    if(m.x<0.25){discard;}
    let emitBand=input.vFlags&0x7u;
    let lodColor=getLODColor(emitBand);
    let N=normalize(input.vNormal);
    let L=normalize(fragUniforms.lightDirection);
    let NdotL=max(dot(N,L),0.0);
    let lit=lodColor*(0.30+NdotL*0.50);
    let a=0.40*m.x;
    return vec4<f32>(lit*a,a);
}
`;
    }

    _buildDiagFragShader() {
        return /* wgsl */`
${this._fragCommon()}
const CONNECTOR_COLOR:vec3<f32>=vec3<f32>(0.14,0.09,0.05);

@fragment fn main(input:FragInput)->@location(0) vec4<f32>{
    let m=sampleMask(input);
    if(m.x<0.005){discard;}
    let alpha=m.x; let conn=m.y;
    let N=normalize(input.vNormal); let L=normalize(fragUniforms.lightDirection);
    let NdotL=dot(N,L); let front=max(NdotL,0.0); let back=max(-NdotL,0.0);
    let diffuse=fragUniforms.lightColor*fragUniforms.lightIntensity*(front*0.6+back*0.35);
    let ambient=fragUniforms.ambientColor*fragUniforms.ambientIntensity*0.7;
    var albedo=input.vColor.rgb;
    let connMix=clamp(conn*(1.0-m.x*0.55),0.0,1.0);
    albedo=mix(albedo,CONNECTOR_COLOR,connMix);
    let color=albedo*(ambient+diffuse)+input.vColor.rgb*fragUniforms.lightColor*(back*0.15);
    return vec4<f32>(color*alpha,alpha);
}
`;
    }

    // ══════════════════════════════════════════════════════════════════════
    // Bind groups
    // ══════════════════════════════════════════════════════════════════════

    _rebuildFindAndLockBG() {
        if (!this._findAndLockBGDirty) return true;
        const tds = this.streamer._treeDetailSystem;
        if (!tds) return false;
        const ct = tds.getCloseTreeBuffer(), ctc = tds.getCloseTreeCountBuffer();
        if (!ct || !ctc) return false;
        this._findAndLockBG = this.device.createBindGroup({layout:this._findAndLockBGL,
            entries:[
                {binding:0,resource:{buffer:ct}},
                {binding:1,resource:{buffer:ctc}},
                {binding:2,resource:{buffer:this._lockedTreeBuffer}},
                {binding:3,resource:{buffer:this._overlayStatusBuffer}},
            ]});
        this._findAndLockBGDirty = false;
        return true;
    }

    _rebuildUpdateOverlayBG() {
        if (!this._updateOverlayBGDirty) return true;
        const tds = this.streamer._treeDetailSystem;
        if (!tds) return false;
        const ct = tds.getCloseTreeBuffer(), ctc = tds.getCloseTreeCountBuffer();
        if (!ct || !ctc) return false;
        this._updateOverlayBG = this.device.createBindGroup({layout:this._updateOverlayBGL,
            entries:[
                {binding:0,resource:{buffer:ct}},
                {binding:1,resource:{buffer:ctc}},
                {binding:2,resource:{buffer:this._lockedTreeBuffer}},
                {binding:3,resource:{buffer:this._refTreeBuffer}},
                {binding:4,resource:{buffer:this._overlayTreeBuffer}},
                {binding:5,resource:{buffer:this._overlayStatusBuffer}},
            ]});
        this._updateOverlayBGDirty = false;
        return true;
    }

    _rebuildScatterBGs() {
        if (!this._scatterBGDirty) return true;
        const ls = this.streamer._leafStreamer;
        if (!ls?._paramBuffer) return false;
        const tlib = this.streamer._templateLibrary;
        const ab = tlib?.getAnchorBuffer?.(), tib = tlib?.getTemplateInfoBuffer?.();
        if (!ab || !tib) return false;
        const mk = (treeBuf,leafBuf,ctrBuf,label) =>
            this.device.createBindGroup({label, layout:this._scatterBGL, entries:[
                {binding:0,resource:{buffer:ls._paramBuffer}},
                {binding:1,resource:{buffer:treeBuf}},
                {binding:2,resource:{buffer:this._oneCountBuffer}},
                {binding:3,resource:{buffer:leafBuf}},
                {binding:4,resource:{buffer:ctrBuf}},
                {binding:5,resource:{buffer:ab}},
                {binding:6,resource:{buffer:tib}},
            ]});
        this._overlayScatterBG = mk(this._overlayTreeBuffer,this._overlayLeafBuffer,
            this._overlayCounterBuffer,'LODTest-OvScatterBG');
        this._refScatterBG = mk(this._refTreeBuffer,this._refLeafBuffer,
            this._refCounterBuffer,'LODTest-RefScatterBG');
        this._testScatterBG = mk(this._overlayTreeBuffer,this._testLeafBuffer,
            this._testCounterBuffer,'LODTest-TestScatterBG');
        this._scatterBGDirty = false;
        return true;
    }

    _rebuildDrawArgsBGs() {
        if (!this._drawArgsBGDirty) return true;
        const mk = (treeBuf,argsBuf,label) =>
            this.device.createBindGroup({label,layout:this._drawArgsBGL, entries:[
                {binding:0,resource:{buffer:treeBuf}},
                {binding:1,resource:{buffer:argsBuf}},
            ]});
        this._overlayDrawArgsBG = mk(this._overlayTreeBuffer,this._overlayDrawArgsBuffer,'LODTest-OvDrawArgsBG');
        this._refDrawArgsBG     = mk(this._refTreeBuffer,this._refDrawArgsBuffer,'LODTest-RefDrawArgsBG');
        this._testDrawArgsBG    = mk(this._overlayTreeBuffer,this._testDrawArgsBuffer,'LODTest-TestDrawArgsBG');
        this._drawArgsBGDirty = false;
        return true;
    }

    _rebuildRenderBGs() {
        if (!this._renderBGsDirty) return true;
        const s = this.streamer;
        if (!s._uniformBuffer||!s._fragUniformBuffer) return false;
        const mb = s._leafMaskBaker;
        if (!mb?.isReady()) return false;
        const mv = mb.getTextureView(), ms = mb.getSampler();
        if (!mv||!ms) return false;
        const mkBGs = (leafBuf,label) => {
            const g0 = this.device.createBindGroup({label:`${label}-G0`,layout:this._renderBGLs[0],
                entries:[{binding:0,resource:{buffer:s._uniformBuffer}},
                         {binding:1,resource:{buffer:leafBuf}}]});
            const g1 = this.device.createBindGroup({label:`${label}-G1`,layout:this._renderBGLs[1],
                entries:[{binding:0,resource:{buffer:s._fragUniformBuffer}},
                         {binding:1,resource:mv},{binding:2,resource:ms}]});
            return [g0,g1];
        };
        this._overlayRenderBGs = mkBGs(this._overlayLeafBuffer,'LODTest-Ov');
        this._refRenderBGs     = mkBGs(this._refLeafBuffer,'LODTest-Ref');
        this._testRenderBGs    = mkBGs(this._testLeafBuffer,'LODTest-Test');
        this._renderBGsDirty = false;
        return true;
    }

    // ══════════════════════════════════════════════════════════════════════
    // Update (compute passes)
    // ══════════════════════════════════════════════════════════════════════

    update(commandEncoder, camera) {
        if (!this._initialized || this._state === S_IDLE) return;

        // ── Capture: waiting for submit ──────────────────────────────
        if (this._state === S_CAP_AWAIT_SUBMIT) {
            this._framesSinceSubmit++;
            if (this._framesSinceSubmit >= 1) this._state = S_CAP_AWAIT_READ;
            return;
        }
        if (this._state === S_CAP_AWAIT_READ) {
            this._initiateReadback();
            this._state = S_CAP_READING;
            return;
        }
        if (this._state === S_CAP_READING) return;

        // ── Locking: find closest, lock, then fall through to LOCKED ─
        if (this._state === S_LOCKING) {
            if (!this._rebuildFindAndLockBG()) {
                Logger.warn('[LeafLODTestSuite] Missing resources for lock'); 
                this._state = S_IDLE; return;
            }
            const p = commandEncoder.beginComputePass({label:'LODTest-FindLock'});
            p.setPipeline(this._findAndLockPipeline);
            p.setBindGroup(0,this._findAndLockBG);
            p.dispatchWorkgroups(1);
            p.end();
            this._state = S_LOCKED;
            // Fall through to run overlay in same frame
        }

        // ── Locked / Capturing: update overlay each frame ────────────
        if (this._state === S_LOCKED || this._state === S_CAPTURING) {
            if (!this._rebuildUpdateOverlayBG()||!this._rebuildScatterBGs()
                ||!this._rebuildDrawArgsBGs()) return;

            this.device.queue.writeBuffer(this._overlayCounterBuffer,0,new Uint32Array([0]));

            // Update overlay tree from current CloseTreeBuffer
            {const p=commandEncoder.beginComputePass({label:'LODTest-UpdOverlay'});
             p.setPipeline(this._updateOverlayPipeline);
             p.setBindGroup(0,this._updateOverlayBG);
             p.dispatchWorkgroups(1); p.end();}

            // Scatter overlay leaves
            {const p=commandEncoder.beginComputePass({label:'LODTest-OvScatter'});
             p.setPipeline(this._scatterPipeline);
             p.setBindGroup(0,this._overlayScatterBG);
             p.dispatchWorkgroups(1); p.end();}

            // Overlay draw args
            {const p=commandEncoder.beginComputePass({label:'LODTest-OvDrawArgs'});
             p.setPipeline(this._drawArgsPipeline);
             p.setBindGroup(0,this._overlayDrawArgsBG);
             p.dispatchWorkgroups(1); p.end();}
        }

        // ── Capturing: also scatter ref + test for diagnostics ───────
        if (this._state === S_CAPTURING) {
            this.device.queue.writeBuffer(this._refCounterBuffer,0,new Uint32Array([0]));
            this.device.queue.writeBuffer(this._testCounterBuffer,0,new Uint32Array([0]));

            // Scatter ref (current LOD)
            {const p=commandEncoder.beginComputePass({label:'LODTest-RefScatter'});
             p.setPipeline(this._scatterPipeline);
             p.setBindGroup(0,this._refScatterBG);
             p.dispatchWorkgroups(1); p.end();}
            // Scatter test (LOD+1, same tree as overlay)
            {const p=commandEncoder.beginComputePass({label:'LODTest-TestScatter'});
             p.setPipeline(this._scatterPipeline);
             p.setBindGroup(0,this._testScatterBG);
             p.dispatchWorkgroups(1); p.end();}
            // Ref + test draw args
            {const p=commandEncoder.beginComputePass({label:'LODTest-RefDrawArgs'});
             p.setPipeline(this._drawArgsPipeline);
             p.setBindGroup(0,this._refDrawArgsBG);
             p.dispatchWorkgroups(1); p.end();}
            {const p=commandEncoder.beginComputePass({label:'LODTest-TestDrawArgs'});
             p.setPipeline(this._drawArgsPipeline);
             p.setBindGroup(0,this._testDrawArgsBG);
             p.dispatchWorkgroups(1); p.end();}

            this._state = S_CAP_ENCODED;
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // Overlay render (in main render pass)
    // ══════════════════════════════════════════════════════════════════════

    renderOverlay(renderPassEncoder) {
        if (this._state !== S_LOCKED && this._state !== S_CAPTURING
            && this._state !== S_CAP_ENCODED) return;
        if (!this._rebuildRenderBGs()) return;
        if (this._overlayRenderBGs.length === 0) return;

        renderPassEncoder.setPipeline(this._overlayRenderPipeline);
        for (let i=0;i<this._overlayRenderBGs.length;i++)
            renderPassEncoder.setBindGroup(i,this._overlayRenderBGs[i]);
        renderPassEncoder.setVertexBuffer(0,this._quadPosBuffer);
        renderPassEncoder.setVertexBuffer(1,this._quadNormBuffer);
        renderPassEncoder.setVertexBuffer(2,this._quadUVBuffer);
        renderPassEncoder.setIndexBuffer(this._quadIdxBuffer,'uint16');
        renderPassEncoder.drawIndexedIndirect(this._overlayDrawArgsBuffer,0);
    }

    // ══════════════════════════════════════════════════════════════════════
    // Diagnostic render + copy (separate RTs, called when CAP_ENCODED)
    // ══════════════════════════════════════════════════════════════════════

    renderDiagnosticAndCopy(commandEncoder) {
        if (this._state !== S_CAP_ENCODED) return;
        if (!this._rebuildRenderBGs()) {this._state=S_IDLE;return;}

        const sz = TEST_RT_SIZE;
        this._renderLeafPass(commandEncoder,this._refColorView,this._refDepthView,
            this._refRenderBGs,this._refDrawArgsBuffer,this._diagRenderPipeline,'LODTest-RefRender');
        this._renderLeafPass(commandEncoder,this._testColorView,this._testDepthView,
            this._testRenderBGs,this._testDrawArgsBuffer,this._diagRenderPipeline,'LODTest-TestRender');

        const bpr = sz * PIXEL_BYTES;
        commandEncoder.copyTextureToBuffer({texture:this._refColorTex},
            {buffer:this._refReadbackBuffer,bytesPerRow:bpr},{width:sz,height:sz});
        commandEncoder.copyTextureToBuffer({texture:this._testColorTex},
            {buffer:this._testReadbackBuffer,bytesPerRow:bpr},{width:sz,height:sz});
        commandEncoder.copyBufferToBuffer(this._overlayStatusBuffer,0,
            this._overlayStatusReadbackBuffer,0,16);
        commandEncoder.copyBufferToBuffer(this._refCounterBuffer,0,
            this._refCounterReadbackBuffer,0,4);
        commandEncoder.copyBufferToBuffer(this._testCounterBuffer,0,
            this._testCounterReadbackBuffer,0,4);

        this._state = S_CAP_AWAIT_SUBMIT;
        this._framesSinceSubmit = 0;
    }

    _renderLeafPass(enc,colorView,depthView,bgs,drawArgs,pipeline,label) {
        const pass = enc.beginRenderPass({label, colorAttachments:[{
            view:colorView,clearValue:{r:0,g:0,b:0,a:0},
            loadOp:'clear',storeOp:'store'}],
            depthStencilAttachment:{view:depthView,depthClearValue:1.0,
            depthLoadOp:'clear',depthStoreOp:'store'}});
        pass.setViewport(0,0,TEST_RT_SIZE,TEST_RT_SIZE,0,1);
        pass.setPipeline(pipeline);
        for (let i=0;i<bgs.length;i++) pass.setBindGroup(i,bgs[i]);
        pass.setVertexBuffer(0,this._quadPosBuffer);
        pass.setVertexBuffer(1,this._quadNormBuffer);
        pass.setVertexBuffer(2,this._quadUVBuffer);
        pass.setIndexBuffer(this._quadIdxBuffer,'uint16');
        pass.drawIndexedIndirect(drawArgs,0);
        pass.end();
    }

    // ══════════════════════════════════════════════════════════════════════
    // Async readback + metrics
    // ══════════════════════════════════════════════════════════════════════

    async _initiateReadback() {
        try {
            await Promise.all([
                this._refReadbackBuffer.mapAsync(GPUMapMode.READ),
                this._testReadbackBuffer.mapAsync(GPUMapMode.READ),
                this._overlayStatusReadbackBuffer.mapAsync(GPUMapMode.READ),
                this._refCounterReadbackBuffer.mapAsync(GPUMapMode.READ),
                this._testCounterReadbackBuffer.mapAsync(GPUMapMode.READ),
            ]);
            const px = TEST_RT_SIZE*TEST_RT_SIZE;
            const ref  = new Uint8Array(this._refReadbackBuffer.getMappedRange().slice(0));
            const test = new Uint8Array(this._testReadbackBuffer.getMappedRange().slice(0));
            const st   = new Uint32Array(this._overlayStatusReadbackBuffer.getMappedRange().slice(0));
            const rc   = new Uint32Array(this._refCounterReadbackBuffer.getMappedRange().slice(0));
            const tc   = new Uint32Array(this._testCounterReadbackBuffer.getMappedRange().slice(0));
            this._refReadbackBuffer.unmap();
            this._testReadbackBuffer.unmap();
            this._overlayStatusReadbackBuffer.unmap();
            this._refCounterReadbackBuffer.unmap();
            this._testCounterReadbackBuffer.unmap();
            this._processResults(ref,test,st,rc,tc,px);
        } catch(e) {
            Logger.error(`[LeafLODTestSuite] Readback failed: ${e.message}`);
        } finally {
            this._state = S_IDLE;
            Logger.info('[LeafLODTestSuite] Tree deselected');
        }
    }

    _processResults(refData,testData,st,rc,tc,pixelCount) {
        const found=st[0], band=st[1], ovActive=st[2], treeCount=st[3];
        const refLeaves=rc[0], testLeaves=tc[0];
        this._sampleCount++;
        const bar = '═'.repeat(60);
        console.log(bar);
        console.log(`[LeafLODTestSuite] Sample #${this._sampleCount}`);
        console.log(`  Trees in range: ${treeCount}  |  Found locked: ${found?'yes':'NO'}`);
        console.log(`  Current band: L${band}  |  Overlay active: ${ovActive?'yes':'no'}`);
        console.log(`  Ref leaves: ${refLeaves}  |  Test leaves: ${testLeaves}`);

        if (!found) {
            console.warn('  ⚠ Locked tree left detail range. No metrics.');
            console.log(bar); return;
        }
        if (!ovActive) {
            console.warn(`  ⚠ Tree at coarsest band (L${band}). Deselected only.`);
            console.log(bar); return;
        }

        const m = this._computeMetrics(refData,testData,pixelCount);
        console.log(`  LOD transition: L${band} → L${band+1}`);
        console.log(`  Ref coverage px: ${m.refCov}  |  Test coverage px: ${m.testCov}`);
        console.log(`  ────────────────────────────────────────────`);
        console.log(`  Soft IoU (shape):            ${m.softIoU.toFixed(6)}`);
        console.log(`  Premultiplied MAE (shading): ${m.softMAE.toFixed(6)}`);
        console.log(bar);
        if (m.refCov===0&&m.testCov===0)
            console.warn('  ⚠ Zero coverage — scatter may not have produced leaves');
    }

    _computeMetrics(ref,test,n) {
        let sI=0,sU=0,cE=0,sMA=0,rC=0,tC=0;
        for(let i=0;i<n;i++){
            const b=i*4;
            const ar=ref[b+3]/255, at=test[b+3]/255;
            const minA=Math.min(ar,at), maxA=Math.max(ar,at);
            sI+=minA; sU+=maxA; sMA+=maxA;
            cE+=(Math.abs(ref[b]-test[b])+Math.abs(ref[b+1]-test[b+1])
                +Math.abs(ref[b+2]-test[b+2]))/765;
            if(ar>0.004) rC++; if(at>0.004) tC++;
        }
        return {softIoU:sU>0?sI/sU:1, softMAE:sMA>0?cE/sMA:0,
                refCov:rC, testCov:tC, unionPx:Math.round(sU)};
    }
}