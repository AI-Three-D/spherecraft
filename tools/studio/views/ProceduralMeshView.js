/**
 * ProceduralMeshView — procedural geometry authoring tool.
 *
 * Planned features:
 *   - 3D viewport: orbit camera, preview generated mesh with material
 *   - Left sidebar: geometry type selector (rock, tree trunk, branch, stone wall,
 *     arch, barrel, etc.) + generation parameters
 *   - Right sidebar: mesh stats (vertex/face count, bounds) + material assignment
 *   - LOD preview: toggle between LOD0/1/2/impostor in the viewport
 *   - Export as engine-native mesh (GPU buffer layout + metadata JSON)
 *   - Seed-based variation: change seed → get a different but same-type mesh
 *
 * Wire-up:
 *   - Geometry generation functions live in core/mesh/ or a new tools/studio/proc/
 *   - Rendered using WebGPU backend with a simple PBR material pass
 *
 * TODO: implement geometry generators in core/mesh/procedural/.
 */

import { StudioView } from '../StudioView.js';

const MESH_TYPES = [
    'Rock',
    'Boulder',
    'Stone Wall Segment',
    'Tree Trunk',
    'Branch',
    'Terrain Patch',
    'Arch',
    'Barrel',
    'Custom (WGSL function)',
];

export class ProceduralMeshView extends StudioView {
    get usesCanvas() { return true; }

    constructor(id) {
        super(id);
        this._meshType   = MESH_TYPES[0];
        this._seed       = 42;
        this._activeLOD  = 0;
        this._params     = {};
    }

    async onInit(context) {
        this._ctx = context;
        context.sidebarLeftTitle.textContent  = 'Generator';
        context.sidebarRightTitle.textContent = 'Mesh Info';
        this._buildLeftSidebar(context.sidebarLeft);
        this._buildRightSidebar(context.sidebarRight);
    }

    async onActivate() {
        // TODO: init WebGPU backend, orbit camera, generate initial mesh
        this.setExtraStatus('<span class="label">Verts</span> <span class="value">—</span>');
        console.log('[ProceduralMeshView] activated');
    }

    onDeactivate() {}

    onUpdate(_dt, _t) {
        // TODO: orbit camera tick, render mesh
    }

    // ── Left sidebar ──────────────────────────────────────────────────

    _buildLeftSidebar(container) {
        const typeSec = this._addSection(container, 'Mesh Type');

        const selRow = document.createElement('div');
        selRow.style.cssText = 'padding:4px 12px;';
        const sel = document.createElement('select');
        sel.style.cssText = `
            width:100%; background:var(--bg-hover); border:1px solid var(--border);
            color:var(--text); font-size:11px; padding:4px 6px; border-radius:3px;
        `;
        for (const mt of MESH_TYPES) {
            const opt = document.createElement('option');
            opt.value = mt; opt.textContent = mt;
            if (mt === this._meshType) opt.selected = true;
            sel.appendChild(opt);
        }
        sel.addEventListener('change', () => {
            this._meshType = sel.value;
            this._rebuildParamSidebar();
            this._generate();
        });
        selRow.appendChild(sel);
        typeSec.appendChild(selRow);

        // Seed
        const seedSec = this._addSection(container, 'Seed');
        this._addSlider(seedSec, {
            label: 'Seed', min: 0, max: 9999, step: 1, value: this._seed,
            onChange: v => { this._seed = v; this._generate(); }
        });
        this._addButton(seedSec, 'Randomize Seed', () => {
            this._seed = Math.floor(Math.random() * 9999);
            this._generate();
            this._refreshSeedDisplay();
        });

        // Geometry params (type-dependent)
        this._paramSectionContainer = container;
        this._paramSection = null;
        this._rebuildParamSidebar();

        // LOD
        const lodSec = this._addSection(container, 'LOD Preview');
        ['LOD 0', 'LOD 1', 'LOD 2', 'Impostor'].forEach((label, i) => {
            this._addButton(lodSec, label, () => {
                this._activeLOD = i;
                // TODO: switch visible mesh LOD in viewport
                this.toast(`Previewing ${label}`);
            });
        });

        // Export
        const exportSec = this._addSection(container, 'Export');
        this._addButton(exportSec, 'Export Mesh (Engine Format)', () => {
            this.toast('Mesh export not yet implemented');
        });
        this._addButton(exportSec, 'Export Config JSON', () => this._exportConfig());
        this._addButton(exportSec, 'Load Config JSON…',  () => this._importConfig());
    }

    _rebuildParamSidebar() {
        // Remove previous param section if any
        if (this._paramSection?.parentElement) {
            this._paramSection.parentElement.removeChild(this._paramSection);
        }
        const sec = this._addSection(this._paramSectionContainer, 'Parameters');
        this._paramSection = sec.parentElement; // the .panel-section wrapper

        // TODO: replace with proper per-type param definitions
        // These are generic placeholders that apply to most geometry types
        this._addSlider(sec, {
            label: 'Complexity', min: 1, max: 10, step: 1, value: 5,
            onChange: v => { this._params.complexity = v; this._generate(); }
        });
        this._addSlider(sec, {
            label: 'Roughness', min: 0, max: 1, step: 0.01, value: 0.5,
            onChange: v => { this._params.roughness = v; this._generate(); }
        });
        this._addSlider(sec, {
            label: 'Scale', min: 0.1, max: 10, step: 0.1, value: 1.0,
            onChange: v => { this._params.scale = v; this._generate(); }
        });
        this._addSlider(sec, {
            label: 'Aspect', min: 0.2, max: 5, step: 0.1, value: 1.0,
            onChange: v => { this._params.aspect = v; this._generate(); }
        });
    }

    _refreshSeedDisplay() {
        // TODO: update the seed slider to reflect new random value
    }

    // ── Right sidebar ─────────────────────────────────────────────────

    _buildRightSidebar(container) {
        const statSec = this._addSection(container, 'Mesh Stats');
        const stats = [
            ['Vertices', '—'],
            ['Faces',    '—'],
            ['Bounds X', '—'],
            ['Bounds Y', '—'],
            ['Bounds Z', '—'],
        ];
        stats.forEach(([label, value]) => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;justify-content:space-between;padding:3px 12px;font-size:11px;';
            row.innerHTML     = `<span style="color:var(--text-dim)">${label}</span><span>${value}</span>`;
            statSec.appendChild(row);
        });
        // TODO: update stats after generation

        const matSec = this._addSection(container, 'Material', false);
        const matMsg = document.createElement('div');
        matMsg.style.cssText = 'padding:8px 12px; color:var(--text-dim); font-size:11px;';
        matMsg.textContent   = 'Material assignment not yet implemented.';
        matSec.appendChild(matMsg);
    }

    // ── Generation ────────────────────────────────────────────────────

    _generate() {
        // TODO: call geometry generator with this._meshType, this._seed, this._params
        // TODO: upload result mesh to GPU, refresh viewport
        console.log('[ProceduralMeshView] generate', { type: this._meshType, seed: this._seed, params: this._params });
    }

    // ── Export / Import ───────────────────────────────────────────────

    _exportConfig() {
        const data = { meshType: this._meshType, seed: this._seed, params: this._params };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);
        Object.assign(document.createElement('a'), { href: url, download: 'proc-mesh.json' }).click();
        URL.revokeObjectURL(url);
        this.toast('Exported proc-mesh.json');
    }

    _importConfig() {
        const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.json' });
        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            if (!file) return;
            try {
                const data       = JSON.parse(await file.text());
                this._meshType   = data.meshType ?? MESH_TYPES[0];
                this._seed       = data.seed ?? 42;
                this._params     = data.params ?? {};
                this._rebuildParamSidebar();
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
