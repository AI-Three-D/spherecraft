/**
 * GlbAssetView — GLB/GLTF asset inspector and importer.
 *
 * Planned features:
 *   - Drag-and-drop or file-picker GLB/GLTF load
 *   - 3D orbit viewport: preview the model with the engine's lighting/materials
 *   - Left sidebar: scene graph tree (nodes, meshes, materials, animations)
 *   - Right sidebar: selected node/mesh properties (transform, material slots,
 *     morph targets, bounding box)
 *   - Material override: assign engine materials to GLTF material slots
 *   - Animation list: scrub timelines, preview clips
 *   - Export as engine-native format (pre-processed GPU buffers + metadata JSON)
 *
 * Wire-up:
 *   - Use WebGPU backend for rendering (reuse existing backend/webgpuBackend.js)
 *   - GLTF parsing: either a thin custom parser or import a small GLTF library
 *   - Mesh data → GPU vertex/index buffers via backend.createBuffer
 *
 * TODO: implement once GLTF importer exists in core.
 */

import { StudioView } from '../StudioView.js';

export class GlbAssetView extends StudioView {
    get usesCanvas() { return true; }

    constructor(id) {
        super(id);
        this._loadedFile = null;
    }

    async onInit(context) {
        this._ctx = context;
        context.sidebarRightTitle.textContent = 'Inspector';
        this._buildLeftSidebar(context.sidebarLeft);
        this._buildRightSidebar(context.sidebarRight);
        this._buildDropZone(context.canvas);
    }

    async onActivate() {
        // TODO: init WebGPU context, orbit camera, default lighting
        this.setExtraStatus('<span class="label">Verts</span> <span class="value">—</span>');
        console.log('[GlbAssetView] activated');
    }

    onDeactivate() {}

    onUpdate(_dt, _t) {
        // TODO: tick orbit camera, render mesh
    }

    // ── Drop zone overlay ─────────────────────────────────────────────

    _buildDropZone(canvas) {
        const wrap = canvas.parentElement;

        // Show drop hint when no file is loaded
        const hint = document.getElementById('viewport-placeholder');
        if (hint) {
            hint.querySelector('.placeholder-icon').textContent  = '📦';
            hint.querySelector('.placeholder-label').textContent = 'Drop a .glb / .gltf file here';
        }

        wrap.addEventListener('dragover', (e) => { e.preventDefault(); });
        wrap.addEventListener('drop', (e) => {
            e.preventDefault();
            const file = e.dataTransfer.files?.[0];
            if (file) this._loadFile(file);
        });
    }

    // ── File loading ──────────────────────────────────────────────────

    async _loadFile(file) {
        if (!file.name.match(/\.(glb|gltf)$/i)) {
            this.toast('Only .glb / .gltf files are supported');
            return;
        }
        this.toast(`Loading ${file.name}…`);
        this._loadedFile = file;
        // TODO: parse GLTF/GLB, upload meshes, build scene graph
        // TODO: populate left sidebar scene tree
        // TODO: hide viewport placeholder
        console.log('[GlbAssetView] file selected:', file.name);
        this.toast(`Loaded ${file.name} (parser not yet wired up)`);
    }

    // ── Left sidebar — scene tree ─────────────────────────────────────

    _buildLeftSidebar(container) {
        const fileSec = this._addSection(container, 'File');
        this._addButton(fileSec, 'Open GLB / GLTF…', () => {
            const input  = document.createElement('input');
            input.type   = 'file';
            input.accept = '.glb,.gltf';
            input.addEventListener('change', () => {
                if (input.files?.[0]) this._loadFile(input.files[0]);
            });
            input.click();
        });
        this._addButton(fileSec, 'Export (Engine Format)…', () => {
            this.toast('Export not yet implemented');
        });

        const treeSec = this._addSection(container, 'Scene Graph', false);
        const treeMsg = document.createElement('div');
        treeMsg.style.cssText = 'padding:8px 12px; color:var(--text-dim); font-size:11px;';
        treeMsg.textContent   = 'No file loaded.';
        treeSec.appendChild(treeMsg);
        this._sceneTreeEl = treeSec;
        // TODO: populate with node tree on load

        const animSec = this._addSection(container, 'Animations', false);
        const animMsg = document.createElement('div');
        animMsg.style.cssText = 'padding:8px 12px; color:var(--text-dim); font-size:11px;';
        animMsg.textContent   = 'No animations.';
        animSec.appendChild(animMsg);
        this._animListEl = animSec;
        // TODO: populate animation clips on load
    }

    // ── Right sidebar — properties ────────────────────────────────────

    _buildRightSidebar(container) {
        const msg = document.createElement('div');
        msg.style.cssText = 'padding:16px 12px; color:var(--text-dim); font-size:11px; line-height:1.6;';
        msg.textContent   = 'Select a node in the scene graph to inspect its properties.';
        container.appendChild(msg);
        // TODO: populate with transform, material, morph target info on selection
    }
}
