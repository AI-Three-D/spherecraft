import { Renderer } from 'engine/renderer/index.js';
import { TexturedCubeModule } from './texturedCube.js';
import { OrbitCamera } from './orbitCamera.js';
import { FrameLoop } from './FrameLoop.js';

const canvas = document.querySelector('canvas');
const status = document.querySelector('#status');
const renderer = new Renderer({ canvas, clearColor: [0.035, 0.055, 0.09, 1] });
const camera = new OrbitCamera(canvas);
const cube = new TexturedCubeModule();
let stopped = false;
let frameLoop;

function fail(error) {
    stopped = true;
    frameLoop?.stop();
    status.textContent = `Rendering failed: ${error.message ?? error}`;
    status.style.color = '#ffb7a8';
    console.error(error);
    window.harnessError = String(error.message ?? error);
}

async function start() {
    await renderer.initialize();
    renderer.backend.device.addEventListener('uncapturederror', event => fail(event.error));
    await renderer.addModule(cube);
    status.textContent = 'WebGPU · procedural texture · no terrain or game systems';
    let elapsed = 0;
    function tick(_now, seconds) {
        if (stopped) return;
        try {
            const deltaTime = Math.max(0, Math.min(seconds, 0.1));
            elapsed += deltaTime;
            const ratio = Math.min(window.devicePixelRatio || 1, 2);
            const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
            const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
            if (canvas.width !== width || canvas.height !== height) {
                canvas.width = width;
                canvas.height = height;
                renderer.resize(width, height);
            }
            camera.update(width / height);
            if (!renderer.renderFrame({ camera, deltaTime, time: elapsed })) {
                throw new Error('GPU device lost');
            }
            window.harnessFrameCount = renderer.frameCount;
        } catch (error) { fail(error); }
    }
    frameLoop = new FrameLoop({ onFrame: tick, isActive: () => !cube.paused });
    // Expose a small diagnostics surface for browser checks and feature experiments.
    window.harness = { renderer, camera, cube, frameLoop };
    if (!stopped) frameLoop.start();
}

canvas.addEventListener('pointermove', event => {
    if (canvas.hasPointerCapture(event.pointerId)) frameLoop?.wake();
});
canvas.addEventListener('wheel', () => frameLoop?.wake(), { passive: true });
window.addEventListener('resize', () => frameLoop?.wake());
window.addEventListener('keydown', event => {
    if (event.code === 'Space') {
        event.preventDefault();
        cube.paused = !cube.paused;
        frameLoop?.wake();
    }
});
window.addEventListener('pagehide', () => {
    stopped = true;
    frameLoop?.stop();
    camera.dispose();
    renderer.dispose();
}, { once: true });
start().catch(fail);
