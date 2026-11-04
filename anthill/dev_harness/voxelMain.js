import { Renderer } from 'engine/renderer/index.js';
import { VoxelRegion } from 'engine/voxel/VoxelRegion.js';
import { CutPlane } from 'engine/voxel/CutPlane.js';
import { AnthillCamera } from 'engine/voxel/AnthillCamera.js';
import { CharacterCamera } from 'engine/voxel/CharacterCamera.js';
import { VolumeViewModule } from 'engine/voxel/VolumeViewModule.js';
import { InspectionCamera } from './InspectionCamera.js';
import { inspectionPixelRatio, INSPECTION_PIXELS } from './inspectionResolution.js';
import { createTerrainFixture } from './fixtures/terrainFixture.js';
import { createRockDescription, createCarves } from './fixtures/regionFixture.js';
import { MineTerrain } from './MineTerrain.js';
import { MineCharacter } from './MineCharacter.js';
import { MineCharacterView } from './MineCharacterView.js';
import { FrameLoop } from './FrameLoop.js';
import { carriedTorchPosition } from './torchPose.js';
import { MineLightView } from './MineLightView.js';

const canvas = document.querySelector('canvas');
const status = document.querySelector('#status');
const seed = Number.parseInt(new URLSearchParams(location.search).get('seed') ?? '', 10) || 7;
const LATENCY = [40, 160];
const HOME = { angle: 0, offset: 10 };

const fixture = createTerrainFixture({ seed, latencyMs: LATENCY });
const region = new VoxelRegion({
    heightfield: fixture.captureHeightfield(),
    rock: createRockDescription(),
    voxelSize: 0.25,
    depth: 100,
    carves: createCarves(),
});
const heightfield = region.surface;
const plane = new CutPlane(HOME);
const camera = new AnthillCamera({ frame: region.frame, plane, eyeDistance: 600, depthBehind: 1000 });
const view = new VolumeViewModule({
    region, plane,
    queryHeights: fixture.queryHeights,
    onError: error => console.error('height query failed:', error),
});
const renderer = new Renderer({ canvas, clearColor: [0.035, 0.055, 0.09, 1] });
const terrain = new MineTerrain(region);
const character = new MineCharacter({ terrain, spawn: terrain.surfaceSpawn(54, 10, 0.28, 1.8) });
const characterCamera = new CharacterCamera({ frame: region.frame, character, terrain });
const characterView = new MineCharacterView({ character, frame: region.frame, plane, volumeView: view });
const lightView = new MineLightView({ volumeView: view });
const keys = new Set();
const followControl = document.querySelector('#follow-miner');
const cameraControl = document.querySelector('#camera-mode');
const angleControl = document.querySelector('#dig-angle');
const angleLabel = document.querySelector('#angle-value');
const actorStatus = document.querySelector('#miner-status');
const daylightControl = document.querySelector('#time-of-day');
const daylightLabel = document.querySelector('#time-value');
const lighting = view.lighting;
let installedLight = null;
let following = true;
let previousCharacterPosition = { ...character.position };

function wake() { frameLoop?.wake(); }
function setFollowing(value) { following = value; followControl.checked = isCharacterView() || value; wake(); }

function focusCharacter() {
    setFollowing(true);
    if (isCharacterView()) return;
    if (inspectionCamera) {
        inspectionCamera.target = { ...character.position, y: character.position.y + 1 };
        inspectionCamera.metersPerPixel = 1 / (28 * renderPixelRatio);
    } else {
        camera.finishTurn();
        plane.set(plane.angle, character.position.x * plane.normalX + character.position.z * plane.normalZ + 0.34);
        camera.center.s = plane.project(character.position.x, character.position.z).s;
        camera.center.y = character.position.y + 1;
        camera.metersPerPixel = 1 / (28 * renderPixelRatio);
    }
}

function respawnCharacter() {
    character.spawn = terrain.surfaceSpawn(54, 10, character.config.radius, character.config.height);
    character.respawn();
    character.heading = Math.PI;
    previousCharacterPosition = { ...character.position };
    keys.clear();
    focusCharacter();
}

function updateCharacter(dt) {
    const player = isCharacterView();
    const right = Number(keys.has('ArrowRight') || (player && keys.has('KeyD')))
        - Number(keys.has('ArrowLeft') || (player && keys.has('KeyA')));
    const forward = player || inspectionCamera ? Number(keys.has('ArrowUp') || (player && keys.has('KeyW')))
        - Number(keys.has('ArrowDown') || (player && keys.has('KeyS'))) : 0;
    const yaw = inspectionCamera?.yaw ?? plane.angle;
    character.update(dt, {
        ...(player ? characterCamera.movement(right, forward) : {
            moveX: camera.turn ? 0 : right * Math.cos(yaw) + forward * Math.sin(yaw),
            moveZ: camera.turn ? 0 : right * Math.sin(yaw) - forward * Math.cos(yaw),
        }),
        jump: keys.has('Space'), dig: !camera.turn && (player ? mouseDigging || keys.has('KeyX') : keys.has('KeyD')),
        aim: Number(keys.has('KeyI')) - Number(keys.has('KeyK'))
            + (!player && !inspectionCamera ? Number(keys.has('ArrowUp')) - Number(keys.has('ArrowDown')) : 0),
    });
    const p = character.position;
    if (following && !player) {
        const offset = p.x * plane.normalX + p.z * plane.normalZ + 0.34;
        if (view.clipEnabled && Math.abs(plane.offset - offset) > 1e-7) plane.set(plane.angle, offset);
        if (inspectionCamera) {
            for (const axis of ['x', 'y', 'z']) inspectionCamera.target[axis] += p[axis] - previousCharacterPosition[axis];
        } else {
            camera.center.s = plane.project(p.x, p.z).s;
            camera.center.y = p.y + 1;
        }
    }
    previousCharacterPosition = { ...p };
    angleControl.value = String(Math.round(character.pitch * 180 / Math.PI));
    angleLabel.textContent = `${Math.round(character.pitch * 180 / Math.PI)}°`;
    const state = character.alive ? character.digging ? 'Digging' : character.grounded ? 'On ground' : character.velocity.y > 0 ? 'Jumping' : 'Falling' : character.deathReason;
    actorStatus.textContent = `${state} · (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}) m · ${character.deaths} deaths${character.alive ? '' : ' · P to respawn'}`;
    actorStatus.classList.toggle('dead', !character.alive);
}

// Inspection is harness-only. Dropping these controls leaves a normal anthill camera.
const TURN_SECONDS = 0.35;
let inspectionCamera = null;
let cameraMode = 'anthill';
let mouseDigging = false;
let renderPixelRatio = 1;
let inspectionMovingUntil = 0;
const isCharacterView = () => cameraMode === 'first-person' || cameraMode === 'third-person';
const activeCamera = () => isCharacterView() ? characterCamera : inspectionCamera ?? camera;
function setCameraMode(mode) {
    if (!['anthill', 'inspection', 'first-person', 'third-person'].includes(mode))
        throw new RangeError(`Unknown camera mode: ${mode}`);
    wake();
    resetInput();
    inspectionMovingUntil = 0;
    camera.finishTurn();
    if (mode === 'inspection' && !inspectionCamera)
        inspectionCamera = new InspectionCamera(camera, { pixelRatio: renderPixelRatio });
    if (mode !== 'inspection') inspectionCamera = null;
    cameraMode = mode;
    if (isCharacterView()) characterCamera.setMode(mode);
    view.inspection = !!inspectionCamera;
    view.clipEnabled = !isCharacterView();
    cameraControl.value = mode;
    followControl.disabled = isCharacterView();
    followControl.checked = isCharacterView() || following;
    document.querySelector('#crosshair').hidden = !isCharacterView();
    document.querySelector('#movement-help').textContent = isCharacterView()
        ? 'WASD / arrows walk · Space jump · Hold left mouse or X to dig · I / K aim up / down'
        : '← / → walk · Space jump · Hold D to dig · ↑ / ↓ or I / K aim up / down';
    document.querySelector('#camera-help').textContent = isCharacterView()
        ? 'Click to capture mouse · Mouse / drag to look · Esc release · Wheel adjusts third-person distance · V switches 1st / 3rd person'
        : 'F free view / return · Free view: arrows walk in 3D, I / K aim · Drag orbit · Shift+drag pan · C cutaway / hillside';
    canvas.setAttribute('aria-label', `${cameraControl.selectedOptions[0].textContent} of the voxel region`);
}
function toggleInspection() { setCameraMode(inspectionCamera ? 'anthill' : 'inspection'); }

let stopped = false;
let frameLoop;
let framed = false;
let pointer = null;                 // last pointer position in canvas pixels
let press = null;
let brushRadius = 1.2;
let edits = 0;

function fail(error) {
    stopped = true;
    frameLoop?.stop();
    status.textContent = `Rendering failed: ${error.message ?? error}`;
    status.style.color = '#ffb7a8';
    console.error(error);
    window.harnessError = String(error.message ?? error);
}

function frameAll() {
    wake();
    const span = plane.clipToRect(heightfield.minX, heightfield.minZ, heightfield.maxX, heightfield.maxZ) ?? [-128, 128];
    const pad = (span[1] - span[0]) * 0.25;
    camera.fit(span[0] - pad, span[1] + pad, region.volume.minY - 6, heightfield.maxHeight + 12);
}

function focusSeam(index) {
    wake();
    const seam = view.profile.seams[index];
    if (!seam) return;
    camera.center.s = seam.s;
    camera.center.y = seam.captured;
    camera.metersPerPixel = 0.01;
}

const planePoint = hit => [plane.x(hit.s), hit.y, plane.z(hit.s)];

/** Harness tool only: exercises VoxelRegion.apply and the incremental cut update. */
function editAt(pixel, fill) {
    wake();
    const center = planePoint(camera.screenToPlane(pixel.x, pixel.y));
    region.apply({
        mode: fill ? 'fill' : 'carve',
        shape: { type: 'sphere', center, radius: brushRadius, roughness: { amplitude: 0.12, frequency: 0.9, seed: ++edits } },
    });
}

function describe() {
    const { profile } = view;
    const { volume, rock } = region;
    const lines = [
        `seed ${fixture.seed} · frame origin (0, ${fixture.frame.origin.y}, 0) m, up +Y`,
        isCharacterView() ? `perspective: ${(characterCamera.fov * 180 / Math.PI).toFixed(0)}° FOV · camera distance ${characterCamera.actualDistance.toFixed(2)} m`
            : `cut: angle ${(plane.angle * 180 / Math.PI).toFixed(1)}° · offset ${plane.offset.toFixed(2)} m · zoom ${(1 / activeCamera().metersPerPixel).toFixed(1)} px/m · brush ${brushRadius.toFixed(2)} m`,
        `volume: ${volume.voxelSize} m voxels · ${volume.allocatedChunks} of ${volume.totalChunks} chunks stored (${(volume.memoryBytes / 1048576).toFixed(1)} MB) · ${volume.revision} edits`,
        `hybrid geometry / density · ${cameraMode} · ${view.clipEnabled ? 'cutaway' : 'complete volume'}${camera.turn ? ' · turning' : ''}`,
        `queries: ${profile.stats.requests} sent · ${profile.stats.samples} samples · ${profile.stats.stale} stale · ${profile.stats.failures} failed`
            + (fixture.queryBias ? ` · BIAS ${fixture.queryBias * 100} cm` : ''),
    ];
    const mesh=view.meshCache?.stats;
    if(mesh)lines.push(`geometry LOD ${view.meshLOD?'on':'off'} · ${mesh.eligible} active / ${mesh.resident} resident patches · ${mesh.triangles.toLocaleString()} triangles · ${(mesh.bytes/1048576).toFixed(1)} MB`
        + ` · maintenance ${mesh.maintenanceMs.toFixed(2)} ms${mesh.error?` · density fallback: ${mesh.error}`:''}`);
    profile.seams.forEach((seam, index) => {
        const queried = seam.queried === null ? 'waiting…' : `step ${((seam.queried - seam.captured) * 1000).toFixed(1)} mm`;
        lines.push(`${index ? 'right' : 'left '} seam s = ${seam.s.toFixed(2)} m · ${queried}`);
    });
    if (pointer && cameraMode === 'anthill' && !camera.turn) {
        const [x, y, z] = planePoint(camera.screenToPlane(pointer.x, pointer.y));
        const inside = x >= volume.minX && x <= volume.maxX && z >= volume.minZ && z <= volume.maxZ && y >= volume.minY && y <= volume.maxY;
        if (inside) {
            const what = rock.describe(x, y, z);
            const state = volume.isSolid(x, y, z) ? 'rock' : what.depth < 0 ? 'open air' : 'dug out';
            lines.push(`cursor (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}) · ${state} · ${what.layerName}${what.veinName ? ` + ${what.veinName}` : ''} · ${what.depth.toFixed(1)} m below ground`);
        } else {
            lines.push(`cursor (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}) · outside the region`);
        }
    }
    status.textContent = lines.join('\n');
}

async function start() {
    await renderer.initialize();
    renderer.backend.device.addEventListener('uncapturederror', event => fail(event.error));
    await renderer.addModule(view);
    await renderer.addModule(characterView);
    await renderer.addModule(lightView);
    let elapsed = 0;
    function tick(now, seconds) {
        if (stopped) return;
        try {
            const turnDelta = Math.max(0, seconds);
            const deltaTime = Math.min(turnDelta, 0.1);
            elapsed += deltaTime;
            let ratio = Math.min(window.devicePixelRatio || 1, 2);
            if (inspectionCamera || isCharacterView()) {
                const moving = (press && press.moved > 0) || now < inspectionMovingUntil
                    || (isCharacterView() && (keys.size > 0 || !character.grounded));
                ratio = inspectionPixelRatio(canvas.clientWidth, canvas.clientHeight, ratio, moving);
                inspectionCamera?.setPixelRatio(ratio);
            }
            renderPixelRatio = ratio;
            const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
            const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
            if (canvas.width !== width || canvas.height !== height) {
                canvas.width = width;
                canvas.height = height;
                renderer.resize(width, height);
            }
            camera.advanceTurn(turnDelta);
            updateCharacter(deltaTime);
            lighting.setCarriedLight(carriedTorchPosition(character), character.alive && document.querySelector('#carried-torch').checked);
            const p = character.position;
            if (character.alive) lighting.setOccluder(
                [p.x-0.17,p.y+0.15,p.z-0.17], [p.x+0.17,p.y+1.8,p.z+0.17]);
            else lighting.setOccluder(null);
            const currentCamera = activeCamera();
            currentCamera.update(width, height);
            view.showGround = cameraMode === 'anthill' && !camera.turn;
            if (!framed) {
                focusCharacter();
                currentCamera.update(width, height);
                framed = true;
            }
            if (!renderer.renderFrame({ camera: currentCamera, deltaTime, time: elapsed })) throw new Error('GPU device lost');
            if (document.activeElement !== daylightControl) daylightControl.value = String(lighting.timeOfDay);
            const minutes = Math.floor(lighting.timeOfDay * 60);
            daylightLabel.textContent = `${String(Math.floor(minutes / 60)).padStart(2,'0')}:${String(minutes % 60).padStart(2,'0')}`;
            if (renderer.frameCount % 10 === 0) describe();
            window.harnessFrameCount = renderer.frameCount;
        } catch (error) { fail(error); }
    }
    frameLoop = new FrameLoop({
        onFrame: tick,
        isActive: () => !!camera.turn || keys.size > 0 || (character.alive && (
            !character.grounded || character.digging
            || Math.hypot(character.velocity.x, character.velocity.y, character.velocity.z) > 0.001)),
        onPause: resetInput,
    });
    window.harness = { renderer, camera, characterCamera, view, plane, fixture, region, terrain, character, characterView, lighting,
        frameLoop, toggleInspection, setCameraMode, focusCharacter, respawnCharacter, setFollowing,
        get cameraMode() { return cameraMode; },
        get following() { return following; }, get inspectionCamera() { return inspectionCamera; } };
    if (!stopped) frameLoop.start();
}

function canvasPixel(event) {
    const rect = canvas.getBoundingClientRect();
    const scale = canvas.width / Math.max(1, rect.width);
    return { x: (event.clientX - rect.left) * scale, y: (event.clientY - rect.top) * scale, scale };
}

canvas.addEventListener('pointerdown', event => {
    wake();
    // Pointer lock already routes movement here; capture is invalid while locked.
    if (document.pointerLockElement !== canvas) canvas.setPointerCapture(event.pointerId);
    press = { moved: 0, pointerId: event.pointerId };
    if (isCharacterView() && event.button === 0) {
        if (document.pointerLockElement === canvas) mouseDigging = true;
        else {
            // Drag-to-look and X remain available when pointer lock is unavailable.
            try { canvas.requestPointerLock?.()?.catch?.(() => {}); } catch {}
        }
    }
});
canvas.addEventListener('pointermove', event => {
    pointer = canvasPixel(event);
    if (!canvas.hasPointerCapture(event.pointerId) && document.pointerLockElement !== canvas) return;
    wake();
    if (press) press.moved += Math.abs(event.movementX) + Math.abs(event.movementY);
    if (isCharacterView()) {
        characterCamera.look(event.movementX, event.movementY);
        inspectionMovingUntil = performance.now() + INSPECTION_PIXELS.settleMs;
        return;
    }
    if (press?.moved > 4 && (!inspectionCamera || event.shiftKey)) setFollowing(false);
    if (inspectionCamera) inspectionMovingUntil = performance.now() + INSPECTION_PIXELS.settleMs;
    if (inspectionCamera && !event.shiftKey) inspectionCamera.orbit(event.movementX, event.movementY);
    else if (!camera.turn) activeCamera().pan(event.movementX * pointer.scale, event.movementY * pointer.scale);
});
canvas.addEventListener('pointerup', event => {
    wake();
    const click = press;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (cameraMode === 'anthill' && !camera.turn && click && click.moved < 4 && event.button === 0) editAt(canvasPixel(event), event.shiftKey);
    press = null;
});
window.addEventListener('pointerup', event => { if (event.button === 0) mouseDigging = false; });
canvas.addEventListener('pointerleave', () => { pointer = null; });
canvas.addEventListener('pointercancel', () => { press = null; mouseDigging = false; });
canvas.addEventListener('lostpointercapture', () => { press = null; });
canvas.addEventListener('wheel', event => {
    event.preventDefault();
    wake();
    const pixel = canvasPixel(event);
    if (inspectionCamera || isCharacterView()) inspectionMovingUntil = performance.now() + INSPECTION_PIXELS.settleMs;
    activeCamera().zoomAt(Math.exp(event.deltaY * 0.0015), pixel.x, pixel.y);
}, { passive: false });

const characterKeys = new Set(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Space','KeyD','KeyI','KeyK']);
const perspectiveKeys = new Set([...characterKeys, 'KeyW', 'KeyA', 'KeyS', 'KeyX']);
window.addEventListener('keydown', event => {
    if (event.code === 'Escape' && document.pointerLockElement === canvas) {
        resetInput();wake();return;
    }
    // Sliders and buttons keep their native keyboard behaviour and do not move the miner.
    if (event.target.closest?.('input, button, select, textarea')) return;
    wake();
    if ((isCharacterView() ? perspectiveKeys : characterKeys).has(event.code)) { keys.add(event.code); event.preventDefault(); return; }
    if (event.code === 'KeyP') { if (!event.repeat) respawnCharacter(); event.preventDefault(); return; }
    if (event.code === 'KeyT') { if (!event.repeat) focusCharacter(); event.preventDefault(); return; }
    if (event.code === 'KeyF') { if (!event.repeat) toggleInspection(); event.preventDefault(); return; }
    if (event.code === 'KeyV') {
        if (!event.repeat) setCameraMode(cameraMode === 'first-person' ? 'third-person' : 'first-person');
        event.preventDefault(); return;
    }
    if (event.code === 'KeyR') {
        setCameraMode('anthill'); setFollowing(false); fixture.queryBias = 0;
        plane.set(HOME.angle, HOME.offset); frameAll(); event.preventDefault(); return;
    }
    if (isCharacterView()) return;
    if (inspectionCamera) {
        if (event.code === 'KeyC') { if (!event.repeat) view.clipEnabled = !view.clipEnabled; event.preventDefault(); }
        return;
    }
    const shift = event.shiftKey ? 0.25 : 1;
    if (camera.turn && !['KeyQ', 'KeyE', 'KeyR'].includes(event.code)) return;
    switch (event.code) {
        case 'KeyQ': camera.startTurn(-1, TURN_SECONDS); break;
        case 'KeyE': camera.startTurn(1, TURN_SECONDS); break;
        case 'KeyW': setFollowing(false); plane.set(plane.angle, plane.offset + shift); break;
        case 'KeyS': setFollowing(false); plane.set(plane.angle, plane.offset - shift); break;
        case 'Digit1': setFollowing(false); focusSeam(0); break;
        case 'Digit2': setFollowing(false); focusSeam(1); break;
        case 'BracketLeft': brushRadius = Math.max(0.25, brushRadius - 0.25); break;
        case 'BracketRight': brushRadius = Math.min(6, brushRadius + 0.25); break;
        case 'KeyB': fixture.queryBias = fixture.queryBias ? 0 : 0.05; view.profile.invalidate(); break;
        default: return;
    }
    event.preventDefault();
});
function resetInput() {
    keys.clear();
    mouseDigging = false;
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    if (press && canvas.hasPointerCapture(press.pointerId)) canvas.releasePointerCapture(press.pointerId);
    press = null;
    pointer = null;
}
window.addEventListener('keyup', event => { keys.delete(event.code); wake(); });
window.addEventListener('blur', resetInput);
document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement !== canvas) { keys.clear(); mouseDigging = false; }
    wake();
});
window.addEventListener('resize', wake);
document.addEventListener('focusin', event => {
    if (event.target.closest?.('input, button, select, textarea')) keys.clear();
});
followControl.addEventListener('change', () => { setFollowing(followControl.checked); followControl.blur(); });
cameraControl.addEventListener('change', () => { setCameraMode(cameraControl.value); cameraControl.blur(); });
angleControl.addEventListener('input', () => { character.setPitch(Number(angleControl.value) * Math.PI / 180); wake(); });
angleControl.addEventListener('change', () => { angleControl.blur(); });
daylightControl.addEventListener('input', () => { lighting.setTimeOfDay(Number(daylightControl.value)); wake(); });
daylightControl.addEventListener('change', () => { daylightControl.blur(); });
document.querySelector('#day-cycle').addEventListener('change', event => { lighting.running = event.target.checked; wake(); });
document.querySelector('#carried-torch').addEventListener('change', wake);
document.querySelector('#geometry-lod').addEventListener('change', event => {view.meshLOD=event.target.checked;wake();});
document.querySelector('#install-light').addEventListener('click', event => {
    if (character.alive) {
        try {
            installedLight = lighting.addLight({ kind: document.querySelector('#light-kind').value,
                position: carriedTorchPosition(character) });
            document.querySelector('#remove-light').disabled = false;
        } catch (error) { actorStatus.textContent = error.message; }
    }
    event.currentTarget.blur(); wake();
});
document.querySelector('#remove-light').addEventListener('click', event => {
    if (installedLight !== null) lighting.removeLight(installedLight);
    installedLight = [...lighting.lights.keys()].at(-1) ?? null;
    event.currentTarget.disabled = installedLight === null;
    event.currentTarget.blur(); wake();
});
document.querySelector('#focus-miner').addEventListener('click', event => { focusCharacter(); event.currentTarget.blur(); });
document.querySelector('#respawn-miner').addEventListener('click', event => { respawnCharacter(); event.currentTarget.blur(); });
document.querySelector('#overview').addEventListener('click', event => {
    setCameraMode('anthill');
    setFollowing(false); camera.finishTurn(); frameAll(); event.currentTarget.blur();
});

window.addEventListener('pagehide', () => {
    stopped = true;
    resetInput();
    frameLoop?.stop();
    renderer.dispose();
}, { once: true });

start().catch(fail);
