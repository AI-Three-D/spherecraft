/**
 * WorldView — procedural world editor.
 *
 * Planned features:
 *   - Free-fly camera through the procedural world (reuse existing frontend)
 *   - Left sidebar: terrain noise params, biome params, texture tiling
 *   - Right sidebar / pop-up: per-tile texture inspector with "Open in Texture Editor"
 *   - Click on terrain tile → show tile metadata + texture weights
 *   - Atmosphere / sky param editor panel
 *   - Vegetation density editor
 *   - Time-of-day / weather scrubber
 *
 * TODO: Wire up to Frontend + existing terrain/world systems.
 */

import { StudioView } from '../StudioView.js';

export class WorldView extends StudioView {
    /** Set to true once this view drives the WebGPU canvas. */
    get usesCanvas() { return true; }

    async onInit(context) {
        this._ctx = context;
        this._buildLeftSidebar(context.sidebarLeft);
        this._buildRightSidebar(context.sidebarRight);
        context.sidebarRightTitle.textContent = 'Tile Inspector';
    }

    async onActivate() {
        // TODO: initialise Frontend with world config and attach to context.canvas
        // TODO: attach keyboard/mouse handlers for free-fly camera
        this.setExtraStatus('<span class="label">Tiles</span> <span class="value">—</span>');
        console.log('[WorldView] activated — canvas ready for Frontend attachment');
    }

    onDeactivate() {
        // TODO: suspend rendering, detach input handlers
    }

    onUpdate(_dt, _t) {
        // TODO: drive Frontend.tick(dt) here
    }

    // ── Left sidebar ─────────────────────────────────────────────────

    _buildLeftSidebar(container) {
        // ── Terrain noise ────────────────────────────────────────────
        const terrainSec = this._addSection(container, 'Terrain Noise');
        this._addSlider(terrainSec, {
            label: 'Base Scale', min: 0.1, max: 10, step: 0.1, value: 1.0,
            onChange: v => { /* TODO: terrain noise controller */ console.log('baseScale', v); }
        });
        this._addSlider(terrainSec, {
            label: 'Octaves', min: 1, max: 12, step: 1, value: 6,
            onChange: v => console.log('octaves', v)
        });
        this._addSlider(terrainSec, {
            label: 'Roughness', min: 0, max: 1, step: 0.01, value: 0.5,
            onChange: v => console.log('roughness', v)
        });
        this._addSlider(terrainSec, {
            label: 'Height Scale', min: 10, max: 2000, step: 10, value: 300,
            onChange: v => console.log('heightScale', v)
        });

        // ── Biomes ───────────────────────────────────────────────────
        const biomeSec = this._addSection(container, 'Biomes', false);
        this._addSlider(biomeSec, {
            label: 'Snow Line (m)', min: 100, max: 3000, step: 10, value: 1200,
            onChange: v => console.log('snowLine', v)
        });
        this._addSlider(biomeSec, {
            label: 'Tree Line (m)', min: 50, max: 2000, step: 10, value: 900,
            onChange: v => console.log('treeLine', v)
        });

        // ── Macro Texturing ──────────────────────────────────────────
        const texSec = this._addSection(container, 'Macro Texturing', false);
        this._addSlider(texSec, {
            label: 'Tile Coverage', min: 1, max: 64, step: 1, value: 8,
            onChange: v => console.log('tileCoverage', v)
        });
        this._addSlider(texSec, {
            label: 'Blend Sharpness', min: 0, max: 1, step: 0.01, value: 0.5,
            onChange: v => console.log('blendSharpness', v)
        });

        // ── Atmosphere ───────────────────────────────────────────────
        const atmoSec = this._addSection(container, 'Atmosphere', false);
        this._addSlider(atmoSec, {
            label: 'Sun Elevation', min: -10, max: 90, step: 0.5, value: 45,
            onChange: v => console.log('sunElevation', v)
        });
        this._addSlider(atmoSec, {
            label: 'Haze', min: 0, max: 1, step: 0.01, value: 0.3,
            onChange: v => console.log('haze', v)
        });

        // ── Vegetation ───────────────────────────────────────────────
        const vegSec = this._addSection(container, 'Vegetation', false);
        this._addSlider(vegSec, {
            label: 'Tree Density', min: 0, max: 1, step: 0.01, value: 0.6,
            onChange: v => console.log('treeDensity', v)
        });
        this._addSlider(vegSec, {
            label: 'Grass Density', min: 0, max: 1, step: 0.01, value: 0.8,
            onChange: v => console.log('grassDensity', v)
        });

        // ── Actions ──────────────────────────────────────────────────
        const actionSec = this._addSection(container, 'Actions');
        this._addButton(actionSec, 'Regenerate World', () => {
            // TODO: trigger world regeneration
            this.toast('World regeneration not yet wired up');
        });
        this._addButton(actionSec, 'Export World Config JSON', () => {
            // TODO: serialise world params to JSON
            this.toast('Export not yet implemented');
        });
        this._addButton(actionSec, 'Load World Config…', () => {
            // TODO: open file picker, load world params
            this.toast('Load not yet implemented');
        });
    }

    // ── Right sidebar ─────────────────────────────────────────────────

    _buildRightSidebar(container) {
        const msg = document.createElement('div');
        msg.style.cssText = 'padding:16px 12px; color:var(--text-dim); font-size:11px; line-height:1.6;';
        msg.textContent = 'Click on a terrain tile in the viewport to inspect its texture weights and biome properties.';
        container.appendChild(msg);

        // TODO: on tile click, populate this panel dynamically
        // Include an "Open in Texture Editor" button that calls:
        //   studio.bus.dispatchEvent(new CustomEvent('openTextureEditor', { detail: { tileId } }))
    }
}
