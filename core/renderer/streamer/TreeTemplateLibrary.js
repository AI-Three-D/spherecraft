// js/renderer/streamer/TreeTemplateLibrary.js
//
// Manages the collection of tree templates and their GPU buffers.
// Provides lookup by tree type and handles GPU resource lifecycle.

import { TreeTemplate } from './TreeTemplate.js';
import { TreeTemplateGenerator } from './TreeTemplateGenerator.js';
import { Logger } from '../../../shared/Logger.js';
import { clamp } from '../../../shared/math/index.js';

/**
 * @typedef {object} TemplateGPUData
 * @property {GPUBuffer} anchorBuffer - All anchors for all templates
 * @property {GPUBuffer} familyBuffer - Per-template family descriptors
 * @property {GPUBuffer} templateInfoBuffer - Per-template metadata
 * @property {number} totalAnchors - Total anchor count
 * @property {number} totalFamilies - Total family count
 * @property {number} templateCount - Number of templates
 */

export class TreeTemplateLibrary {
    /**
     * @param {object} options
     * @param {number} [options.variantsPerType=4] - Variants per tree type
     * @param {number} [options.baseSeed=12345] - Seed for generation
     */
    constructor(options = {}) {
        if (!options.birchGenerator) {
            throw new Error('TreeTemplateLibrary requires options.birchGenerator');
        }
        this._birchGenerator = options.birchGenerator;
        this.variantsPerType = options.variantsPerType ?? 4;
        this.baseSeed = options.baseSeed ?? 12345;
        
        /** @type {Map<string, TreeTemplate[]>} - treeType → variants */
        this._byType = new Map();
        
        /** @type {TreeTemplate[]} - flat list for GPU indexing */
        this._allTemplates = [];
        
        /** @type {Map<string, number>} - templateId → index */
        this._indexById = new Map();
        
        /** @type {Map<string, number>} - treeType → first template index */
        this._typeStartIndex = new Map();
        
        // GPU resources (created on demand)
        this._device = null;
        this._anchorBuffer = null;
        this._familyBuffer = null;
        this._templateInfoBuffer = null;
        this._isUploaded = false;
        
        // Stats
        this._totalAnchors = 0;
        this._totalFamilies = 0;
        this._totalBranches = 0;
    }

    /**
     * Generate templates for specified tree types.
     * 
     * @param {string[]} treeTypes - e.g., ['birch', 'oak', 'palm']
     * @param {object} [params] - Optional per-type generation parameters
     */
    generateTemplates(treeTypes, params = {}) {
        let seed = this.baseSeed;
        
        for (const treeType of treeTypes) {
            const typeParams = params[treeType] || {};
            
            const variants = TreeTemplateGenerator.generateVariants({
                treeType,
                variantCount: this.variantsPerType,
                baseSeed: seed,
                params: typeParams,
                birchGenerator: this._birchGenerator,
            });
            
            this._typeStartIndex.set(treeType, this._allTemplates.length);
            
            for (const template of variants) {
                const validation = template.validate();
                if (!validation.valid) {
                    Logger.warn(
                        `[TreeTemplateLibrary] Template ${template.id} validation failed: ` +
                        validation.errors.join(', ')
                    );
                }
                
                this._indexById.set(template.id, this._allTemplates.length);
                this._allTemplates.push(template);
                this._totalAnchors += template.totalAnchors;
                this._totalBranches += template.totalBranches;
            }
            
            this._byType.set(treeType, variants);
            seed += 10000;
        }
        
        Logger.info(
            `[TreeTemplateLibrary] Generated ${this._allTemplates.length} templates ` +
            `(${treeTypes.length} types × ${this.variantsPerType} variants), ` +
            `${this._totalAnchors} anchors, ${this._totalBranches} branches`
        );
    }

    /**
     * Get all variants for a tree type.
     * @param {string} treeType
     * @returns {TreeTemplate[]}
     */
    getVariants(treeType) {
        return this._byType.get(treeType) || [];
    }

    /**
     * Get a specific template by id.
     * @param {string} templateId
     * @returns {TreeTemplate|null}
     */
    getById(templateId) {
        const index = this._indexById.get(templateId);
        return index !== undefined ? this._allTemplates[index] : null;
    }

    /**
     * Get template by global index.
     * @param {number} index
     * @returns {TreeTemplate|null}
     */
    getByIndex(index) {
        return this._allTemplates[index] || null;
    }

    /**
     * Get global index for a template.
     * @param {string} templateId
     * @returns {number} -1 if not found
     */
    getIndex(templateId) {
        return this._indexById.get(templateId) ?? -1;
    }

    /**
     * Get start index for a tree type's variants.
     * @param {string} treeType
     * @returns {number}
     */
    getTypeStartIndex(treeType) {
        return this._typeStartIndex.get(treeType) ?? 0;
    }

    /**
     * Select a random variant for a tree type based on seed.
     * @param {string} treeType
     * @param {number} seed - Instance-specific seed
     * @returns {number} Template global index
     */
    selectVariant(treeType, seed) {
        const startIndex = this._typeStartIndex.get(treeType);
        if (startIndex === undefined) return 0;
        
        const variants = this._byType.get(treeType);
        if (!variants || variants.length === 0) return 0;
        
        // Simple hash to select variant
        const hash = ((seed * 1664525 + 1013904223) >>> 0) % variants.length;
        return startIndex + hash;
    }

    get templateCount() { return this._allTemplates.length; }
    get totalAnchors() { return this._totalAnchors; }
    get totalFamilies() { return this._totalFamilies; }
    get totalBranches() { return this._totalBranches; }

    uploadToGPU(device) {
        if (this._isUploaded && this._device === device) return;
    
        this._device = device;
        this._disposeGPUResources();
    
        if (this._allTemplates.length === 0) {
            Logger.warn('[TreeTemplateLibrary] No templates to upload');
            return;
        }
    
        // ─── Anchor/family buffers: 48 bytes (12 words) per record ─────
        const WORDS_PER_ANCHOR = 12;
        const WORDS_PER_FAMILY = 12;
        const anchorData = new Float32Array(this._totalAnchors * WORDS_PER_ANCHOR);
        const familyRecords = [];
    
        let anchorOffset = 0;
        let familyOffset = 0;
        const templateInfos = [];
    
        for (let t = 0; t < this._allTemplates.length; t++) {
            const template = this._allTemplates[t];
            const templateAnchorData = template.toAnchorGPUData();
    
            anchorData.set(templateAnchorData, anchorOffset * WORDS_PER_ANCHOR);
    
            // Tier ranges come from canopyLODs (which bins by tier/canopyLOD).
            // Offsets are template-local; the shader adds anchorStart.
            const tiers = template.canopyLODs;
            const tier = (i) => tiers[i] || { anchorStart: 0, anchorCount: 0 };
            const families = this._buildTemplateFamilyDescriptors(template);
            for (const fam of families) {
                familyRecords.push(fam);
            }
    
            templateInfos.push({
                anchorStart:  anchorOffset,
                anchorCount:  template.totalAnchors,
                fineStart:    tier(0).anchorStart,
                fineCount:    tier(0).anchorCount,
                mediumStart:  tier(1).anchorStart,
                mediumCount:  tier(1).anchorCount,
                coarseStart:  tier(2).anchorStart,
                coarseCount:  tier(2).anchorCount,
                familyStart:  familyOffset,
                familyCount:  families.length,
            });
    
            anchorOffset += template.totalAnchors;
            familyOffset += families.length;
        }

        this._totalFamilies = familyOffset;
    
        const anchorBufferSize = Math.max(256, anchorData.byteLength);
        this._anchorBuffer = device.createBuffer({
            label: 'TreeTemplate-Anchors',
            size:  anchorBufferSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(this._anchorBuffer, 0, anchorData);

        const familyData = new Float32Array(
            Math.max(1, this._totalFamilies) * WORDS_PER_FAMILY
        );
        const familyU32 = new Uint32Array(familyData.buffer);
        for (let i = 0; i < familyRecords.length; i++) {
            const fam = familyRecords[i];
            const o = i * WORDS_PER_FAMILY;
            familyData[o + 0] = fam.posX;
            familyData[o + 1] = fam.posY;
            familyData[o + 2] = fam.posZ;
            familyData[o + 3] = fam.spread;
            familyData[o + 4] = fam.dirX;
            familyData[o + 5] = fam.dirY;
            familyData[o + 6] = fam.dirZ;
            familyData[o + 7] = fam.tipDepth;
            familyU32[o + 8]  = fam.childCount >>> 0;
            familyU32[o + 9]  = fam.seed >>> 0;
            familyU32[o + 10] = 0;
            familyU32[o + 11] = 0;
        }

        const familyBufferSize = Math.max(256, familyData.byteLength);
        this._familyBuffer = device.createBuffer({
            label: 'TreeTemplate-Families',
            size:  familyBufferSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(this._familyBuffer, 0, familyData);
    
        // ─── Template info buffer: 12 u32 (48 bytes) per template ──────
        const INFO_WORDS = 12;
        const infoData = new Uint32Array(this._allTemplates.length * INFO_WORDS);
    
        for (let t = 0; t < templateInfos.length; t++) {
            const info = templateInfos[t];
            const o = t * INFO_WORDS;
    
            infoData[o + 0] = info.anchorStart;
            infoData[o + 1] = info.anchorCount;
            infoData[o + 2] = info.fineStart;
            infoData[o + 3] = info.fineCount;
            infoData[o + 4] = info.mediumStart;
            infoData[o + 5] = info.mediumCount;
            infoData[o + 6] = info.coarseStart;
            infoData[o + 7] = info.coarseCount;
            infoData[o + 8] = info.familyStart;
            infoData[o + 9] = info.familyCount;
            // [10..11] reserved
        }
    
        const infoBufferSize = Math.max(256, infoData.byteLength);
        this._templateInfoBuffer = device.createBuffer({
            label: 'TreeTemplate-Info',
            size:  infoBufferSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(this._templateInfoBuffer, 0, infoData);
    
        this._isUploaded = true;
    
        Logger.info(
            `[TreeTemplateLibrary] Uploaded: ` +
            `anchors=${(anchorBufferSize / 1024).toFixed(1)}KB (48B/anchor), ` +
            `families=${(familyBufferSize / 1024).toFixed(1)}KB (48B/family), ` +
            `info=${(infoBufferSize / 1024).toFixed(1)}KB (48B/template), ` +
            `familyCount=${this._totalFamilies}`
        );

        // At the end of uploadToGPU():
for (let t = 0; t < this._allTemplates.length; t++) {
    const template = this._allTemplates[t];
    const families = this._buildTemplateFamilyDescriptors(template);
    
    // Analyze vertical distribution
    const yPositions = families.map(f => f.posY);
    const yMin = Math.min(...yPositions);
    const yMax = Math.max(...yPositions);
    const yMid = (yMin + yMax) / 2;
    const lowerCount = yPositions.filter(y => y < yMid).length;
    const upperCount = yPositions.filter(y => y >= yMid).length;
    
    Logger.info(
        `[Impostor] Template ${template.id}: ` +
        `${families.length} families, lower=${lowerCount}, upper=${upperCount}, ` +
        `yRange=[${yMin.toFixed(2)}..${yMax.toFixed(2)}]`
    );
}
    }

    /**
     * Get GPU buffer for anchors (read-only storage).
     * @returns {GPUBuffer|null}
     */
    getAnchorBuffer() {
        return this._anchorBuffer;
    }

    /**
     * Get GPU buffer for baked family descriptors (read-only storage).
     * @returns {GPUBuffer|null}
     */
    getFamilyBuffer() {
        return this._familyBuffer;
    }

    /**
     * Get GPU buffer for template info (read-only storage).
     * @returns {GPUBuffer|null}
     */
    getTemplateInfoBuffer() {
        return this._templateInfoBuffer;
    }

    /**
     * Check if GPU resources are ready.
     * @returns {boolean}
     */
    isReady() {
        return this._isUploaded &&
            this._anchorBuffer !== null &&
            this._familyBuffer !== null;
    }

    _buildTemplateFamilyDescriptors(template) {
        const anchors = Array.isArray(template?.anchors) ? template.anchors : [];
        const tiers = Array.isArray(template?.canopyLODs) ? template.canopyLODs : [];
        const fineTier = tiers[0] || { anchorStart: 0, anchorCount: anchors.length };
        const mediumTier = tiers[1] || { anchorStart: 0, anchorCount: 0 };

        const families = [];
        const normalizeDroop = (dir) => {
            let x = Number.isFinite(dir?.[0]) ? dir[0] : 0;
            let y = Number.isFinite(dir?.[1]) ? dir[1] : -1;
            let z = Number.isFinite(dir?.[2]) ? dir[2] : 0;
            let len = Math.hypot(x, y, z);
            if (len < 1e-5) {
                x = 0; y = -1; z = 0;
                len = 1;
            }
            x /= len; y /= len; z /= len;
            // Keep drooper families hanging; upward vectors cause conifer spokes.
            if (y > -0.08) {
                y = -0.08;
                const xzLen = Math.hypot(x, z);
                if (xzLen > 1e-5) {
                    const s = Math.sqrt(Math.max(1e-5, 1.0 - y * y)) / xzLen;
                    x *= s;
                    z *= s;
                } else {
                    x = 0;
                    z = Math.sqrt(Math.max(1e-5, 1.0 - y * y));
                }
            }
            return [x, y, z];
        };

        const pushFamily = (pos, dir, spread, tipDepth, childCount, seed) => {
            const p = Array.isArray(pos) ? pos : [0, 0, 0];
            const nDir = normalizeDroop(dir);
            families.push({
                posX: Number.isFinite(p[0]) ? p[0] : 0,
                posY: Number.isFinite(p[1]) ? p[1] : 0,
                posZ: Number.isFinite(p[2]) ? p[2] : 0,
                spread: clamp(Number.isFinite(spread) ? spread : 0.08, 0.03, 1.8),
                dirX: nDir[0],
                dirY: nDir[1],
                dirZ: nDir[2],
                tipDepth: clamp(Number.isFinite(tipDepth) ? tipDepth : 0.16, 0.08, 2.6),
                childCount: Math.max(1, childCount | 0),
                seed: seed >>> 0,
            });
        };

        const fineStart = Math.max(0, fineTier.anchorStart | 0);
        const fineEnd = Math.min(anchors.length, fineStart + Math.max(0, fineTier.anchorCount | 0));
        const mediumStart = Math.max(0, mediumTier.anchorStart | 0);
        const mediumEnd = Math.min(anchors.length, mediumStart + Math.max(0, mediumTier.anchorCount | 0));

        for (let m = mediumStart; m < mediumEnd; m++) {
            const parent = anchors[m];
            if (!parent) continue;
            const rawChildStart = parent.childStart;
            const rawChildCount = parent.childCount;
            if (!Number.isFinite(rawChildStart) || !Number.isFinite(rawChildCount)) continue;
            if ((rawChildStart >>> 0) === 0xFFFFFFFF || rawChildCount <= 0) continue;

            let cStart = rawChildStart | 0;
            let cEnd = cStart + (rawChildCount | 0);
            cStart = Math.max(cStart, fineStart, 0);
            cEnd = Math.min(cEnd, fineEnd, anchors.length);
            if (cEnd <= cStart) continue;

            const root = Array.isArray(parent.position) ? parent.position : [0, 0, 0];
            let cx = 0;
            let cy = 0;
            let cz = 0;
            let minY = Number.POSITIVE_INFINITY;
            let spreadAccum = 0;
            let spreadMax = Number.isFinite(parent.spread) ? parent.spread : 0.08;
            let childCount = 0;

            for (let c = cStart; c < cEnd; c++) {
                const child = anchors[c];
                if (!child || !Array.isArray(child.position)) continue;
                const cp = child.position;
                cx += cp[0];
                cy += cp[1];
                cz += cp[2];
                minY = Math.min(minY, cp[1]);
                const childSpread = Number.isFinite(child.spread) ? child.spread : 0.06;
                const dx = cp[0] - root[0];
                const dz = cp[2] - root[2];
                const radial = Math.hypot(dx, dz) + childSpread * 0.35;
                spreadAccum += radial;
                spreadMax = Math.max(spreadMax, radial);
                childCount++;
            }
            if (childCount === 0) continue;

            const inv = 1 / childCount;
            const centroid = [cx * inv, cy * inv, cz * inv];
            const meanSpread = spreadAccum * inv;
            const spread = Math.max(
                (Number.isFinite(parent.spread) ? parent.spread : 0.08) * 0.95,
                meanSpread * 1.12,
                spreadMax * 0.88
            );
            const tipDepth = Math.max(root[1] - minY, 0.12);
            const dirFromChildren = [
                centroid[0] - root[0],
                centroid[1] - root[1],
                centroid[2] - root[2],
            ];
            const fallbackDir = Array.isArray(parent.direction) ? parent.direction : [0, -1, 0];
            const len = Math.hypot(dirFromChildren[0], dirFromChildren[1], dirFromChildren[2]);
            const dir = len > 1e-5 ? dirFromChildren : fallbackDir;
            pushFamily(root, dir, spread, tipDepth, childCount, m);
        }

        // Species without explicit parent-child ladder still get deterministic
        // family descriptors from fine anchors (downsampled to keep budgets sane).
        if (families.length === 0 && fineEnd > fineStart) {
            const maxFallback = 96;
            const fineCount = fineEnd - fineStart;
            const step = Math.max(1, Math.floor(fineCount / maxFallback));
            for (let i = fineStart; i < fineEnd; i += step) {
                const a = anchors[i];
                if (!a) continue;
                const pos = Array.isArray(a.position) ? a.position : [0, 0, 0];
                const dir = Array.isArray(a.direction) ? a.direction : [0, -1, 0];
                const spread = (Number.isFinite(a.spread) ? a.spread : 0.06) * 1.15;
                const tipDepth = Math.max(Number.isFinite(a.density) ? a.density : 0.16, 0.12);
                pushFamily(pos, dir, spread, tipDepth, 1, i);
            }
        }

        return families;
    }

    /**
     * Build type-to-index mapping for GPU upload.
     * Returns data suitable for a uniform/storage buffer.
     * 
     * @param {Map<string, number>} geometryTypeToIndex - Mapping from asset registry
     * @returns {Uint32Array} - [startIndex, variantCount] per geometry type
     */
    buildTypeIndexMap(geometryTypeToIndex) {
        const maxTypes = Math.max(1, geometryTypeToIndex.size);
        const data = new Uint32Array(maxTypes * 2);
        
        for (const [geomType, geomIndex] of geometryTypeToIndex) {
            // Map geometry type to tree type
            const treeType = this._geometryTypeToTreeType(geomType);
            const startIndex = this._typeStartIndex.get(treeType) ?? 0;
            const variants = this._byType.get(treeType);
            const variantCount = variants?.length ?? 0;
            
            const offset = geomIndex * 2;
            if (offset + 1 < data.length) {
                data[offset] = startIndex;
                data[offset + 1] = variantCount;
            }
        }
        
        return data;
    }

    /**
     * Map geometry type string to tree type.
     * @private
     */
    _geometryTypeToTreeType(geometryType) {
        // Direct mappings
        const mappings = {
            'conifer': 'birch',
            'deciduous': 'birch',
            'deciduous_broad': 'oak',
            'deciduous_tall': 'eucalyptus',
            'palm': 'palm',
            'oak': 'oak',
            'birch': 'birch',
            'eucalyptus': 'eucalyptus'
        };
        
        return mappings[geometryType] || geometryType;
    }

    _disposeGPUResources() {
        this._anchorBuffer?.destroy();
        this._anchorBuffer = null;

        this._familyBuffer?.destroy();
        this._familyBuffer = null;
        
        this._templateInfoBuffer?.destroy();
        this._templateInfoBuffer = null;
        
        this._isUploaded = false;
    }

    dispose() {
        this._disposeGPUResources();
        this._byType.clear();
        this._allTemplates = [];
        this._indexById.clear();
        this._typeStartIndex.clear();
        this._totalAnchors = 0;
        this._totalFamilies = 0;
        this._totalBranches = 0;
    }
}
