/**
 * ParticleView — particle emitter asset editor.
 *
 * Planned features:
 *   - 3D viewport: orbit camera, ground grid, live particle preview
 *   - Left sidebar: emitter list for the current asset, add/remove emitters,
 *     per-emitter position, type mix, spawn rate
 *   - Right sidebar: selected emitter type config (color ramp, lifetime, velocity,
 *     gravity, emissive, size, spawn offset, flags)
 *   - Export/import asset as JSON
 *   - Gizmo for moving emitters in 3D (translate XZ by default)
 *
 * Wire-up:
 *   - Import ParticleSystem from core/renderer/particles/ParticleSystem.js
 *   - Import ParticleEmitter from core/renderer/particles/ParticleEmitter.js
 *   - Import particleConfig from templates/configs/particleConfig.js
 *   - Use ParticleBuffers.uploadTypeDefs() to push live edits to GPU
 *
 * TODO: wire up after HDR tone panel is working (so preview looks correct).
 */

import { StudioView } from '../StudioView.js';

const PARTICLE_TYPES = ['FIRE_CORE', 'FLAME', 'SMOKE', 'EMBER', 'COAL', 'FIREFLY'];

export class ParticleView extends StudioView {
    get usesCanvas() { return true; }

    constructor(id) {
        super(id);
        /** Currently loaded asset (group of emitters). */
        this._asset = {
            name: 'campfire',
            emitters: [
                { id: 'fire_core', position: [0, 0, 0], types: ['FIRE_CORE', 'FLAME'], spawnRate: 32 },
                { id: 'coals',     position: [0, -0.1, 0], types: ['COAL'],           spawnRate: 3  },
            ]
        };
        this._selectedEmitterId = null;
        this._selectedType      = null;
    }

    async onInit(context) {
        this._ctx = context;
        context.sidebarRightTitle.textContent = 'Type Config';
        this._buildLeftSidebar(context.sidebarLeft);
        this._buildRightSidebar(context.sidebarRight);
    }

    async onActivate() {
        // TODO: init WebGPU backend on context.canvas
        // TODO: create ParticleSystem, load asset emitters, start orbit camera
        this.setExtraStatus('<span class="label">Particles</span> <span class="value">—</span>');
        console.log('[ParticleView] activated');
    }

    onDeactivate() {
        // TODO: pause particle simulation
    }

    onUpdate(_dt, _t) {
        // TODO: tick ParticleSystem, orbit camera, render
    }

    // ── Left sidebar — emitter list ───────────────────────────────────

    _buildLeftSidebar(container) {
        const assetSec = this._addSection(container, 'Asset');

        // Asset name
        const nameRow = document.createElement('div');
        nameRow.style.cssText = 'padding:4px 12px; display:flex; gap:8px; align-items:center;';
        const nameInput = document.createElement('input');
        nameInput.type  = 'text';
        nameInput.value = this._asset.name;
        nameInput.style.cssText = `
            flex:1; background:var(--bg-hover); border:1px solid var(--border);
            color:var(--text); font-size:11px; padding:3px 6px; border-radius:3px;
        `;
        nameInput.addEventListener('change', () => { this._asset.name = nameInput.value; });
        nameRow.appendChild(nameInput);
        assetSec.appendChild(nameRow);

        // Import / export
        this._addButton(assetSec, 'Export Asset JSON', () => this._exportJSON());
        this._addButton(assetSec, 'Load Asset JSON…',  () => this._importJSON());

        // Emitter list
        const emitterSec = this._addSection(container, 'Emitters');
        this._emitterListEl = emitterSec;
        this._refreshEmitterList();

        this._addButton(container.parentElement ?? container, '+ Add Emitter', () => {
            this._addEmitter();
        });
    }

    _refreshEmitterList() {
        const el = this._emitterListEl;
        if (!el) return;
        el.innerHTML = '';
        for (const emitter of this._asset.emitters) {
            const row = document.createElement('div');
            row.style.cssText = `
                display:flex; align-items:center; gap:6px; padding:4px 12px;
                cursor:pointer; border-radius:3px;
                background: ${emitter.id === this._selectedEmitterId ? 'var(--accent-active)' : 'transparent'};
            `;
            const dot = document.createElement('span');
            dot.textContent = emitter.id === this._selectedEmitterId ? '●' : '○';
            dot.style.color = 'var(--accent)';

            const label = document.createElement('span');
            label.textContent = emitter.id;
            label.style.cssText = 'font-size:11px; flex:1;';

            const del = document.createElement('button');
            del.textContent = '×';
            del.style.cssText = `
                background:none; border:none; color:var(--text-dim);
                cursor:pointer; font-size:13px; padding:0 2px; line-height:1;
            `;
            del.addEventListener('click', (e) => {
                e.stopPropagation();
                this._removeEmitter(emitter.id);
            });

            row.appendChild(dot);
            row.appendChild(label);
            row.appendChild(del);
            row.addEventListener('click', () => this._selectEmitter(emitter.id));
            el.appendChild(row);
        }
    }

    _selectEmitter(id) {
        this._selectedEmitterId = id;
        this._refreshEmitterList();
        this._refreshRightSidebar();
    }

    _addEmitter() {
        const id = `emitter_${this._asset.emitters.length + 1}`;
        this._asset.emitters.push({ id, position: [0, 0, 0], types: ['FLAME'], spawnRate: 8 });
        this._refreshEmitterList();
        this._selectEmitter(id);
        // TODO: add emitter to live ParticleSystem
    }

    _removeEmitter(id) {
        this._asset.emitters = this._asset.emitters.filter(e => e.id !== id);
        if (this._selectedEmitterId === id) this._selectedEmitterId = null;
        this._refreshEmitterList();
        this._refreshRightSidebar();
        // TODO: remove from live ParticleSystem
    }

    // ── Right sidebar — type config ───────────────────────────────────

    _buildRightSidebar(container) {
        this._rightContainer = container;
        this._refreshRightSidebar();
    }

    _refreshRightSidebar() {
        const container = this._rightContainer;
        if (!container) return;
        container.innerHTML = '';

        const emitter = this._asset.emitters.find(e => e.id === this._selectedEmitterId);
        if (!emitter) {
            const msg = document.createElement('div');
            msg.style.cssText = 'padding:16px 12px; color:var(--text-dim); font-size:11px;';
            msg.textContent   = 'Select an emitter from the left panel.';
            container.appendChild(msg);
            return;
        }

        // Position
        const posSec = this._addSection(container, 'Position');
        ['x', 'y', 'z'].forEach((axis, i) => {
            this._addSlider(posSec, {
                label: axis.toUpperCase(), min: -10, max: 10, step: 0.01,
                value: emitter.position[i] ?? 0,
                onChange: v => {
                    emitter.position[i] = v;
                    // TODO: update live emitter transform
                }
            });
        });

        // Spawn
        const spawnSec = this._addSection(container, 'Spawn');
        this._addSlider(spawnSec, {
            label: 'Rate / frame', min: 1, max: 128, step: 1, value: emitter.spawnRate,
            onChange: v => { emitter.spawnRate = v; /* TODO: live update */ }
        });

        // Active types
        const typesSec = this._addSection(container, 'Active Types');
        for (const type of PARTICLE_TYPES) {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:3px 12px;';

            const cb = document.createElement('input');
            cb.type    = 'checkbox';
            cb.checked = emitter.types.includes(type);
            cb.style.accentColor = 'var(--accent)';
            cb.addEventListener('change', () => {
                if (cb.checked) { if (!emitter.types.includes(type)) emitter.types.push(type); }
                else             { emitter.types = emitter.types.filter(t => t !== type); }
                // TODO: rebuild GPU type buffer
            });

            const lbl = document.createElement('label');
            lbl.textContent = type;
            lbl.style.cssText = 'font-size:11px;cursor:pointer;';
            lbl.addEventListener('click', () => {
                this._selectedType = type;
                // TODO: expand type-specific params below
            });

            row.appendChild(cb);
            row.appendChild(lbl);
            typesSec.appendChild(row);
        }

        // Type-specific params placeholder
        const cfgSec = this._addSection(container, 'Type Config', false);
        const cfgMsg = document.createElement('div');
        cfgMsg.style.cssText = 'padding:8px 12px; color:var(--text-dim); font-size:11px;';
        cfgMsg.textContent   = 'Click a type label above to edit its parameters here.';
        cfgSec.appendChild(cfgMsg);
        // TODO: render per-type sliders (lifetime, size, colors, velocity, gravity, emissive…)
    }

    // ── JSON I/O ──────────────────────────────────────────────────────

    _exportJSON() {
        const json = JSON.stringify(this._asset, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `${this._asset.name}.particle-asset.json`;
        a.click();
        URL.revokeObjectURL(url);
        this.toast(`Exported ${this._asset.name}.particle-asset.json`);
    }

    _importJSON() {
        const input = document.createElement('input');
        input.type   = 'file';
        input.accept = '.json';
        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            if (!file) return;
            try {
                const text  = await file.text();
                this._asset = JSON.parse(text);
                this._selectedEmitterId = null;
                this._refreshEmitterList();
                this._refreshRightSidebar();
                this.toast(`Loaded ${file.name}`);
                // TODO: reload live ParticleSystem from new asset
            } catch (e) {
                this.toast('Failed to parse JSON');
                console.error(e);
            }
        });
        input.click();
    }
}
