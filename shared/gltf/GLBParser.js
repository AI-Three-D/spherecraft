// js/assets/gltf/GLBParser.js
// Parses the .glb container, decodes accessors, and logs a summary.

import { Logger } from '../Logger.js';

const GLB_MAGIC       = 0x46546C67; // 'glTF'
const CHUNK_TYPE_JSON = 0x4E4F534A; // 'JSON'
const CHUNK_TYPE_BIN  = 0x004E4942; // 'BIN\0'

// componentType → { name, bytes, ArrayCtor }
const COMPONENT_TYPES = {
    5120: { name: 'BYTE',           bytes: 1, Array: Int8Array    },
    5121: { name: 'UNSIGNED_BYTE',  bytes: 1, Array: Uint8Array   },
    5122: { name: 'SHORT',          bytes: 2, Array: Int16Array   },
    5123: { name: 'UNSIGNED_SHORT', bytes: 2, Array: Uint16Array  },
    5125: { name: 'UNSIGNED_INT',   bytes: 4, Array: Uint32Array  },
    5126: { name: 'FLOAT',          bytes: 4, Array: Float32Array },
};

const TYPE_NUM_COMPONENTS = {
    SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4,
    MAT2: 4, MAT3: 9, MAT4: 16,
};

export class GLBParser {
    constructor(options = {}) {
        this.verbose = options.verbose !== false;
    }

    // ---------------------------------------------------------------------
    // Container
    // ---------------------------------------------------------------------

    /** Parse a .glb ArrayBuffer → { json, bin }. */
    parse(arrayBuffer) {
        const dv = new DataView(arrayBuffer);
        let off = 0;

        const magic   = dv.getUint32(off, true); off += 4;
        const version = dv.getUint32(off, true); off += 4;
        const length  = dv.getUint32(off, true); off += 4;

        if (magic !== GLB_MAGIC) {
            throw new Error(`[GLBParser] Bad magic 0x${magic.toString(16)} (expected 0x46546C67)`);
        }
        if (version !== 2) {
            throw new Error(`[GLBParser] Unsupported version ${version} (only glTF 2.0)`);
        }
        if (this.verbose) {
            Logger.info(`[GLBParser] header magic=glTF version=${version} length=${length}`);
        }

        let json = null;
        let bin  = null;

        while (off < length) {
            const chunkLen  = dv.getUint32(off, true); off += 4;
            const chunkType = dv.getUint32(off, true); off += 4;
            const chunkData = new Uint8Array(arrayBuffer, off, chunkLen);
            off += chunkLen;

            if (chunkType === CHUNK_TYPE_JSON) {
                json = JSON.parse(new TextDecoder('utf-8').decode(chunkData));
                if (this.verbose) Logger.info(`[GLBParser] JSON chunk ${chunkLen} bytes`);
            } else if (chunkType === CHUNK_TYPE_BIN) {
                bin = chunkData;
                if (this.verbose) Logger.info(`[GLBParser] BIN  chunk ${chunkLen} bytes`);
            } else if (this.verbose) {
                Logger.info(`[GLBParser] skip chunk type=0x${chunkType.toString(16)} len=${chunkLen}`);
            }
        }

        if (!json) throw new Error('[GLBParser] Missing JSON chunk');

        this._dumpSummary(json);
        return { json, bin };
    }

    _dumpSummary(json) {
        if (!this.verbose) return;
        const n = (k) => json[k]?.length ?? 0;
        Logger.info(
            `[GLBParser] summary scenes=${n('scenes')} nodes=${n('nodes')} ` +
            `meshes=${n('meshes')} skins=${n('skins')} animations=${n('animations')} ` +
            `materials=${n('materials')} textures=${n('textures')} images=${n('images')} ` +
            `accessors=${n('accessors')} bufferViews=${n('bufferViews')}`
        );

        (json.meshes || []).forEach((m, i) => {
            Logger.info(`[GLBParser]  mesh[${i}] "${m.name ?? ''}" primitives=${m.primitives.length}`);
            m.primitives.forEach((p, j) => {
                const attrs = Object.keys(p.attributes).join(',');
                Logger.info(`[GLBParser]    prim[${j}] attrs=[${attrs}] indices=${p.indices ?? '-'} material=${p.material ?? '-'} mode=${p.mode ?? 4}`);
            });
        });

        (json.skins || []).forEach((s, i) =>
            Logger.info(`[GLBParser]  skin[${i}] "${s.name ?? ''}" joints=${s.joints.length} ibm=${s.inverseBindMatrices ?? '-'}`)
        );

        (json.animations || []).forEach((a, i) =>
            Logger.info(`[GLBParser]  anim[${i}] "${a.name ?? ''}" channels=${a.channels.length} samplers=${a.samplers.length}`)
        );

        (json.accessors || []).forEach((a, i) => {
            const ct = COMPONENT_TYPES[a.componentType]?.name ?? a.componentType;
            Logger.info(`[GLBParser]  accessor[${i}] ${a.type}<${ct}> count=${a.count} bv=${a.bufferView ?? '-'} off=${a.byteOffset ?? 0}`);
        });
    }

    // ---------------------------------------------------------------------
    // Accessor decoding (static helpers)
    // ---------------------------------------------------------------------

    /**
     * Read an accessor into a flat typed array.
     * Interleaved bufferViews are de‑interleaved. Misaligned views are copied.
     * Sparse/Draco not supported.
     */
    static readAccessor(json, bin, accessorIndex) {
        const acc  = json.accessors[accessorIndex];
        const comp = COMPONENT_TYPES[acc.componentType];
        const numC = TYPE_NUM_COMPONENTS[acc.type];
        const n    = acc.count;

        if (!comp) throw new Error(`[GLBParser] Unknown componentType ${acc.componentType}`);
        if (acc.sparse) throw new Error('[GLBParser] Sparse accessors not supported');

        if (acc.bufferView === undefined) {
            return new comp.Array(n * numC); // zero‑filled per spec
        }

        const bv       = json.bufferViews[acc.bufferView];
        const baseOff  = (bv.byteOffset || 0) + (acc.byteOffset || 0);
        const elemSize = comp.bytes * numC;
        const stride   = bv.byteStride || elemSize;
        const absOff   = bin.byteOffset + baseOff;

        if (stride === elemSize) {
            // Tightly packed
            if (absOff % comp.bytes === 0) {
                return new comp.Array(bin.buffer, absOff, n * numC);
            }
            // Misaligned → copy
            const slice = bin.slice(baseOff, baseOff + n * elemSize);
            return new comp.Array(slice.buffer, slice.byteOffset, n * numC);
        }

        // Interleaved → de‑interleave
        const out = new comp.Array(n * numC);
        const dv  = new DataView(bin.buffer, bin.byteOffset);
        const rd  = GLBParser._reader(comp.name);
        for (let i = 0; i < n; i++) {
            const row = baseOff + i * stride;
            for (let c = 0; c < numC; c++) {
                out[i * numC + c] = rd(dv, row + c * comp.bytes);
            }
        }
        return out;
    }

    static _reader(name) {
        switch (name) {
            case 'BYTE':           return (dv, o) => dv.getInt8(o);
            case 'UNSIGNED_BYTE':  return (dv, o) => dv.getUint8(o);
            case 'SHORT':          return (dv, o) => dv.getInt16(o, true);
            case 'UNSIGNED_SHORT': return (dv, o) => dv.getUint16(o, true);
            case 'UNSIGNED_INT':   return (dv, o) => dv.getUint32(o, true);
            case 'FLOAT':          return (dv, o) => dv.getFloat32(o, true);
        }
    }

    static accessorInfo(json, i) {
        const a = json.accessors[i];
        const c = COMPONENT_TYPES[a.componentType];
        return {
            componentType: a.componentType,
            componentName: c.name,
            componentBytes: c.bytes,
            type: a.type,
            numComponents: TYPE_NUM_COMPONENTS[a.type],
            count: a.count,
            normalized: a.normalized === true,
            min: a.min ?? null,
            max: a.max ?? null,
        };
    }
}