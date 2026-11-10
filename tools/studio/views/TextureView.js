/**
 * TextureView — procedural texture generator and editor.
 *
 * Planned features:
 *   - Node-based or parameter-based texture generation (noise, gradient,
 *     blend, warp, color adjust layers)
 *   - Live 2D preview in viewport (render to canvas 2D or WebGPU texture)
 *   - 3D preview: apply texture to a sphere or terrain patch in the viewport
 *   - Left sidebar: layer stack (noise layers, blend layers, masks)
 *   - Right sidebar: selected layer parameters
 *   - Export as PNG/WebP/compressed GPU texture
 *   - Can be opened from WorldView tile inspector via "Open in Texture Editor"
 *
 * Wire-up:
 *   - Texture generation can run on CPU (Canvas 2D / OffscreenCanvas) or
 *     GPU (WebGPU compute shader for large textures)
 *   - Listen on context.bus for 'openTextureEditor' events from WorldView
 *
 * TODO: implement layer system and GPU compute generation path.
 */

import { StudioView } from '../StudioView.js';

const DEFAULT_RESOLUTION = 512;

const LAYER_TYPES = [
    'Perlin Noise',
    'Simplex Noise',
    'Voronoi',
    'Gradient',
    'Solid Color',
    'Blend',
    'Warp',
    'Color Adjust',
];

export class TextureView extends StudioView {
    get usesCanvas() { return true; }

    constructor(id) {
        super(id);
        this._layers = [
            { type: 'Perlin Noise', scale: 4.0, amplitude: 1.0, octaves: 4, visible: true },
            { type: 'Color Adjust', brightness: 0.0, contrast: 1.0, saturation: 1.0, visible: true },
        ];
        this._selectedLayerIdx = 0;
        this._resolution       = DEFAULT_RESOLUTION;
    }

    async onInit(context) {
        this._ctx = context;
        context.sidebarLeftTitle.textContent  = 'Layers';
        context.sidebarRightTitle.textContent = 'Layer Params';

        // Listen for cross-view navigation
        context.bus.addEventListener('openTextureEditor', (e) => {
            // TODO: load tile texture data from e.detail.tileId
            this.toast(`Opening texture for tile ${e.detail?.tileId ?? '?'}`);
        });

        this._buildLeftSidebar(context.sidebarLeft);
        this._buildRightSidebar(context.sidebarRight);
    }

    async onActivate() {
        // TODO: render texture preview to context.canvas (2D or WebGPU)
        this.setExtraStatus(`<span class="label">Res</span> <span class="value">${this._resolution}×${this._resolution}</span>`);
        console.log('[TextureView] activated');
    }

    onDeactivate() {}

    onUpdate(_dt, _t) {
        // TODO: if generation is async/streaming, update progress here
    }

    // ── Left sidebar — layer stack ────────────────────────────────────

    _buildLeftSidebar(container) {
        const resSec = this._addSection(container, 'Output');
        this._addSlider(resSec, {
            label: 'Resolution', min: 64, max: 2048, step: 64, value: DEFAULT_RESOLUTION,
            onChange: v => { this._resolution = v; this._generate(); }
        });

        const layerSec = this._addSection(container, 'Layers');
        this._layerListEl = layerSec;
        this._refreshLayerList();

        // Add layer dropdown + button
        const addRow = document.createElement('div');
        addRow.style.cssText = 'padding:4px 12px; display:flex; gap:6px;';
        const sel = document.createElement('select');
        sel.style.cssText = `
            flex:1; background:var(--bg-hover); border:1px solid var(--border);
            color:var(--text); font-size:11px; padding:3px; border-radius:3px;
        `;
        for (const lt of LAYER_TYPES) {
            const opt   = document.createElement('option');
            opt.value   = lt;
            opt.textContent = lt;
            sel.appendChild(opt);
        }
        const addBtn = document.createElement('button');
        addBtn.textContent = '+';
        addBtn.style.cssText = `
            background:var(--accent-dim); border:1px solid var(--border-bright);
            color:var(--accent); font-size:14px; padding:2px 8px;
            cursor:pointer; border-radius:3px;
        `;
        addBtn.addEventListener('click', () => {
            this._layers.unshift({ type: sel.value, visible: true });
            this._selectedLayerIdx = 0;
            this._refreshLayerList();
            this._refreshRightSidebar();
            this._generate();
        });
        addRow.appendChild(sel);
        addRow.appendChild(addBtn);
        container.appendChild(addRow);

        const actionSec = this._addSection(container, 'Export');
        this._addButton(actionSec, 'Export PNG', () => this._exportPNG());
        this._addButton(actionSec, 'Export Config JSON', () => this._exportConfig());
        this._addButton(actionSec, 'Load Config JSON…', () => this._importConfig());
    }

    _refreshLayerList() {
        const el = this._layerListEl;
        if (!el) return;
        el.innerHTML = '';
        this._layers.forEach((layer, idx) => {
            const row = document.createElement('div');
            row.style.cssText = `
                display:flex; align-items:center; gap:6px; padding:4px 12px;
                cursor:pointer; border-radius:3px;
                background:${idx === this._selectedLayerIdx ? 'var(--accent-active)' : 'transparent'};
            `;

            const vis = document.createElement('input');
            vis.type    = 'checkbox';
            vis.checked = layer.visible;
            vis.style.accentColor = 'var(--accent)';
            vis.addEventListener('change', (e) => {
                e.stopPropagation();
                layer.visible = vis.checked;
                this._generate();
            });

            const label = document.createElement('span');
            label.textContent = layer.type;
            label.style.cssText = 'font-size:11px; flex:1;';

            const del = document.createElement('button');
            del.textContent = '×';
            del.style.cssText = `
                background:none; border:none; color:var(--text-dim);
                cursor:pointer; font-size:13px; padding:0 2px;
            `;
            del.addEventListener('click', (e) => {
                e.stopPropagation();
                this._layers.splice(idx, 1);
                if (this._selectedLayerIdx >= this._layers.length)
                    this._selectedLayerIdx = Math.max(0, this._layers.length - 1);
                this._refreshLayerList();
                this._refreshRightSidebar();
                this._generate();
            });

            row.appendChild(vis);
            row.appendChild(label);
            row.appendChild(del);
            row.addEventListener('click', () => {
                this._selectedLayerIdx = idx;
                this._refreshLayerList();
                this._refreshRightSidebar();
            });
            el.appendChild(row);
        });
    }

    // ── Right sidebar — layer params ──────────────────────────────────

    _buildRightSidebar(container) {
        this._rightContainer = container;
        this._refreshRightSidebar();
    }

    _refreshRightSidebar() {
        const container = this._rightContainer;
        if (!container) return;
        container.innerHTML = '';

        const layer = this._layers[this._selectedLayerIdx];
        if (!layer) {
            const msg = document.createElement('div');
            msg.style.cssText = 'padding:16px 12px; color:var(--text-dim); font-size:11px;';
            msg.textContent   = 'No layer selected.';
            container.appendChild(msg);
            return;
        }

        const sec = this._addSection(container, layer.type);

        // Render parameter sliders based on layer type
        // TODO: expand with full per-type parameter sets
        if (layer.scale !== undefined) {
            this._addSlider(sec, {
                label: 'Scale', min: 0.1, max: 32, step: 0.1, value: layer.scale ?? 4,
                onChange: v => { layer.scale = v; this._generate(); }
            });
        }
        if (layer.amplitude !== undefined) {
            this._addSlider(sec, {
                label: 'Amplitude', min: 0, max: 2, step: 0.01, value: layer.amplitude ?? 1,
                onChange: v => { layer.amplitude = v; this._generate(); }
            });
        }
        if (layer.octaves !== undefined) {
            this._addSlider(sec, {
                label: 'Octaves', min: 1, max: 8, step: 1, value: layer.octaves ?? 4,
                onChange: v => { layer.octaves = v; this._generate(); }
            });
        }
        if (layer.brightness !== undefined) {
            this._addSlider(sec, {
                label: 'Brightness', min: -1, max: 1, step: 0.01, value: layer.brightness ?? 0,
                onChange: v => { layer.brightness = v; this._generate(); }
            });
        }
        if (layer.contrast !== undefined) {
            this._addSlider(sec, {
                label: 'Contrast', min: 0, max: 3, step: 0.01, value: layer.contrast ?? 1,
                onChange: v => { layer.contrast = v; this._generate(); }
            });
        }
        if (layer.saturation !== undefined) {
            this._addSlider(sec, {
                label: 'Saturation', min: 0, max: 3, step: 0.01, value: layer.saturation ?? 1,
                onChange: v => { layer.saturation = v; this._generate(); }
            });
        }
    }

    // ── Generation ────────────────────────────────────────────────────

    _generate() {
        // TODO: run layer stack through GPU compute or CPU CanvasAPI
        // TODO: upload result to preview texture
        console.log('[TextureView] generate (not yet implemented)');
    }

    // ── Export / Import ───────────────────────────────────────────────

    _exportPNG() {
        // TODO: read generated texture → toDataURL → download
        this.toast('PNG export not yet implemented');
    }

    _exportConfig() {
        const json = JSON.stringify({ resolution: this._resolution, layers: this._layers }, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);
        const a    = Object.assign(document.createElement('a'), { href: url, download: 'texture.json' });
        a.click();
        URL.revokeObjectURL(url);
        this.toast('Exported texture config JSON');
    }

    _importConfig() {
        const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.json' });
        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            if (!file) return;
            try {
                const data             = JSON.parse(await file.text());
                this._layers           = data.layers ?? [];
                this._resolution       = data.resolution ?? DEFAULT_RESOLUTION;
                this._selectedLayerIdx = 0;
                this._refreshLayerList();
                this._refreshRightSidebar();
                this._generate();
                this.toast(`Loaded ${file.name}`);
            } catch (e) {
                this.toast('Failed to parse JSON');
                console.error(e);
            }
        });
        input.click();
    }
}
