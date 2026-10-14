// Background GPU sampling also waits for a visible tab before dispatching again.
export function waitForVisibleFrame() {
    return new Promise(resolve => {
        let requestId = null;
        const onFrame = () => {
            requestId = null;
            if (document.hidden) return;
            document.removeEventListener('visibilitychange', schedule);
            resolve();
        };
        const schedule = () => {
            if (document.hidden) {
                if (requestId !== null) cancelAnimationFrame(requestId);
                requestId = null;
            } else if (requestId === null) {
                requestId = requestAnimationFrame(onFrame);
            }
        };
        document.addEventListener('visibilitychange', schedule);
        schedule();
    });
}

// Runs updates and rendering together, with no animation requests while hidden.
export class FrameLoop {
    constructor({ onFrame, getMaxFps, beforeFrame = () => {}, onPause = () => {}, onResume = () => {} }) {
        this.onFrame = onFrame;
        this.getMaxFps = getMaxFps;
        this.beforeFrame = beforeFrame;
        this.onPause = onPause;
        this.onResume = onResume;
        this._running = false;
        this._requestId = null;
        this._resetClock();
        this._tick = this._tick.bind(this);
        this._visibilityChanged = this._visibilityChanged.bind(this);
    }

    start() {
        if (this._running) return;
        this._running = true;
        document.addEventListener('visibilitychange', this._visibilityChanged);
        this._visibilityChanged();
    }

    stop() {
        this._running = false;
        document.removeEventListener('visibilitychange', this._visibilityChanged);
        this._cancelFrame();
        this._resetClock();
    }

    _resetClock() {
        this._lastFrameTime = null;
        this._nextFrameTime = null;
        this._maxFps = null;
    }

    _cancelFrame() {
        if (this._requestId !== null) cancelAnimationFrame(this._requestId);
        this._requestId = null;
    }

    _requestFrame() {
        if (this._running && !document.hidden && this._requestId === null) {
            this._requestId = requestAnimationFrame(this._tick);
        }
    }

    _visibilityChanged() {
        this._cancelFrame();
        this._resetClock();
        if (document.hidden) {
            this.onPause();
        } else {
            this.onResume();
            this._requestFrame();
        }
    }

    _tick(currentTime) {
        this._requestId = null;
        if (!this._running || document.hidden) return;

        this.beforeFrame(currentTime);
        const maxFps = this.getMaxFps();
        if (maxFps !== this._maxFps) {
            this._maxFps = maxFps;
            this._nextFrameTime = null;
        }
        const interval = maxFps > 0 ? 1000 / maxFps : 0;
        // Allow sub-millisecond rAF jitter without losing a whole refresh.
        if (interval > 0 && this._nextFrameTime !== null && currentTime + 0.5 < this._nextFrameTime) {
            this._requestFrame();
            return;
        }

        const deltaTime = this._lastFrameTime === null ? 0 : (currentTime - this._lastFrameTime) / 1000;
        this._lastFrameTime = currentTime;
        if (interval > 0) {
            // Keep the deadline's phase on displays whose Hz is not a multiple
            // of the cap. Missed frames never cause a burst of catch-up work.
            const deadline = this._nextFrameTime ?? currentTime;
            this._nextFrameTime = currentTime - deadline >= interval - 0.5
                ? currentTime + interval
                : deadline + interval;
        }
        this.onFrame(currentTime, deltaTime);
        this._requestFrame();
    }
}
