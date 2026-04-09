/**
 * WorldViewBase — full-featured world editor view.
 *
 * Subclass this to attach a real world engine. The base class handles all
 * sidebar UI, parameter management, dirty tracking, and JSON save/load.
 * Subclasses only need to implement `createEngine()` and `worldDir`.
 *
 * To create a game-specific world view:
 *
 *   // wizard_game/WorldEditorView.js
 *   import { WorldViewBase }     from '../tools/studio/views/WorldViewBase.js';
 *   import { StudioWorldEngine } from '../tools/studio/StudioWorldEngine.js';
 *   import { WorldConfigLoader } from './WorldConfigLoader.js';
 *   // ... import themes ...
 *
 *   export class WorldEditorView extends WorldViewBase {
 *       get worldDir()  { return './world'; }
 *       get configLoader() { return new WorldConfigLoader(this.worldDir); }
 *       async createEngine(canvas, engineConfig, gameDataConfig) {
 *           const eng = new StudioWorldEngine(canvas, { engineConfig, gameDataConfig, ...themes });
 *           await eng.start();
 *           return eng;
 *       }
 *   }
 */

import { StudioView } from '../StudioView.js';

// ── Parameter definitions ─────────────────────────────────────────────────────
// Each entry: { group, key, label, min, max, step, default, needsRegen, tooltip,
//               get(raw), set(raw, v) }
// `raw` = { terrain, planet, postprocessing, engine }
// set() mutates raw in-place; after set(), the view re-applies realtime if !needsRegen.

const PARAMS = [

    // ── Terrain Shape ──────────────────────────────────────────────────────
    { group:'Terrain Shape', key:'t.noiseProfile.mountainBias',  label:'Mountain Bias',
      min:0, max:3, step:0.05, default:1.0, needsRegen:true,
      tooltip:'Controls prominence of mountain features.\nRequires world regeneration.',
      get: r => r.terrain?.noiseProfile?.mountainBias  ?? 1.0,
      set: (r,v) => { r.terrain.noiseProfile.mountainBias  = v; } },
    { group:'Terrain Shape', key:'t.noiseProfile.hillBias',      label:'Hill Bias',
      min:0, max:3, step:0.05, default:1.0, needsRegen:true,
      tooltip:'Controls prominence of hills.\nRequires world regeneration.',
      get: r => r.terrain?.noiseProfile?.hillBias      ?? 1.0,
      set: (r,v) => { r.terrain.noiseProfile.hillBias      = v; } },
    { group:'Terrain Shape', key:'t.noiseProfile.canyonBias',    label:'Canyon Bias',
      min:0, max:3, step:0.05, default:1.0, needsRegen:true,
      tooltip:'Controls canyon depth and frequency.\nRequires world regeneration.',
      get: r => r.terrain?.noiseProfile?.canyonBias    ?? 1.0,
      set: (r,v) => { r.terrain.noiseProfile.canyonBias    = v; } },
    { group:'Terrain Shape', key:'t.noiseProfile.warpStrength',  label:'Warp Strength',
      min:0, max:2, step:0.05, default:1.0, needsRegen:true,
      tooltip:'How much domain warping distorts the noise.\nRequires world regeneration.',
      get: r => r.terrain?.noiseProfile?.warpStrength  ?? 1.0,
      set: (r,v) => { r.terrain.noiseProfile.warpStrength  = v; } },
    { group:'Terrain Shape', key:'t.noiseProfile.ridgeSharpness',label:'Ridge Sharpness',
      min:0, max:2, step:0.05, default:1.0, needsRegen:true,
      tooltip:'How sharp mountain ridgelines appear.\nRequires world regeneration.',
      get: r => r.terrain?.noiseProfile?.ridgeSharpness ?? 1.0,
      set: (r,v) => { r.terrain.noiseProfile.ridgeSharpness = v; } },
    { group:'Terrain Shape', key:'t.noiseProfile.microGain',     label:'Micro Detail',
      min:0, max:2, step:0.05, default:1.0, needsRegen:true,
      tooltip:'High-frequency surface detail amplitude.\nRequires world regeneration.',
      get: r => r.terrain?.noiseProfile?.microGain     ?? 1.0,
      set: (r,v) => { r.terrain.noiseProfile.microGain     = v; } },
    { group:'Terrain Shape', key:'t.maxTerrainHeight',           label:'Max Height (m)',
      min:200, max:15000, step:100, default:5000, needsRegen:true,
      tooltip:'Maximum terrain elevation in metres.\nRequires world regeneration.',
      get: r => r.terrain?.maxTerrainHeight ?? 5000,
      set: (r,v) => { r.terrain.maxTerrainHeight = v; } },
    { group:'Terrain Shape', key:'t.seed',                       label:'Seed',
      min:0, max:99999, step:1, default:12345, needsRegen:true,
      tooltip:'World seed. Changing this creates an entirely different world.\nRequires world regeneration.',
      get: r => r.terrain?.seed ?? 12345,
      set: (r,v) => { r.terrain.seed = v; } },

    // ── Continents ─────────────────────────────────────────────────────────
    { group:'Continents', key:'t.continents.count',             label:'Count',
      min:0, max:12, step:1, default:5, needsRegen:true,
      tooltip:'Number of continental landmasses.\nRequires world regeneration.',
      get: r => r.terrain?.continents?.count          ?? 5,
      set: (r,v) => { r.terrain.continents.count          = v; } },
    { group:'Continents', key:'t.continents.averageSize',       label:'Avg Size',
      min:0.05, max:0.7, step:0.01, default:0.28, needsRegen:true,
      tooltip:'Average continent size as a fraction of surface area.\nRequires world regeneration.',
      get: r => r.terrain?.continents?.averageSize    ?? 0.28,
      set: (r,v) => { r.terrain.continents.averageSize    = v; } },
    { group:'Continents', key:'t.continents.coastalComplexity', label:'Coastline',
      min:0, max:1, step:0.01, default:0.7, needsRegen:true,
      tooltip:'Fractal complexity of coastlines. High = fjords and bays.\nRequires world regeneration.',
      get: r => r.terrain?.continents?.coastalComplexity ?? 0.7,
      set: (r,v) => { r.terrain.continents.coastalComplexity = v; } },

    // ── Tectonics ───────────────────────────────────────────────────────────
    { group:'Tectonics', key:'t.tectonics.mountainBuildingRate', label:'Mountain Rate',
      min:0, max:3, step:0.05, default:1.0, needsRegen:true,
      tooltip:'How actively tectonic plates build mountains.\nRequires world regeneration.',
      get: r => r.terrain?.tectonics?.mountainBuildingRate ?? 1.0,
      set: (r,v) => { r.terrain.tectonics.mountainBuildingRate = v; } },
    { group:'Tectonics', key:'t.tectonics.riftValleyDepth',     label:'Rift Depth',
      min:0, max:1, step:0.01, default:0.5, needsRegen:true,
      tooltip:'Depth of rift valleys at divergent plate boundaries.\nRequires world regeneration.',
      get: r => r.terrain?.tectonics?.riftValleyDepth    ?? 0.5,
      set: (r,v) => { r.terrain.tectonics.riftValleyDepth    = v; } },

    // ── Erosion ─────────────────────────────────────────────────────────────
    { group:'Erosion', key:'t.erosion.globalRate',   label:'Global Rate',
      min:0, max:1, step:0.01, default:0.5, needsRegen:true,
      tooltip:'Overall erosion intensity.\nRequires world regeneration.',
      get: r => r.terrain?.erosion?.globalRate   ?? 0.5,
      set: (r,v) => { r.terrain.erosion.globalRate   = v; } },
    { group:'Erosion', key:'t.erosion.hydraulicRate',label:'Hydraulic',
      min:0, max:1, step:0.01, default:0.6, needsRegen:true,
      tooltip:'Water-driven erosion (rivers, rain).\nRequires world regeneration.',
      get: r => r.terrain?.erosion?.hydraulicRate ?? 0.6,
      set: (r,v) => { r.terrain.erosion.hydraulicRate = v; } },
    { group:'Erosion', key:'t.erosion.thermalRate',  label:'Thermal',
      min:0, max:1, step:0.01, default:0.3, needsRegen:true,
      tooltip:'Slope-driven erosion (rockfall, talus).\nRequires world regeneration.',
      get: r => r.terrain?.erosion?.thermalRate  ?? 0.3,
      set: (r,v) => { r.terrain.erosion.thermalRate  = v; } },

    // ── Water ───────────────────────────────────────────────────────────────
    { group:'Water', key:'t.water.oceanLevel',       label:'Ocean Level',
      min:-0.5, max:0.5, step:0.005, default:0.0, needsRegen:true,
      tooltip:'Normalised ocean surface height (×maxTerrainHeight = metres).\nRequires world regeneration.',
      get: r => r.terrain?.water?.oceanLevel       ?? 0.0,
      set: (r,v) => { r.terrain.water.oceanLevel       = v; } },
    { group:'Water', key:'t.water.visualDepthRange', label:'Visual Depth (m)',
      min:10, max:2000, step:10, default:300, needsRegen:false,
      tooltip:'Water visual scattering depth — affects how deep water looks.\nUpdates in real-time.',
      get: r => r.terrain?.water?.visualDepthRange ?? 300,
      set: (r,v) => { r.terrain.water.visualDepthRange = v; } },

    // ── Surface ─────────────────────────────────────────────────────────────
    { group:'Surface', key:'t.surface.rockSlopeStart', label:'Rock Slope Start',
      min:0, max:1, step:0.01, default:0.35, needsRegen:true,
      tooltip:'Slope fraction where rock begins to appear (0=flat, 1=vertical).\nRequires world regeneration.',
      get: r => r.terrain?.surface?.rockSlopeStart ?? 0.35,
      set: (r,v) => { r.terrain.surface.rockSlopeStart = v; } },
    { group:'Surface', key:'t.surface.rockSlopeFull',  label:'Rock Slope Full',
      min:0, max:1, step:0.01, default:0.70, needsRegen:true,
      tooltip:'Slope fraction where rock dominates completely.\nRequires world regeneration.',
      get: r => r.terrain?.surface?.rockSlopeFull  ?? 0.70,
      set: (r,v) => { r.terrain.surface.rockSlopeFull  = v; } },

    // ── Atmosphere (real-time) ──────────────────────────────────────────────
    { group:'Atmosphere', key:'p.atmosphereOptions.visualDensity',         label:'Visual Density',
      min:0, max:2, step:0.01, default:0.5, needsRegen:false,
      tooltip:'Atmospheric haze density. Higher = thicker atmosphere.\nUpdates in real-time.',
      get: r => r.planet?.atmosphereOptions?.visualDensity         ?? 0.5,
      set: (r,v) => { r.planet.atmosphereOptions.visualDensity         = v; } },
    { group:'Atmosphere', key:'p.atmosphereOptions.sunIntensity',          label:'Sun Intensity',
      min:1, max:60, step:0.5, default:20, needsRegen:false,
      tooltip:'Sun brightness multiplier.\nUpdates in real-time.',
      get: r => r.planet?.atmosphereOptions?.sunIntensity          ?? 20,
      set: (r,v) => { r.planet.atmosphereOptions.sunIntensity          = v; } },
    { group:'Atmosphere', key:'p.atmosphereOptions.mieAnisotropy',         label:'Mie Anisotropy',
      min:0, max:0.99, step:0.01, default:0.76, needsRegen:false,
      tooltip:'Forward scattering (halo around sun). 0.76 = Earth-like.\nUpdates in real-time.',
      get: r => r.planet?.atmosphereOptions?.mieAnisotropy         ?? 0.76,
      set: (r,v) => { r.planet.atmosphereOptions.mieAnisotropy         = v; } },
    { group:'Atmosphere', key:'p.atmosphereOptions.scaleHeightRayleighRatio', label:'Rayleigh Scale',
      min:0.01, max:0.5, step:0.005, default:0.1, needsRegen:false,
      tooltip:'Rayleigh scattering scale height (fraction of atmosphere thickness).\nUpdates in real-time.',
      get: r => r.planet?.atmosphereOptions?.scaleHeightRayleighRatio ?? 0.1,
      set: (r,v) => { r.planet.atmosphereOptions.scaleHeightRayleighRatio = v; } },

    // ── Post-processing (real-time) ─────────────────────────────────────────
    { group:'Post-processing', key:'pp.exposure',        label:'Exposure',
      min:0.1, max:3, step:0.01, default:1.0, needsRegen:false,
      tooltip:'HDR exposure multiplier. Raise if the world looks too dark.\nUpdates in real-time.',
      get: r => r.postprocessing?.exposure        ?? 1.0,
      set: (r,v) => { r.postprocessing.exposure        = v; } },
    { group:'Post-processing', key:'pp.bloom.threshold', label:'Bloom Threshold',
      min:0.5, max:8, step:0.05, default:2.2, needsRegen:false,
      tooltip:'HDR brightness level where bloom begins. Raise to reduce bloom bleed.\nUpdates in real-time.',
      get: r => r.postprocessing?.bloom?.threshold ?? 2.2,
      set: (r,v) => { r.postprocessing.bloom.threshold = v; } },
    { group:'Post-processing', key:'pp.bloom.intensity', label:'Bloom Intensity',
      min:0, max:0.5, step:0.005, default:0.06, needsRegen:false,
      tooltip:'Bloom composite strength.\nUpdates in real-time.',
      get: r => r.postprocessing?.bloom?.intensity ?? 0.06,
      set: (r,v) => { r.postprocessing.bloom.intensity = v; } },
    { group:'Post-processing', key:'pp.bloom.knee',      label:'Bloom Knee',
      min:0, max:1, step:0.01, default:0.25, needsRegen:false,
      tooltip:'Bloom threshold smoothing width.\nUpdates in real-time.',
      get: r => r.postprocessing?.bloom?.knee      ?? 0.25,
      set: (r,v) => { r.postprocessing.bloom.knee      = v; } },
];

// ── WorldViewBase ─────────────────────────────────────────────────────────────

export class WorldViewBase extends StudioView {
    get usesCanvas() { return true; }

    /** Override: return a URL string for the world config folder, e.g. './world' */
    get worldDir() { return null; }

    /** Override: return a WorldConfigLoader instance */
    get configLoader() { return null; }

    /**
     * Override: create and start a world engine on the given canvas.
     * @param {HTMLCanvasElement} canvas
     * @param {object} engineConfig
     * @param {object} gameDataConfig
     * @returns {Promise<object>} engine instance with .postProcessing and .update()/.render()
     */
    // eslint-disable-next-line no-unused-vars
    async createEngine(canvas, engineConfig, gameDataConfig) { return null; }

    // ── Internal state ────────────────────────────────────────────────

    constructor(id) {
        super(id);
        this._engine       = null;
        this._loader       = null;
        this._raw          = null;
        this._regenRaw     = null;   // snapshot of regen params before edits
        this._dirty        = false;  // any regen param changed
        this._regenBtn     = null;
        this._discardBtn   = null;
        this._keys         = {};
        this._mouseDelta   = { x: 0, y: 0 };
        this._isPointerDown = false;
        this._loadError    = null;
    }

    // ── Lifecycle ─────────────────────────────────────────────────────

    async onInit(context) {
        this._ctx = context;
        context.sidebarLeftTitle.textContent  = 'World Editor';
        context.sidebarRightTitle.textContent = 'Export / Import';
        this._buildRightSidebar(context.sidebarRight);

        if (!this.configLoader) {
            this._showPlaceholder('No configLoader provided.\nSubclass WorldViewBase and override configLoader.');
            this._buildStubLeftSidebar(context.sidebarLeft);
            return;
        }

        try {
            this._loader = this.configLoader;
            const { engineConfig, gameDataConfig, raw } = await this._loader.load();
            this._raw     = raw;
            this._regenRaw = this._snapshotRegenParams(raw);

            this._buildLeftSidebar(context.sidebarLeft, raw);

            // Start engine
            const placeholder = document.getElementById('viewport-placeholder');
            if (placeholder) {
                placeholder.querySelector('.placeholder-label').textContent = 'Loading world…';
                placeholder.style.display = 'flex';
            }

            this._engine = await this.createEngine(context.canvas, engineConfig, gameDataConfig);

            if (placeholder) placeholder.style.display = 'none';

            if (this._engine) {
                // Apply initial postprocessing from JSON
                this._applyRealtime();
            }
        } catch (err) {
            this._loadError = err;
            console.error('[WorldViewBase] init error:', err);
            this._showPlaceholder(`Failed to load world:\n${err.message}`);
        }

        this._attachInputListeners(context.canvas);
    }

    async onActivate() {
        this.setExtraStatus('<span class="label">World</span> <span class="value" id="world-stat">—</span>');
    }

    onDeactivate() {
        this._keys = {};
    }

    onUpdate(dt, _t) {
        if (!this._engine) return;
        const md = { ...this._mouseDelta };
        this._mouseDelta.x = 0;
        this._mouseDelta.y = 0;
        this._engine.update(dt, this._keys, md, !!this._keys['Shift']);
        this._engine.render(dt);
    }

    onDestroy() {
        this._engine?.dispose?.();
        this._detachInputListeners();
    }

    // ── Left sidebar — param sliders ─────────────────────────────────

    _buildLeftSidebar(container, raw) {
        // Group params
        const groups = {};
        for (const p of PARAMS) {
            (groups[p.group] = groups[p.group] ?? []).push(p);
        }

        for (const [groupName, params] of Object.entries(groups)) {
            // Start collapsed for less-used groups
            const startOpen = ['Terrain Shape','Post-processing','Atmosphere'].includes(groupName);
            const body = this._addSection(container, groupName, startOpen);
            for (const param of params) {
                this._addWorldSlider(body, param, raw);
            }
        }

        // ── Action buttons ────────────────────────────────────────────
        const actionBody = this._addSection(container, 'Actions', true);

        this._regenBtn = this._addWorldButton(actionBody, '⬡ Regenerate World', () => {
            this._regenerate();
        }, 'regen-btn', 'Generate the world with current settings.\nRequired after changing red-labelled parameters.');

        this._discardBtn = this._addWorldButton(actionBody, '↩ Discard Regen Changes', () => {
            this._discardRegenChanges();
        }, 'discard-btn', 'Undo all changes that require world regeneration.\nReal-time changes (non-red) are kept.');

        this._updateDirtyUI();
    }

    _buildStubLeftSidebar(container) {
        const body = this._addSection(container, 'Configuration');
        const msg = document.createElement('div');
        msg.style.cssText = 'padding:10px 12px; color:var(--text-dim); font-size:11px; line-height:1.6;';
        msg.textContent   = 'Subclass WorldViewBase and override worldDir / configLoader / createEngine() to connect this view to a real world.';
        body.appendChild(msg);
    }

    _addWorldSlider(body, param, raw) {
        const row = document.createElement('div');
        row.className = 'param-row';

        const lbl = document.createElement('label');
        lbl.textContent = param.label;
        lbl.title       = param.tooltip ?? '';
        if (param.needsRegen) lbl.classList.add('regen');

        const slider = document.createElement('input');
        slider.type  = 'range';
        slider.min   = param.min;
        slider.max   = param.max;
        slider.step  = param.step;
        slider.value = param.get(raw);
        slider.title = param.tooltip ?? '';

        const numInput = document.createElement('input');
        numInput.type      = 'number';
        numInput.className = 'param-value-input';
        numInput.min       = param.min;
        numInput.max       = param.max;
        numInput.step      = param.step;
        numInput.value     = this._fmt(param.get(raw), param.step);
        numInput.title     = param.tooltip ?? '';

        const onValueChange = (v) => {
            v = Math.max(param.min, Math.min(param.max, v));
            slider.value  = v;
            numInput.value = this._fmt(v, param.step);
            param.set(raw, v);
            if (param.needsRegen) {
                this._dirty = true;
                this._updateDirtyUI();
            } else {
                this._applyRealtime();
            }
        };

        slider.addEventListener('input', () => onValueChange(parseFloat(slider.value)));
        numInput.addEventListener('change', () => {
            const v = parseFloat(numInput.value);
            if (Number.isFinite(v)) onValueChange(v);
        });
        numInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') numInput.blur();
        });

        row.appendChild(lbl);
        row.appendChild(slider);
        row.appendChild(numInput);
        body.appendChild(row);
    }

    _addWorldButton(body, label, onClick, className, tooltip = '') {
        const row = document.createElement('div');
        row.style.cssText = 'padding:3px 12px;';
        const btn = document.createElement('button');
        btn.textContent = label;
        btn.className   = `studio-btn ${className}`;
        btn.title       = tooltip;
        btn.addEventListener('click', onClick);
        row.appendChild(btn);
        body.appendChild(row);
        return btn;
    }

    // ── Right sidebar — export / import ──────────────────────────────

    _buildRightSidebar(container) {
        const saveSec = this._addSection(container, 'Save World Config');
        this._addButton(saveSec, 'Download terrain.json',       () => this._loader?.exportJSON('terrain', this._raw?.terrain));
        this._addButton(saveSec, 'Download planet.json',        () => this._loader?.exportJSON('planet', this._raw?.planet));
        this._addButton(saveSec, 'Download postprocessing.json',() => this._loader?.exportJSON('postprocessing', this._raw?.postprocessing));
        this._addButton(saveSec, 'Download engine.json',        () => this._loader?.exportJSON('engine', this._raw?.engine));

        const info = document.createElement('div');
        info.style.cssText = 'padding:8px 12px; font-size:10px; color:var(--text-dim); line-height:1.6;';
        info.textContent   = 'Download then replace the file in your world/ folder to make changes permanent.';
        saveSec.appendChild(info);

        const loadSec = this._addSection(container, 'Load World Config', false);
        this._addButton(loadSec, 'Load terrain.json…',       () => this._loadFile('terrain'));
        this._addButton(loadSec, 'Load postprocessing.json…',() => this._loadFile('postprocessing'));

        const navSec = this._addSection(container, 'Navigation', true);
        const navInfo = document.createElement('div');
        navInfo.style.cssText = 'padding:6px 12px; font-size:11px; color:var(--text-dim); line-height:1.7;';
        navInfo.innerHTML = '<b style="color:var(--text)">WASD</b> — fly<br>'
                          + '<b style="color:var(--text)">Q/E</b> — down/up<br>'
                          + '<b style="color:var(--text)">Shift</b> — boost<br>'
                          + '<b style="color:var(--text)">Drag</b> — look';
        navSec.appendChild(navInfo);
    }

    // ── Dirty state ───────────────────────────────────────────────────

    _updateDirtyUI() {
        if (this._regenBtn) {
            this._regenBtn.classList.toggle('dirty', this._dirty);
        }
        if (this._discardBtn) {
            this._discardBtn.classList.toggle('dirty', this._dirty);
        }
    }

    _snapshotRegenParams(raw) {
        // Deep clone only the regen-relevant parts
        return JSON.parse(JSON.stringify({
            terrain: raw.terrain,
        }));
    }

    _discardRegenChanges() {
        if (!this._dirty || !this._regenRaw) return;
        // Restore regen params from snapshot
        Object.assign(this._raw.terrain, JSON.parse(JSON.stringify(this._regenRaw.terrain)));
        this._dirty = false;
        this._updateDirtyUI();
        // Rebuild the sidebar to show reverted values
        this._ctx.sidebarLeft.innerHTML = '';
        this._buildLeftSidebar(this._ctx.sidebarLeft, this._raw);
        this.toast('Regen changes discarded');
    }

    _regenerate() {
        if (!this._dirty) { this.toast('No pending regen changes'); return; }
        // TODO: actually trigger world regeneration using the updated configs
        // For now: update the snapshot and clear dirty state
        this._regenRaw = this._snapshotRegenParams(this._raw);
        this._dirty    = false;
        this._updateDirtyUI();
        this.toast('World regeneration not yet wired up — save JSON and reload');
    }

    // ── Real-time param application ───────────────────────────────────

    _applyRealtime() {
        if (!this._engine || !this._raw) return;
        const pp = this._raw.postprocessing;
        if (!pp) return;
        if (pp.exposure != null) this._engine.exposure = pp.exposure;
        this._engine.setBloom?.({
            threshold:   pp.bloom?.threshold,
            knee:        pp.bloom?.knee,
            intensity:   pp.bloom?.intensity,
            blendFactor: pp.bloom?.blendFactor,
        });
    }

    // ── Input handling ────────────────────────────────────────────────

    _attachInputListeners(canvas) {
        this._onKeyDown  = (e) => { this._keys[e.key] = true; };
        this._onKeyUp    = (e) => { delete this._keys[e.key]; };
        this._onMouseDown= (e) => {
            if (e.button === 0) { this._isPointerDown = true; canvas.requestPointerLock?.(); }
        };
        this._onMouseUp  = (e) => {
            if (e.button === 0) { this._isPointerDown = false; document.exitPointerLock?.(); }
        };
        this._onMouseMove= (e) => {
            if (this._isPointerDown) {
                this._mouseDelta.x += e.movementX ?? e.offsetX;
                this._mouseDelta.y += e.movementY ?? e.offsetY;
            }
        };

        window.addEventListener('keydown',   this._onKeyDown);
        window.addEventListener('keyup',     this._onKeyUp);
        canvas.addEventListener('mousedown', this._onMouseDown);
        window.addEventListener('mouseup',   this._onMouseUp);
        canvas.addEventListener('mousemove', this._onMouseMove);
    }

    _detachInputListeners() {
        window.removeEventListener('keydown', this._onKeyDown);
        window.removeEventListener('keyup',   this._onKeyUp);
        const canvas = this._ctx?.canvas;
        if (canvas) {
            canvas.removeEventListener('mousedown', this._onMouseDown);
            canvas.removeEventListener('mousemove', this._onMouseMove);
        }
        window.removeEventListener('mouseup', this._onMouseUp);
    }

    // ── Helpers ───────────────────────────────────────────────────────

    _fmt(v, step) {
        const decimals = step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 1 : 0;
        return v.toFixed(decimals);
    }

    _showPlaceholder(text) {
        const el = document.getElementById('viewport-placeholder');
        if (!el) return;
        el.querySelector('.placeholder-label').textContent = text;
        el.style.display = 'flex';
    }

    _loadFile(key) {
        const input = Object.assign(document.createElement('input'), { type:'file', accept:'.json' });
        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            if (!file) return;
            try {
                const data = JSON.parse(await file.text());
                if (this._raw) {
                    this._raw[key] = data;
                    this._ctx.sidebarLeft.innerHTML = '';
                    this._buildLeftSidebar(this._ctx.sidebarLeft, this._raw);
                    if (key === 'postprocessing') this._applyRealtime();
                    this.toast(`Loaded ${file.name}`);
                }
            } catch (e) {
                this.toast('Failed to parse JSON');
                console.error(e);
            }
        });
        input.click();
    }
}
