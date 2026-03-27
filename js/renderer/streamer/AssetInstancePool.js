// js/renderer/streamer/AssetInstancePool.js
//
// GPU buffer pool for streamed asset instances.
//
// ═══ INC 2: bandDescriptors constructor ════════════════════════════════════
//
//   OLD: (device, number[][] maxInstancesPerCategory) — category-indexed,
//        internally expanded to TOTAL_BANDS via LODS_PER_CATEGORY.
//   NEW: (device, BandDescriptor[]) — flat list, one entry per band, already
//        in final order. Registry.computeBandDescriptors() produces it.
//
//   Public API is UNCHANGED. getBandCapacity(0..4) / getBandBase(0..4) still
//   return tree-band values because tree_standard is archetype 0 → bands 0-4.
//   TreeDetailSystem._buildSourceBands keeps working.
//
// Instance layout: 64 bytes.

import { Logger } from '../../config/Logger.js';

const INSTANCE_BYTES = 64;

export class AssetInstancePool {
    /**
     * @param {GPUDevice} device
     * @param {Array<{capacity:number}>} bandDescriptors
     *        Ordered 0..bandCount-1. Only `.capacity` is consumed here;
     *        the rest of each descriptor (archetypeIndex, lod, etc.) is
     *        metadata for AssetStreamer's render loop.
     */
    constructor(device, bandDescriptors) {
        this.device = device;

        const bc = bandDescriptors.length;
        this._bandCount = bc;

        this._bandCapacity = new Uint32Array(bc);
        this._bandBase     = new Uint32Array(bc);
        let offset = 0;
        for (let i = 0; i < bc; i++) {
            const cap = (bandDescriptors[i]?.capacity ?? 0) >>> 0;
            this._bandCapacity[i] = cap;
            this._bandBase[i]     = offset;
            offset += cap;
        }
        this._totalCapacity = offset;

        // Preallocate once; resetCounters is per-scatter.
        this._zeroCounters = new Uint32Array(bc);

        // ── Instance storage ──────────────────────────────────────────────
        const instBytes = Math.max(256, this._totalCapacity * INSTANCE_BYTES);
        this._instanceBuffer = device.createBuffer({
            label: 'Asset-InstancePool',
            size: instBytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX
                 | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });

        // ── Indirect draw args: bands × 5 u32 ─────────────────────────────
        this._indirectBuffer = device.createBuffer({
            label: 'Asset-IndirectArgs',
            size: Math.max(256, bc * 5 * 4),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT
                 | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });

        // ── Per-band atomic counters ──────────────────────────────────────
        this._counterBuffer = device.createBuffer({
            label: 'Asset-Counters',
            size: Math.max(256, bc * 4),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
                 | GPUBufferUsage.COPY_SRC,
        });

        // ── Band metadata uniform: [base, cap, 0, 0] × bands ──────────────
        // 16-byte stride for std140. 35 bands × 16B = 560B; well under
        // the ~64KB uniform limit.
        this._bandMetaBuffer = device.createBuffer({
            label: 'Asset-BandMeta',
            size: Math.max(256, bc * 16),
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this._uploadBandMeta();

        Logger.info(
            `[AssetInstancePool] bands=${bc}, totalCap=${this._totalCapacity}, ` +
            `instBuf=${(instBytes / 1024).toFixed(0)}KB`
        );
    }

    get instanceBuffer() { return this._instanceBuffer; }
    get indirectBuffer() { return this._indirectBuffer; }
    get counterBuffer()  { return this._counterBuffer; }
    get bandMetaBuffer() { return this._bandMetaBuffer; }
    get totalCapacity()  { return this._totalCapacity; }
    get bandCount()      { return this._bandCount; }

    getBandBase(band)       { return this._bandBase[band] ?? 0; }
    getBandCapacity(band)   { return this._bandCapacity[band] ?? 0; }
    getIndirectOffset(band) { return band * 5 * 4; }

    resetCounters() {
        this.device.queue.writeBuffer(this._counterBuffer, 0, this._zeroCounters);
    }

    _uploadBandMeta() {
        const bc = this._bandCount;
        const data = new Uint32Array(bc * 4);
        for (let i = 0; i < bc; i++) {
            data[i * 4]     = this._bandBase[i];
            data[i * 4 + 1] = this._bandCapacity[i];
            // [2,3] stay 0
        }
        this.device.queue.writeBuffer(this._bandMetaBuffer, 0, data);
    }

    dispose() {
        this._instanceBuffer?.destroy();
        this._indirectBuffer?.destroy();
        this._counterBuffer?.destroy();
        this._bandMetaBuffer?.destroy();
    }
}
