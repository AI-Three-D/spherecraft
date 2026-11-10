/**
 * Studio.js — Spherecraft Studio application shell.
 *
 * Responsibilities:
 *   - Declare all views and their tab metadata
 *   - Build the tab bar and wire click handlers
 *   - Manage view lifecycle: init → activate ↔ deactivate → destroy
 *   - Provide the StudioContext object passed into every view
 *   - Maintain the status bar FPS counter
 *   - Provide toast notifications
 */

import { StudioView }         from './StudioView.js';
import { WorldView }          from './views/WorldView.js';
import { ParticleView }       from './views/ParticleView.js';
import { GlbAssetView }       from './views/GlbAssetView.js';
import { TextureView }        from './views/TextureView.js';
import { ProceduralMeshView } from './views/ProceduralMeshView.js';
import { ProfilerView }       from './views/ProfilerView.js';

// ── Tab manifest ────────────────────────────────────────────────────────────
// Order here = order in the tab bar.
const TABS = [
    { id: 'world',       label: 'World',       icon: '🌍', View: WorldView          },
    { id: 'particles',   label: 'Particles',   icon: '🔥', View: ParticleView        },
    { id: 'glb-asset',   label: 'GLB Asset',   icon: '📦', View: GlbAssetView        },
    { id: 'texture',     label: 'Texture',     icon: '🎨', View: TextureView         },
    { id: 'proc-mesh',   label: 'Proc Mesh',   icon: '⬡',  View: ProceduralMeshView  },
    { id: 'profiler',    label: 'Profiler',    icon: '📊', View: ProfilerView        },
];

// ── StudioContext ────────────────────────────────────────────────────────────
/**
 * Shared context passed into every view's onInit().
 * Views must not hold references to each other — use the event bus instead.
 *
 * @typedef {object} StudioContext
 * @property {HTMLCanvasElement}  canvas
 * @property {HTMLElement}        sidebarLeft      - cleared before each view init
 * @property {HTMLElement}        sidebarRight     - cleared before each view init
 * @property {HTMLElement}        sidebarLeftTitle
 * @property {HTMLElement}        sidebarRightTitle
 * @property {EventTarget}        bus              - lightweight event bus
 * @property {function(string):void} toast
 * @property {function():void}    updateStats      - called by base view each frame
 */

// ── Studio ────────────────────────────────────────────────────────────────
export class Studio {
    /**
     * @param {Object} [options]
     * @param {Object} [options.viewOverrides]  Map of tab id → View class, e.g. { world: WorldEditorView }
     */
    constructor(options = {}) {
        this._viewOverrides = options.viewOverrides ?? {};
        /** @type {Map<string, StudioView>} */
        this._views = new Map();
        /** @type {StudioView|null} */
        this._active = null;
        this._activeId = null;

        // FPS tracking
        this._frameCount = 0;
        this._fpsSampleStart = performance.now();
        this._fps = 0;
        this._frameIndex = 0;

        this._context = this._buildContext();
    }

    // ── Bootstrap ───────────────────────────────────────────────────

    async start() {
        this._buildTabBar();
        this._instantiateViews();

        // Activate the first tab by default (or hash if provided)
        const hash = location.hash.replace('#', '');
        const startId = TABS.find(t => t.id === hash)?.id ?? TABS[0].id;
        await this._switchTo(startId);
    }

    // ── Context ──────────────────────────────────────────────────────

    _buildContext() {
        const canvas           = document.getElementById('studio-canvas');
        const sidebarLeft      = document.getElementById('sidebar-left-content');
        const sidebarRight     = document.getElementById('sidebar-right-content');
        const sidebarLeftTitle  = document.getElementById('sidebar-left-title');
        const sidebarRightTitle = document.getElementById('sidebar-right-title');
        const bus              = new EventTarget();

        const ctx = {
            canvas,
            sidebarLeft,
            sidebarRight,
            sidebarLeftTitle,
            sidebarRightTitle,
            bus,
            toast:       (msg) => this._showToast(msg),
            updateStats: ()    => this._tickStats(),
        };
        return ctx;
    }

    // ── Tab bar ──────────────────────────────────────────────────────

    _buildTabBar() {
        const bar = document.getElementById('tab-bar');
        for (const tab of TABS) {
            const btn = document.createElement('button');
            btn.className = 'tab-btn';
            btn.dataset.tabId = tab.id;
            btn.innerHTML = `<span class="tab-icon">${tab.icon}</span>${tab.label}`;
            btn.addEventListener('click', () => this._switchTo(tab.id));
            bar.appendChild(btn);
        }
    }

    _setActiveTab(id) {
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tabId === id);
        });
        document.getElementById('status-view-name').textContent = id;
        location.hash = id;
    }

    // ── View management ──────────────────────────────────────────────

    _instantiateViews() {
        for (const tab of TABS) {
            const ViewClass = this._viewOverrides[tab.id] ?? tab.View;
            this._views.set(tab.id, new ViewClass(tab.id));
        }
    }

    async _switchTo(id) {
        if (id === this._activeId) return;

        // Deactivate current
        if (this._active) {
            this._active._deactivate();
        }

        const view = this._views.get(id);
        if (!view) {
            console.warn(`[Studio] Unknown view id: ${id}`);
            return;
        }

        // Clear sidebars
        this._clearSidebars(id);

        // Init if first visit
        if (!view._initialized) {
            try {
                await view._init(this._context);
            } catch (err) {
                console.error(`[Studio] Error initialising view "${id}":`, err);
                this._showToast(`Error loading ${id}`);
                return;
            }
        }

        this._active   = view;
        this._activeId = id;
        this._setActiveTab(id);

        // Hide/show viewport placeholder based on whether view uses canvas
        this._setPlaceholder(!view.usesCanvas);

        try {
            await view._activate();
        } catch (err) {
            console.error(`[Studio] Error activating view "${id}":`, err);
        }
    }

    _clearSidebars(nextId) {
        const tab = TABS.find(t => t.id === nextId);
        this._context.sidebarLeft.innerHTML       = '';
        this._context.sidebarRight.innerHTML      = '';
        this._context.sidebarLeftTitle.textContent  = tab?.label ?? nextId;
        this._context.sidebarRightTitle.textContent = 'Properties';
        document.getElementById('stat-extra').innerHTML = '';
    }

    // ── Viewport placeholder ─────────────────────────────────────────

    _setPlaceholder(show) {
        const el = document.getElementById('viewport-placeholder');
        if (el) el.style.display = show ? 'flex' : 'none';
    }

    // ── Stats ────────────────────────────────────────────────────────

    _tickStats() {
        this._frameCount++;
        this._frameIndex++;
        const now  = performance.now();
        const elapsed = now - this._fpsSampleStart;
        if (elapsed >= 500) {
            this._fps = Math.round((this._frameCount * 1000) / elapsed);
            this._frameCount    = 0;
            this._fpsSampleStart = now;
            document.getElementById('stat-fps').textContent   = this._fps;
            document.getElementById('stat-frame').textContent = this._frameIndex;
        }
    }

    // ── Toast ────────────────────────────────────────────────────────

    _showToast(msg) {
        const el = document.getElementById('toast');
        if (!el) return;
        el.textContent = msg;
        el.classList.add('show');
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
    }

    // ── Shutdown ─────────────────────────────────────────────────────

    destroy() {
        for (const view of this._views.values()) {
            view._destroy();
        }
    }
}

// ── Convenience factory ──────────────────────────────────────────────────────
/**
 * Create and start a Studio instance.
 * @param {Object} [options]  Same options as the Studio constructor.
 * @returns {Studio}
 */
export function startStudio(options = {}) {
    const studio = new Studio(options);
    studio.start().catch(console.error);
    window._studio = studio;
    return studio;
}
