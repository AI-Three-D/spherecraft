// js/actors/config/CharacterDescriptor.js

import { ModelDescriptor } from './ModelDescriptor.js';

function resolveDescriptorBaseUrl(requestUrl, responseUrl = '') {
    if (responseUrl) return responseUrl;
    return new URL(requestUrl, document.baseURI).href;
}

export class CharacterDescriptor {
    constructor(json, model) {
        this.model = model;
        this.scale            = json.scale            ?? 1.0;
        this.moveSpeed        = json.moveSpeed        ?? 4.0;
        this.sprintMultiplier = json.sprintMultiplier ?? 1.75;
        this.collisionRadius  = json.collisionRadius  ?? 0.4;
        this.maxSlopeDeg      = json.maxSlopeDeg      ?? 45;
        this.health           = json.health           ?? 100;
        this.maxHealth        = json.maxHealth        ?? this.health;
    }

    static async load(url, gltfLoader, modelCache = null) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`[CharacterDescriptor] fetch ${url} → ${res.status}`);
        const json = await res.json();
        const descriptorUrl = resolveDescriptorBaseUrl(url, res.url);
        const modelUrl = new URL(json.model, descriptorUrl).href;

        let model = modelCache?.get(modelUrl);
        if (!model) {
            model = await ModelDescriptor.load(modelUrl, gltfLoader);
            modelCache?.set(modelUrl, model);
        }
        return new CharacterDescriptor(json, model);
    }
}
