// js/actors/config/ModelDescriptor.js
//
// One per unique .glb. Resolves engine AnimationId → clip by exact
// name from JSON (replaces ANIMATION_NAME_PATTERNS). Builds RootMotion
// helpers upfront at load time.

import { Logger } from '../../../shared/Logger.js';
import { RootMotion } from '../../../shared/gltf/RootMotion.js';
import { AnimationId } from '../ActorState.js';

function resolveDescriptorBaseUrl(requestUrl, responseUrl = '') {
    if (responseUrl) return responseUrl;
    return new URL(requestUrl, document.baseURI).href;
}

export class ModelDescriptor {
    constructor(json, asset, sourceUrl = '') {
        this.asset = asset;
        this.glbUrl = json.glb;
        this.yawOffset = (json.yawOffsetDeg ?? 0) * Math.PI / 180;
        this.blendDefaults = {
            in:  json.blendDefaults?.in  ?? 0.15,
            out: json.blendDefaults?.out ?? 0.15,
        };

        // Root-motion node
        this._rootIdx = -1;
        this._rootMask = json.rootMotion?.mask ?? { x: true, y: false, z: true };
        if (json.rootMotion?.nodeName) {
            this._rootIdx = asset.nodes.findIndex(n => n.name === json.rootMotion.nodeName);
            if (this._rootIdx < 0) {
                Logger.warn(
                    `[ModelDescriptor] root node "${json.rootMotion.nodeName}" ` +
                    `not in ${sourceUrl} — available: ` +
                    asset.nodes.slice(0, 8).map(n => `"${n.name}"`).join(', ') +
                    (asset.nodes.length > 8 ? ` …(${asset.nodes.length - 8} more)` : '')
                );
            }
        }
        const bindT = this._rootIdx >= 0 ? asset.nodes[this._rootIdx].translation : [0,0,0];

        // Clip table
        this._clips = new Map();
        for (const [idName, def] of Object.entries(json.animations || {})) {
            const id = AnimationId[idName];
            if (id === undefined) {
                Logger.warn(`[ModelDescriptor] unknown AnimationId "${idName}" in ${sourceUrl}`);
                continue;
            }
            const idx = asset.animations.findIndex(a => a.name === def.clip);
            if (idx < 0) {
                Logger.warn(`[ModelDescriptor] clip "${def.clip}" not found in ${sourceUrl}`);
                continue;
            }
            const anim = asset.animations[idx];
        
            // Build RootMotion for every clip when the model has a root node.
            // Used for stripping only — delta is never consumed.
            let rootMotion = null;
            if (this._rootIdx >= 0) {
                const rm = new RootMotion(anim, this._rootIdx, bindT, this._rootMask);
                // valid is true only if the clip actually has a translation channel
                // on the root node. If not, nothing to strip.
                if (rm.valid) rootMotion = rm;
            }
        
            this._clips.set(id, {
                anim, index: idx,
                loop: def.loop ?? false,
                blendIn: def.blendIn ?? null,
                rootMotion,    // always set when strippable, regardless of def.rootMotion
            });
        }
        Logger.info(
            `[ModelDescriptor] ${sourceUrl}: ${this._clips.size}/${asset.animations.length} clips, ` +
            `root=${this._rootIdx >= 0 ? asset.nodes[this._rootIdx].name : 'none'}`
        );
    }

    clip(id) { return this._clips.get(id) ?? null; }
    has(id)  { return this._clips.has(id); }

    static async load(url, gltfLoader) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`[ModelDescriptor] fetch ${url} → ${res.status}`);
        const json = await res.json();
        const descriptorUrl = resolveDescriptorBaseUrl(url, res.url);
        const glbUrl = new URL(json.glb, descriptorUrl).href;
        const asset = await gltfLoader.loadFromURL(glbUrl);
        return new ModelDescriptor(json, asset, descriptorUrl);
    }
}
