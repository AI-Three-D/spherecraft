// js/ui/GameUI.js
import { MidNearDebugPanel } from './MidNearDebugPanel.js';

/**
 * Manages the in-game UI elements including HUD, crash screen, and debug controls.
 */
export class GameUI {
    constructor() {
        this.uiElement = null;
        this.crashScreen = null;
        this.debugControls = null;
        this.engine = null;
        this._surfaceRegenTimer = null;
        this._midNearPanel = null;
    }

    /**
     * Initialize all UI elements and attach them to the DOM.
     */
    setup(engine = null) {
        this.engine = engine;
        this._createMainUI();
        this._createCrashScreen();
        this._createDebugControls();
        this._createMidNearPanel();
    }

    _createMidNearPanel() {
        this._midNearPanel = new MidNearDebugPanel({ rebuildDelay: 200 });

        // Defer attachment until the asset streamer is initialized.
        // Poll briefly since initialization is async.
        const tryAttach = () => {
            const streamer = this.engine?.renderer?.assetStreamer;
            if (!streamer) {
                setTimeout(tryAttach, 500);
                return;
            }
            const lodCtrl = streamer.getLODController();
            if (!lodCtrl) {
                setTimeout(tryAttach, 500);
                return;
            }
            this._midNearPanel.attach(
                lodCtrl,
                (opts) => streamer.rebuildMidNearPipelines(opts),
                (enabled) => streamer.setMidNearRenderingEnabled(enabled)
            );
        };
        tryAttach();
    }

    /**
     * Create the main HUD overlay.
     */
    _createMainUI() {
        const ui = document.createElement('div');
        ui.id = 'game-ui';
        ui.style.cssText = `
            position: absolute;
            top: 10px;
            left: 10px;
            color: white;
            font-family: monospace;
            font-size: 14px;
            background: rgba(0,0,0,0.5);
            padding: 10px;
            border-radius: 5px;
            pointer-events: none;
            z-index: 100;
        `;
        document.body.appendChild(ui);
        this.uiElement = ui;
    }

    /**
     * Create the crash screen overlay.
     */
    _createCrashScreen() {
        const crashScreen = document.createElement('div');
        crashScreen.id = 'crash-screen';
        crashScreen.style.cssText = `
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            color: red;
            font-family: monospace;
            font-size: 48px;
            font-weight: bold;
            display: none;
            z-index: 200;
            text-shadow: 2px 2px 4px black;
        `;
        crashScreen.textContent = 'CRASHED!';
        document.body.appendChild(crashScreen);
        this.crashScreen = crashScreen;
    }

    /**
     * Create the debug controls panel.
     */
    _createDebugControls() {
        const debugControls = document.createElement('div');
        debugControls.id = 'debug-controls';
        debugControls.style.cssText = `
            position: absolute;
            bottom: 10px;
            left: 10px;
            color: white;
            font-family: monospace;
            font-size: 12px;
            background: rgba(0,0,0,0.7);
            padding: 10px;
            border-radius: 5px;
            z-index: 100;
        `;
        debugControls.innerHTML = this._getDebugControlsHTML();
        document.body.appendChild(debugControls);
        this.debugControls = debugControls;
        this._bindTerrainDebugControls();
        this._bindSurfaceControls();
        this._bindTeleportControls();
    }

    /**
     * Get the HTML content for debug controls.
     * @returns {string}
     */
    _getDebugControlsHTML() {
        return `
            <div style="margin-bottom: 5px;"><strong>DEBUG CONTROLS</strong></div>
            <div>0: Normal terrain</div>
            <div>1: Continental mask</div>
            <div>2: Plate boundaries</div>
            <div>3: Mountains</div>
            <div>4: Volcanoes</div>
            <div>5: Craters</div>
            <div>6: Basic noise</div>
            <div>7: FBM noise</div>
            <div>8: Voronoi</div>
            <div>9: Raw height</div>
            <div>25: Splat grid + raw weight</div>
            <div>26: Splat biomeA</div>
            <div>27: Splat biomeB</div>
            <div>28: Raw tile category</div>
            <div>29: Splat pair-change mask</div>
            <div>31: Splat raw weight</div>
            <div>32: Splat bilinear-valid mask</div>
            <div style="margin-top: 5px; color: #0f0;">Current: <span id="debug-mode-display">0 (Normal)</span></div>
            <div style="display: flex; gap: 6px; align-items: center; margin-top: 6px;">
                <button id="terrain-debug-prev-btn" style="font-size: 11px;">Prev</button>
                <input id="terrain-debug-mode-input" type="number" min="0" step="1" value="0" style="width: 56px; font-size: 11px;" />
                <button id="terrain-debug-apply-btn" style="font-size: 11px;">Apply</button>
                <button id="terrain-debug-next-btn" style="font-size: 11px;">Next</button>
            </div>
            <div style="margin-top: 8px; border-top: 1px solid #444; padding-top: 6px;">
                <div style="font-weight: bold; margin-bottom: 4px;">SURFACE (TILES)</div>
                <div style="display: grid; grid-template-columns: 1fr auto; gap: 4px 8px; align-items: center;">
                    <label for="surface-rock-min">Rock min</label>
                    <span id="surface-rock-min-value">0.05</span>
                    <input id="surface-rock-min" type="range" min="0" max="0.6" step="0.01" />

                    <label for="surface-rock-max">Rock max</label>
                    <span id="surface-rock-max-value">0.25</span>
                    <input id="surface-rock-max" type="range" min="0" max="0.8" step="0.01" />

                    <label for="surface-rock-slope-start">Slope start</label>
                    <span id="surface-rock-slope-start-value">0.25</span>
                    <input id="surface-rock-slope-start" type="range" min="0" max="1" step="0.01" />

                    <label for="surface-rock-slope-full">Slope full</label>
                    <span id="surface-rock-slope-full-value">0.60</span>
                    <input id="surface-rock-slope-full" type="range" min="0" max="1" step="0.01" />
                </div>
                <div style="display: flex; gap: 8px; margin-top: 6px; align-items: center;">
                    <label style="display: flex; align-items: center; gap: 4px;">
                        <input type="checkbox" id="surface-auto-regen" checked />
                        Auto regen
                    </label>
                    <button id="surface-apply-btn" style="font-size: 11px;">Apply</button>
                    <button id="surface-regen-btn" style="font-size: 11px;">Regenerate</button>
                </div>
            </div>
            <div style="margin-top: 8px; border-top: 1px solid #444; padding-top: 6px;">
                <div style="font-weight: bold; margin-bottom: 4px;">TELEPORT</div>
                <div style="display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 6px;">
                    <button data-teleport-lat="90" data-teleport-lon="0" style="font-size: 11px;">North Pole</button>
                    <button data-teleport-lat="-90" data-teleport-lon="0" style="font-size: 11px;">South Pole</button>
                </div>
                <div style="font-size: 11px; margin-bottom: 4px;">Equator</div>
                <div style="display: grid; grid-template-columns: repeat(4, auto); gap: 4px 6px; margin-bottom: 6px;">
                    <button data-teleport-lat="0" data-teleport-lon="0" style="font-size: 11px;">0</button>
                    <button data-teleport-lat="0" data-teleport-lon="90" style="font-size: 11px;">90E</button>
                    <button data-teleport-lat="0" data-teleport-lon="180" style="font-size: 11px;">180</button>
                    <button data-teleport-lat="0" data-teleport-lon="-90" style="font-size: 11px;">90W</button>
                </div>
                <div style="font-size: 11px; margin-bottom: 4px;">+45 Latitude</div>
                <div style="display: grid; grid-template-columns: repeat(4, auto); gap: 4px 6px; margin-bottom: 6px;">
                    <button data-teleport-lat="45" data-teleport-lon="0" style="font-size: 11px;">0</button>
                    <button data-teleport-lat="45" data-teleport-lon="90" style="font-size: 11px;">90E</button>
                    <button data-teleport-lat="45" data-teleport-lon="180" style="font-size: 11px;">180</button>
                    <button data-teleport-lat="45" data-teleport-lon="-90" style="font-size: 11px;">90W</button>
                </div>
                <div style="font-size: 11px; margin-bottom: 4px;">-45 Latitude</div>
                <div style="display: grid; grid-template-columns: repeat(4, auto); gap: 4px 6px;">
                    <button data-teleport-lat="-45" data-teleport-lon="0" style="font-size: 11px;">0</button>
                    <button data-teleport-lat="-45" data-teleport-lon="90" style="font-size: 11px;">90E</button>
                    <button data-teleport-lat="-45" data-teleport-lon="180" style="font-size: 11px;">180</button>
                    <button data-teleport-lat="-45" data-teleport-lon="-90" style="font-size: 11px;">90W</button>
                </div>
            </div>
        `;
    }

    _bindSurfaceControls() {
        const panel = this.debugControls;
        if (!panel) return;

        const defaults = this._getSurfaceDefaults();
        const controls = [
            { id: 'surface-rock-min', valueId: 'surface-rock-min-value', key: 'rockCoverageMin', value: defaults.rockCoverageMin },
            { id: 'surface-rock-max', valueId: 'surface-rock-max-value', key: 'rockCoverageMax', value: defaults.rockCoverageMax },
            { id: 'surface-rock-slope-start', valueId: 'surface-rock-slope-start-value', key: 'rockSlopeStart', value: defaults.rockSlopeStart },
            { id: 'surface-rock-slope-full', valueId: 'surface-rock-slope-full-value', key: 'rockSlopeFull', value: defaults.rockSlopeFull }
        ];

        const autoRegen = panel.querySelector('#surface-auto-regen');
        const applyBtn = panel.querySelector('#surface-apply-btn');
        const regenBtn = panel.querySelector('#surface-regen-btn');

        const updateDisplay = (ctrl, value) => {
            const label = panel.querySelector(`#${ctrl.valueId}`);
            if (label) label.textContent = Number(value).toFixed(2);
        };

        const applyParams = (regenerate = false) => {
            if (!this.engine?.applySurfaceParams) return;
            const params = {};
            for (const ctrl of controls) {
                const input = panel.querySelector(`#${ctrl.id}`);
                if (!input) continue;
                params[ctrl.key] = parseFloat(input.value);
            }
            this.engine.applySurfaceParams(params, { regenerate });
        };

        const scheduleRegen = () => {
            if (!autoRegen?.checked) return;
            if (this._surfaceRegenTimer) {
                clearTimeout(this._surfaceRegenTimer);
            }
            this._surfaceRegenTimer = setTimeout(() => {
                applyParams(true);
            }, 250);
        };

        for (const ctrl of controls) {
            const input = panel.querySelector(`#${ctrl.id}`);
            if (!input) continue;
            input.value = String(ctrl.value);
            updateDisplay(ctrl, ctrl.value);
            input.addEventListener('input', () => {
                updateDisplay(ctrl, input.value);
                applyParams(false);
                scheduleRegen();
            });
        }

        applyBtn?.addEventListener('click', () => applyParams(false));
        regenBtn?.addEventListener('click', () => applyParams(true));
    }

    _getSurfaceDefaults() {
        const surface = this.engine?.planetConfig?.terrainGeneration?.surface;
        return {
            rockCoverageMin: surface?.rockCoverageMin ?? 0.05,
            rockCoverageMax: surface?.rockCoverageMax ?? 0.25,
            rockSlopeStart: surface?.rockSlopeStart ?? 0.25,
            rockSlopeFull: surface?.rockSlopeFull ?? 0.6
        };
    }

    _bindTeleportControls() {
        const panel = this.debugControls;
        if (!panel) return;

        const buttons = panel.querySelectorAll('[data-teleport-lat]');
        buttons.forEach((btn) => {
            btn.addEventListener('click', () => {
                const lat = parseFloat(btn.getAttribute('data-teleport-lat'));
                const lon = parseFloat(btn.getAttribute('data-teleport-lon'));
                if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
                this.engine?.teleportToLatLon?.(lat, lon);
            });
        });
    }

    _bindTerrainDebugControls() {
        const panel = this.debugControls;
        if (!panel) return;

        const input = panel.querySelector('#terrain-debug-mode-input');
        const applyBtn = panel.querySelector('#terrain-debug-apply-btn');
        const prevBtn = panel.querySelector('#terrain-debug-prev-btn');
        const nextBtn = panel.querySelector('#terrain-debug-next-btn');

        const getCurrentMode = () => this.engine?.engineConfig?.debug?.terrainFragmentDebugMode ?? 0;

        const applyMode = async (mode) => {
            const nextMode = Math.max(0, Math.floor(Number(mode) || 0));
            if (input) input.value = String(nextMode);
            await this.engine?.setTerrainDebugMode?.(nextMode);
        };

        if (input) {
            input.value = String(getCurrentMode());
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    applyMode(input.value);
                }
            });
        }

        applyBtn?.addEventListener('click', () => applyMode(input?.value));
        prevBtn?.addEventListener('click', () => applyMode(getCurrentMode() - 1));
        nextBtn?.addEventListener('click', () => applyMode(getCurrentMode() + 1));
    }

    /**
     * Update the main HUD with current game state.
     * @param {Object} params
     * @param {number} params.fps - Current frames per second
     * @param {string} params.cameraMode - 'follow' or 'manual'
     * @param {Object} params.shipState - Spaceship state from spaceship.getState()
     * @param {Object|null} params.zoneInfo - Altitude zone info or null
     */
    update({ fps, cameraMode, shipState, zoneInfo }) {
        if (!this.uiElement) return;

        const fpsInfo = this._buildFPSInfo(fps);
        const controlsInfo = this._buildControlsInfo(cameraMode);
        const flightInfo = this._buildFlightInfo(shipState);
        const altitudeInfo = this._buildAltitudeInfo(zoneInfo);

        this.uiElement.innerHTML = fpsInfo + controlsInfo + flightInfo + altitudeInfo;
    }

    /**
     * Build the FPS display HTML.
     * @param {number} fps
     * @returns {string}
     */
    _buildFPSInfo(fps) {
        return `
            <div style="font-size: 11px; color: #0ff; margin-bottom: 6px;">
                FPS: ${fps.toFixed(1)}
            </div>
        `;
    }

    /**
     * Build the controls info HTML based on camera mode.
     * @param {string} cameraMode
     * @returns {string}
     */
    _buildControlsInfo(cameraMode) {
        if (cameraMode === 'follow') {
            return `
                <div style="color: #00ff00; font-size: 12px;">
                    <strong>FLIGHT MODE</strong><br>
                    <div style="font-size: 10px; line-height: 1.3; margin-left: 10px;">
                        W/S: Throttle | A/D: Turn<br>
                        Z/X: Pitch | Q/E: Vertical<br>
                        Mouse Drag: Orbit Camera<br>
                        Wheel: Zoom | V: Free Cam
                    </div>
                </div>
            `;
        } else {
            return `
                <div style="color: #ffff00; font-size: 12px;">
                    <strong>FREE CAMERA</strong><br>
                    <div style="font-size: 10px;">
                        WASD: Move | QE: Up/Down<br>
                        Shift: Fast | Drag: Look<br>
                        V: Follow Mode
                    </div>
                </div>
            `;
        }
    }

    /**
     * Build the flight info HTML.
     * @param {Object} shipState
     * @returns {string}
     */
    _buildFlightInfo(shipState) {
        return `
            <div style="margin-top: 8px; border-top: 1px solid #555; padding-top: 5px;">
                <strong style="font-size: 11px;">SHIP</strong><br>
                <div style="font-family: 'Courier New'; font-size: 10px; line-height: 1.3;">
                Speed: <span style="color: #0ff;">${shipState.speed.toFixed(1)}</span><br>
                Pos: ${shipState.position.x.toFixed(0)}, ${shipState.position.y.toFixed(0)}, ${shipState.position.z.toFixed(0)}
                </div>
            </div>
        `;
    }

    /**
     * Build the altitude/planet info HTML.
     * @param {Object|null} zoneInfo
     * @returns {string}
     */
    _buildAltitudeInfo(zoneInfo) {
        if (!zoneInfo) return '';

        return `
            <div style="margin-top: 8px; border-top: 1px solid #555; padding-top: 5px;">
                <strong style="font-size: 11px;">PLANET</strong><br>
                <div style="font-family: 'Courier New'; font-size: 10px; line-height: 1.3;">
                Altitude: <span style="color: #0ff;">${zoneInfo.altitude.toFixed(0)}m</span><br>
                Zone: <span style="color: #ff0;">${zoneInfo.zone.toUpperCase()}</span><br>
                Horizon: ${zoneInfo.horizonDistance.toFixed(0)}m<br>
                Terrain: ${(zoneInfo.terrainBlend * 100).toFixed(0)}%<br>
                Orbital: ${(zoneInfo.orbitalBlend * 100).toFixed(0)}%
                </div>
            </div>
        `;
    }

    /**
     * Update the debug mode display.
     * @param {number} mode
     * @param {string} modeName
     */
    updateDebugModeDisplay(mode, modeName) {
        const display = document.getElementById('debug-mode-display');
        if (display) {
            display.textContent = `${mode} (${modeName})`;
        }
    }

    /**
     * Show the crash screen.
     */
    showCrashScreen() {
        if (this.crashScreen) {
            this.crashScreen.style.display = 'block';
        }
    }

    /**
     * Hide the crash screen.
     */
    hideCrashScreen() {
        if (this.crashScreen) {
            this.crashScreen.style.display = 'none';
        }
    }

    /**
     * Clean up and remove all UI elements from the DOM.
     */
    destroy() {
        this._midNearPanel?.dispose();   
        this._midNearPanel = null;         
        if (this.uiElement) {
            this.uiElement.remove();
            this.uiElement = null;
        }
        if (this.crashScreen) {
            this.crashScreen.remove();
            this.crashScreen = null;
        }
        if (this.debugControls) {
            this.debugControls.remove();
            this.debugControls = null;
        }
        this.engine = null;
        if (this._surfaceRegenTimer) {
            clearTimeout(this._surfaceRegenTimer);
            this._surfaceRegenTimer = null;
        }
    }
}
