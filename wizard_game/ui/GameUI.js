// js/ui/GameUI.js
import { MidNearDebugPanel } from '../../tools/MidNearDebugPanel.js';
import { clamp01 } from '../../shared/math/index.js';

/**
 * Manages the in-game UI elements including HUD, crash screen, and debug controls.
 */
export class GameUI {
    constructor() {
        this.uiElement = null;
        this._hudContent = null;
        this._debugToggleButton = null;
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
            right: 10px;
            width: min(380px, calc(100vw - 20px));
            display: flex;
            flex-direction: column;
            align-items: stretch;
            gap: 10px;
            pointer-events: none;
            z-index: 100;
        `;

        const hudContent = document.createElement('div');
        hudContent.style.cssText = 'pointer-events: none;';
        ui.appendChild(hudContent);

        const debugToggle = document.createElement('button');
        debugToggle.id = 'debug-toggle-btn';
        debugToggle.textContent = 'Debug Controls';
        debugToggle.style.cssText = `
            align-self: flex-end;
            pointer-events: auto;
            border: 1px solid rgba(180, 233, 255, 0.45);
            border-radius: 999px;
            padding: 8px 14px;
            color: #eaf8ff;
            font-family: Georgia, "Times New Roman", serif;
            font-size: 12px;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            background:
                linear-gradient(180deg, rgba(110, 180, 215, 0.28), rgba(10, 28, 40, 0.68)),
                rgba(6, 14, 22, 0.78);
            box-shadow:
                inset 0 1px 0 rgba(255,255,255,0.28),
                0 10px 24px rgba(0,0,0,0.28);
            cursor: pointer;
        `;
        ui.appendChild(debugToggle);

        document.body.appendChild(ui);
        this.uiElement = ui;
        this._hudContent = hudContent;
        this._debugToggleButton = debugToggle;
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
            display: none;
            pointer-events: auto;
            color: white;
            font-family: Georgia, "Times New Roman", serif;
            font-size: 12px;
            background:
                linear-gradient(180deg, rgba(80, 126, 149, 0.22), rgba(8, 18, 28, 0.84)),
                rgba(4, 10, 18, 0.82);
            padding: 12px;
            border-radius: 18px;
            border: 1px solid rgba(170, 220, 242, 0.28);
            box-shadow:
                inset 0 1px 0 rgba(255,255,255,0.15),
                0 16px 40px rgba(0,0,0,0.28);
            z-index: 100;
        `;
        debugControls.innerHTML = this._getDebugControlsHTML();
        this.uiElement?.appendChild(debugControls);
        this.debugControls = debugControls;

        this._debugToggleButton?.addEventListener('click', () => {
            const nextVisible = debugControls.style.display === 'none';
            debugControls.style.display = nextVisible ? 'block' : 'none';
            this._debugToggleButton.textContent = nextVisible ? 'Hide Debug' : 'Debug Controls';
        });

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
            <div style="margin-bottom: 5px; letter-spacing: 0.08em;"><strong>DEBUG CONTROLS</strong></div>
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
            <div>30: Raw height</div>
            <div>31: Splat raw weight</div>
            <div>32: Splat bilinear-valid mask</div>
            <div>33: Fallback / stitch risk</div>
            <div>34: Atlas bleed risk</div>
            <div style="margin-top: 5px; color: #9affcf;">Current: <span id="debug-mode-display">0 (Normal)</span></div>
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
    update({ fps, cameraMode, shipState, zoneInfo, playerStatus }) {
        if (!this._hudContent) return;

        const fpsInfo = this._buildFPSInfo(fps);
        const vitalsInfo = this._buildVitalsInfo(playerStatus);
        const controlsInfo = this._buildControlsInfo(cameraMode);
        const modeInfo = cameraMode === 'character'
            ? this._buildCharacterInfo(playerStatus)
            : this._buildFlightInfo(shipState);
        const altitudeInfo = this._buildAltitudeInfo(zoneInfo);

        this._hudContent.innerHTML = fpsInfo + vitalsInfo + controlsInfo + modeInfo + altitudeInfo;
    }

    _buildFPSInfo(fps) {
        return `
            <div style="
                font-family: Georgia, 'Times New Roman', serif;
                font-size: 11px;
                color: #bcefff;
                text-align: right;
                letter-spacing: 0.12em;
                text-transform: uppercase;
                margin-bottom: 8px;
                text-shadow: 0 1px 3px rgba(0,0,0,0.45);
            ">
                FPS: ${fps.toFixed(1)}
            </div>
        `;
    }

    _buildControlsInfo(cameraMode) {
        if (cameraMode === 'character') {
            return `
                <div style="${this._buildInfoCardStyle()}">
                    <strong style="color:#d9f8ff; letter-spacing:0.1em;">WIZARD</strong><br>
                    <div style="font-size: 10px; line-height: 1.45; color: #d7e8ef; margin-top: 6px;">
                        WASD: Move | Shift: Run | Click: Move To<br>
                        Right Drag: Turn | Left Drag: Orbit<br>
                        Wheel: Zoom | V: Free Cam
                    </div>
                </div>
            `;
        }

        if (cameraMode === 'follow') {
            return `
                <div style="${this._buildInfoCardStyle()}">
                    <strong style="color:#d9f8ff; letter-spacing:0.1em;">FLIGHT MODE</strong><br>
                    <div style="font-size: 10px; line-height: 1.45; color: #d7e8ef; margin-top: 6px;">
                        W/S: Throttle | A/D: Turn<br>
                        Z/X: Pitch | Q/E: Vertical<br>
                        Mouse Drag: Orbit Camera<br>
                        Wheel: Zoom | V: Free Cam
                    </div>
                </div>
            `;
        }

        return `
            <div style="${this._buildInfoCardStyle()}">
                <strong style="color:#d9f8ff; letter-spacing:0.1em;">FREE CAMERA</strong><br>
                <div style="font-size: 10px; line-height: 1.45; color: #d7e8ef; margin-top: 6px;">
                    WASD: Move | QE: Up/Down<br>
                    Shift: Fast | Drag: Look<br>
                    V: Follow Mode
                </div>
            </div>
        `;
    }

    _buildVitalsInfo(playerStatus) {
        if (!playerStatus) return '';

        const healthRatio = clamp01(playerStatus.healthRatio ?? 0);
        const staminaRatio = clamp01(playerStatus.staminaRatio ?? 0);
        const hungerRatio = clamp01(playerStatus.hungerRatio ?? 0);
        const temperatureRatio = clamp01(playerStatus.temperatureRatio ?? 0.5);

        const healthBar = this._buildVialBar('Health', playerStatus.health, playerStatus.maxHealth, healthRatio, {
            fill: playerStatus.isDown
                ? 'linear-gradient(90deg, rgba(110,110,110,0.85), rgba(160,160,160,0.55))'
                : healthRatio > 0.6
                    ? 'linear-gradient(90deg, rgba(94, 25, 32, 0.95), rgba(235, 74, 84, 0.85))'
                    : healthRatio > 0.3
                        ? 'linear-gradient(90deg, rgba(110, 42, 26, 0.95), rgba(230, 136, 70, 0.85))'
                        : 'linear-gradient(90deg, rgba(84, 12, 18, 0.98), rgba(190, 28, 45, 0.9))',
            accent: '#ffd7d9',
            caption: playerStatus.isDown ? 'Down' : 'Life force',
        });
        const staminaBar = this._buildVialBar('Stamina', playerStatus.stamina, playerStatus.maxStamina, staminaRatio, {
            fill: playerStatus.isExhausted
                ? 'linear-gradient(90deg, rgba(88, 92, 98, 0.88), rgba(154, 161, 170, 0.65))'
                : 'linear-gradient(90deg, rgba(34, 113, 112, 0.96), rgba(61, 225, 206, 0.88))',
            accent: '#dcfffa',
            caption: playerStatus.isExhausted ? 'Exhausted' : (playerStatus.isSprinting ? 'Burning fast' : 'Recovering'),
        });
        const hungerBar = this._buildVialBar('Hunger', playerStatus.hunger, playerStatus.maxHunger, hungerRatio, {
            fill: 'linear-gradient(90deg, rgba(100, 66, 14, 0.95), rgba(232, 183, 64, 0.88))',
            accent: '#fff1c2',
            caption: hungerRatio < 0.25 ? 'Starving' : 'Fed',
        });
        const temperatureBar = this._buildVialBar(
            'Temperature',
            playerStatus.temperature,
            playerStatus.maxTemperature,
            temperatureRatio,
            this._getTemperatureBarStyle(temperatureRatio)
        );

        return `
            <div style="
                background:
                    radial-gradient(circle at top left, rgba(171, 232, 255, 0.16), transparent 42%),
                    linear-gradient(180deg, rgba(30, 53, 69, 0.54), rgba(6, 14, 24, 0.8));
                border: 1px solid rgba(170, 220, 242, 0.24);
                border-radius: 24px;
                padding: 14px 16px 12px;
                box-shadow:
                    inset 0 1px 0 rgba(255,255,255,0.22),
                    0 18px 38px rgba(0,0,0,0.28);
                backdrop-filter: blur(10px);
            ">
                <div style="
                    font-family: Georgia, 'Times New Roman', serif;
                    font-size: 11px;
                    letter-spacing: 0.14em;
                    text-transform: uppercase;
                    color: #e4f7ff;
                    text-align: right;
                    margin-bottom: 10px;
                ">
                    Wizard Vitals
                </div>
                ${healthBar}
                ${staminaBar}
                ${hungerBar}
                ${temperatureBar}
                <div style="
                    margin-top: 10px;
                    font-family: Georgia, 'Times New Roman', serif;
                    font-size: 11px;
                    line-height: 1.45;
                    color: #dbeff7;
                    text-align: right;
                ">
                    <span style="color: ${playerStatus.isDown ? '#ff8f8f' : '#bdefff'};">${playerStatus.statusText ?? 'Ready'}</span><br>
                    Threats nearby: ${playerStatus.activeThreats ?? 0}
                </div>
            </div>
        `;
    }

    _buildCharacterInfo(playerStatus) {
        if (!playerStatus) return '';

        return `
            <div style="${this._buildInfoCardStyle()}">
                <strong style="color:#d9f8ff; letter-spacing:0.1em;">STATE</strong><br>
                <div style="font-size: 10px; line-height: 1.45; color: #d7e8ef; margin-top: 6px;">
                    Motion: <span style="color:${playerStatus.isSprinting ? '#8ffff1' : '#bdefff'};">${playerStatus.isSprinting ? 'Running' : 'Ready'}</span><br>
                    Condition: <span style="color:${playerStatus.isDown ? '#ff8f8f' : '#f3fbff'};">${playerStatus.statusText ?? 'Ready'}</span>
                </div>
            </div>
        `;
    }

    _buildFlightInfo(shipState) {
        return `
            <div style="${this._buildInfoCardStyle()}">
                <strong style="color:#d9f8ff; letter-spacing:0.1em;">SHIP</strong><br>
                <div style="font-size: 10px; line-height: 1.45; color: #d7e8ef; margin-top: 6px;">
                    Speed: <span style="color: #bdefff;">${shipState.speed.toFixed(1)}</span><br>
                    Pos: ${shipState.position.x.toFixed(0)}, ${shipState.position.y.toFixed(0)}, ${shipState.position.z.toFixed(0)}
                </div>
            </div>
        `;
    }

    _buildAltitudeInfo(zoneInfo) {
        if (!zoneInfo) return '';

        return `
            <div style="${this._buildInfoCardStyle()}">
                <strong style="color:#d9f8ff; letter-spacing:0.1em;">PLANET</strong><br>
                <div style="font-size: 10px; line-height: 1.45; color: #d7e8ef; margin-top: 6px;">
                    Altitude: <span style="color: #bdefff;">${zoneInfo.altitude.toFixed(0)}m</span><br>
                    Zone: <span style="color: #fff2a8;">${zoneInfo.zone.toUpperCase()}</span><br>
                    Horizon: ${zoneInfo.horizonDistance.toFixed(0)}m<br>
                    Terrain: ${(zoneInfo.terrainBlend * 100).toFixed(0)}%<br>
                    Orbital: ${(zoneInfo.orbitalBlend * 100).toFixed(0)}%
                </div>
            </div>
        `;
    }

    _buildInfoCardStyle() {
        return `
            margin-top: 8px;
            background:
                linear-gradient(180deg, rgba(24, 46, 62, 0.55), rgba(5, 12, 20, 0.72));
            border: 1px solid rgba(170, 220, 242, 0.22);
            border-radius: 18px;
            padding: 10px 14px;
            font-family: Georgia, 'Times New Roman', serif;
            box-shadow:
                inset 0 1px 0 rgba(255,255,255,0.16),
                0 12px 30px rgba(0,0,0,0.22);
        `;
    }

    _buildVialBar(label, value, maxValue, ratio, style) {
        const safeMax = Math.max(1, maxValue ?? 1);
        const safeValue = Math.max(0, Math.min(safeMax, value ?? safeMax));
        const fillWidth = clamp01(Number(ratio) || 0) * 100;
        const widthCss = fillWidth > 0 ? `calc(${fillWidth.toFixed(1)}% - 4px)` : '0';
        return `
            <div style="margin-bottom: 8px;">
                <div style="
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 4px;
                    font-family: Georgia, 'Times New Roman', serif;
                    font-size: 11px;
                    letter-spacing: 0.08em;
                    text-transform: uppercase;
                    color: #edf9ff;
                ">
                    <span>${label}</span>
                    <span style="color:#c7eaf5;">${safeValue.toFixed(0)} / ${safeMax.toFixed(0)}</span>
                </div>
                <div style="
                    position: relative;
                    height: 18px;
                    overflow: hidden;
                    border-radius: 999px;
                    border: 1px solid rgba(222, 245, 255, 0.32);
                    background:
                        linear-gradient(180deg, rgba(255,255,255,0.18), rgba(255,255,255,0.03)),
                        rgba(7, 16, 24, 0.72);
                    box-shadow:
                        inset 0 2px 4px rgba(255,255,255,0.08),
                        inset 0 -6px 12px rgba(0,0,0,0.22);
                ">
                    <div style="
                        position: absolute;
                        inset: 2px auto 2px 2px;
                        width: ${widthCss};
                        min-width: ${fillWidth > 0 ? '10px' : '0'};
                        border-radius: 999px;
                        background: ${style.fill};
                        box-shadow:
                            inset 0 1px 0 rgba(255,255,255,0.35),
                            0 0 16px rgba(0,0,0,0.18);
                    "></div>
                    <div style="
                        position: absolute;
                        top: 3px;
                        left: 8px;
                        right: 8px;
                        height: 4px;
                        border-radius: 999px;
                        background: linear-gradient(90deg, rgba(255,255,255,0.34), rgba(255,255,255,0.04));
                    "></div>
                    <div style="
                        position: absolute;
                        inset: 0;
                        border-radius: 999px;
                        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.08);
                    "></div>
                </div>
                <div style="
                    font-size: 10px;
                    color:${style.accent};
                    text-align:right;
                    margin-top: 3px;
                    font-family: Georgia, 'Times New Roman', serif;
                ">
                    ${style.caption ?? ''}
                </div>
            </div>
        `;
    }

    _getTemperatureBarStyle(ratio) {
        let fill = 'linear-gradient(90deg, rgba(41, 171, 123, 0.96), rgba(103, 229, 149, 0.88))';
        let accent = '#dbffe9';
        let caption = 'Stable';

        if (ratio < 0.5) {
            if (ratio < 0.2) {
                fill = 'linear-gradient(90deg, rgba(18, 74, 162, 0.98), rgba(77, 164, 255, 0.88))';
                accent = '#d2ebff';
                caption = 'Freezing';
            } else {
                fill = 'linear-gradient(90deg, rgba(24, 112, 198, 0.96), rgba(92, 208, 255, 0.88))';
                accent = '#def6ff';
                caption = 'Cold';
            }
        } else if (ratio > 0.5) {
            if (ratio > 0.8) {
                fill = 'linear-gradient(90deg, rgba(190, 46, 18, 0.98), rgba(255, 116, 66, 0.9))';
                accent = '#ffe0d0';
                caption = 'Heat stroke risk';
            } else if (ratio > 0.65) {
                fill = 'linear-gradient(90deg, rgba(210, 122, 18, 0.96), rgba(255, 194, 74, 0.9))';
                accent = '#fff0c9';
                caption = 'Hot';
            } else {
                fill = 'linear-gradient(90deg, rgba(107, 182, 33, 0.96), rgba(217, 233, 82, 0.88))';
                accent = '#f3ffd4';
                caption = 'Warm';
            }
        }

        return { fill, accent, caption };
    }

    updateDebugModeDisplay(mode, modeName) {
        const display = document.getElementById('debug-mode-display');
        if (display) {
            display.textContent = `${mode} (${modeName})`;
        }
    }

    showCrashScreen() {
        if (this.crashScreen) {
            this.crashScreen.style.display = 'block';
        }
    }

    hideCrashScreen() {
        if (this.crashScreen) {
            this.crashScreen.style.display = 'none';
        }
    }

    destroy() {
        this._midNearPanel?.dispose();
        this._midNearPanel = null;
        if (this.uiElement) {
            this.uiElement.remove();
            this.uiElement = null;
        }
        this._hudContent = null;
        this._debugToggleButton = null;
        if (this.crashScreen) {
            this.crashScreen.remove();
            this.crashScreen = null;
        }
        this.debugControls = null;
        this.engine = null;
        if (this._surfaceRegenTimer) {
            clearTimeout(this._surfaceRegenTimer);
            this._surfaceRegenTimer = null;
        }
    }
}
