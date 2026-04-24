// platform_game/ui/PlatformGameUI.js
//
// Minimal HUD for the platform jumper. Intentionally does NOT inherit
// from wizard_game's GameUI — that class is loaded with wizard-specific
// debug panels (terrain tools, mid/near asset debug, postprocessing
// export, wizard vitals, spaceship telemetry) that don't belong in
// this game.
//
// Implements exactly the surface GameEngine touches:
//   - setup(engine)
//   - update({ fps, cameraMode, shipState, zoneInfo, playerStatus })
//   - showCrashScreen() / hideCrashScreen()
//   - updateDebugModeDisplay(mode, name)   — no-op for now

export class PlatformGameUI {
    constructor() {
        this.engine = null;
        this._root = null;
        this._lines = null;
        this._crash = null;
    }

    setup(engine) {
        this.engine = engine;

        // Re-use the HUD container already in standalone.html so we
        // don't fight the stylesheet there.
        this._root = document.getElementById('hud');
        if (!this._root) return;

        // Replace the static content with labelled rows we'll update.
        this._root.innerHTML = `
            <div><span style="color:#91c7ff">Platform Jumper</span></div>
            <div><span style="color:#91c7ff">Move:</span> WASD &nbsp; <span style="color:#91c7ff">Look:</span> Right-drag &nbsp; <span style="color:#91c7ff">Jump:</span> Space</div>
            <div><span style="color:#91c7ff">FPS:</span> <span data-k="fps">–</span>
                 &nbsp; <span style="color:#91c7ff">Mode:</span> <span data-k="mode">–</span></div>
            <div><span style="color:#91c7ff">Health:</span> <span data-k="health">–</span>
                 &nbsp; <span style="color:#91c7ff">Stamina:</span> <span data-k="stamina">–</span></div>
            <div><span style="color:#91c7ff">Altitude:</span> <span data-k="alt">–</span> m</div>
        `;
        this._lines = {
            fps:     this._root.querySelector('[data-k="fps"]'),
            mode:    this._root.querySelector('[data-k="mode"]'),
            health:  this._root.querySelector('[data-k="health"]'),
            stamina: this._root.querySelector('[data-k="stamina"]'),
            alt:     this._root.querySelector('[data-k="alt"]'),
        };
    }

    update({ fps, cameraMode, playerStatus }) {
        if (!this._lines) return;
        if (fps != null)   this._lines.fps.textContent = Math.round(fps);
        if (cameraMode)    this._lines.mode.textContent = cameraMode;

        const a = this.engine?.actorManager?.playerActor;
        if (a) {
            this._lines.health.textContent = `${Math.round(a.health ?? 0)} / ${a.maxHealth ?? '?'}`;
            this._lines.stamina.textContent = `${Math.round(a.stamina ?? 0)} / ${a.maxStamina ?? '?'}`;
            const o = this.engine.planetConfig?.origin;
            const r = this.engine.planetConfig?.radius ?? 0;
            if (o) {
                const d = Math.hypot(a.position.x - o.x, a.position.y - o.y, a.position.z - o.z);
                this._lines.alt.textContent = (d - r).toFixed(1);
            }
        } else if (playerStatus) {
            this._lines.health.textContent = `${Math.round(playerStatus.health ?? 0)}`;
            this._lines.stamina.textContent = `${Math.round(playerStatus.stamina ?? 0)}`;
        }
    }

    showCrashScreen() {
        if (this._crash) { this._crash.style.display = 'flex'; return; }
        const d = document.createElement('div');
        d.style.cssText = `
            position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
            background:rgba(5,8,16,0.75);color:#ffb0b0;font-size:28px;z-index:500;
            font-family:'Trebuchet MS',sans-serif;letter-spacing:0.08em;`;
        d.textContent = 'You fell.';
        document.body.appendChild(d);
        this._crash = d;
    }

    hideCrashScreen() { if (this._crash) this._crash.style.display = 'none'; }

    updateDebugModeDisplay(_mode, _name) { /* no-op for platform_game */ }
}
