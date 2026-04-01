// js/actors/nav/NavigationController.js
//
// Orchestrates click-to-move: screen raycast → terrain/object pick →
// pathfind → steer actor. Throttles pathfind recomputation.

import { MovementState } from '../ActorState.js';
import { ScreenRaycaster } from './ScreenRaycaster.js';

export class NavigationController {
    /**
     * @param {object} opts
     * @param {GPUDevice} opts.device
     * @param {object} opts.planetConfig
     * @param {object} opts.quadtreeGPU
     * @param {object} opts.tileStreamer
     * @param {object} opts.treeDetailSystem
     * @param {import('./TerrainRaycaster.js').TerrainRaycaster} opts.terrainRaycaster
     * @param {import('./ObjectPicker.js').ObjectPicker} opts.objectPicker
     * @param {import('./LocalPathfinder.js').LocalPathfinder} opts.pathfinder
     * @param {import('./DestinationMarker.js').DestinationMarker} opts.marker
     */
    constructor(opts) {
        this.device = opts.device;
        this.planetConfig = opts.planetConfig;
        this.quadtreeGPU = opts.quadtreeGPU;
        this.tileStreamer = opts.tileStreamer;
        this.treeDetailSystem = opts.treeDetailSystem;

        this.terrainRaycaster = opts.terrainRaycaster;
        this.objectPicker = opts.objectPicker;
        this.pathfinder = opts.pathfinder;
        this.marker = opts.marker;

        // State
        this.destination = null;      // world {x,y,z}
        this.destinationUp = null;
        this._lastPickResult = null;
        this._arrivalThreshold = 1.5; // meters
        this._pathfindInterval = 1.0; // seconds
        this._pathfindTimer = 0;
        this._lastNavDir = null;      // local {dirX, dirY} from pathfinder
        this._navActive = false;
        this._blockedTime = 0;
        this._pathUseDelay = 0.2;     // allow movement resolver sliding first
        this._pathStepDistance = 6.0; // short detour step when direct motion is blocked

        // Pending async results
        this._terrainHitPending = false;
        this._objectHitPending = false;
        this._pathfindPending = false;

        // Tangent frame cache (for converting pathfinder local dir to world)
        this._cachedRight = { x: 1, y: 0, z: 0 };
        this._cachedFwd   = { x: 0, y: 0, z: 1 };
    }

    /**
     * Handle a screen click. Dispatches both terrain and object raycasts.
     * @param {number} screenX
     * @param {number} screenY
     * @param {object} camera Frontend camera
     * @param {number} canvasW
     * @param {number} canvasH
     * @param {GPUCommandEncoder} encoder
     */
    handleClick(screenX, screenY, camera, canvasW, canvasH, encoder) {
        // CPU: screen → ray
        const ray = ScreenRaycaster.cast(screenX, screenY, camera, canvasW, canvasH);

        // Quick sphere test to reject clicks into space
        const o = this.planetConfig.origin || { x: 0, y: 0, z: 0 };
        const r = this.planetConfig.radius + (this.planetConfig.heightScale ?? 1000);
        const t = ScreenRaycaster.intersectSphere(ray.origin, ray.dir, o, r);
        if (t < 0) return; // missed planet entirely

        // GPU: terrain raycast
        const textures = this.tileStreamer?.getArrayTextures?.() ?? {};
        const hashBuf =
            this.quadtreeGPU?.getLoadedTileTableBuffer?.()
            || this.tileStreamer?.quadtreeGPU?.getLoadedTileTableBuffer?.()
            || null;
        if (textures.height && hashBuf) {
            const dispatched = this.terrainRaycaster.dispatch(
                encoder, ray, this.planetConfig, this.quadtreeGPU,
                textures, hashBuf, 500
            );
            this._terrainHitPending = dispatched === true;
        }

        // GPU: object pick
        const ctBuf = this.treeDetailSystem?.getCloseTreeBuffer?.();
        const ctcBuf = this.treeDetailSystem?.getCloseTreeCountBuffer?.();
        if (ctBuf && ctcBuf) {
            this.objectPicker.dispatch(
                encoder, ray, this.planetConfig,
                ctBuf, ctcBuf,
                this.treeDetailSystem.maxCloseTrees ?? 512
            );
            this._objectHitPending = true;
        }
    }

    /**
     * Call after GPU submit to resolve readbacks.
     * @param {function} onObjectInteract  callback({type, position, objectIndex})
     */
    async resolveClicks(onObjectInteract) {
        let terrainHit = null;
        let objectHit = null;

        if (this._terrainHitPending) {
            terrainHit = await this.terrainRaycaster.resolveHit();
            this._terrainHitPending = false;
        }
        if (this._objectHitPending) {
            objectHit = await this.objectPicker.resolveHit();
            this._objectHitPending = false;
        }

        // Object hit takes priority if closer
        if (objectHit?.hit && terrainHit?.hit) {
            if (objectHit.distance < terrainHit.distance) {
                if (onObjectInteract) onObjectInteract(objectHit);
                return; // don't navigate, interact instead
            }
        } else if (objectHit?.hit && !terrainHit?.hit) {
            if (onObjectInteract) onObjectInteract(objectHit);
            return;
        }

        // Navigate to terrain hit
        if (terrainHit?.hit) {
            this.setDestination(terrainHit.position, terrainHit.normal);
        }
    }

    setDestination(pos, up) {
        this.destination = { ...pos };
        this.destinationUp = up ? { ...up } : null;
        this._navActive = true;
        this._pathfindTimer = this._pathfindInterval; // force immediate pathfind
        this.marker?.setTarget(pos, up);
    }

    clearDestination() {
        this.destination = null;
        this._navActive = false;
        this._lastNavDir = null;
        this._blockedTime = 0;
        this.marker?.clear();
    }

    /**
     * Per-frame update. May dispatch pathfinder compute.
     * @param {number} dt
     * @param {object} actor  CharacterActor
     * @param {GPUCommandEncoder|null} encoder  if available for pathfind dispatch
     * @returns {{ target?: {x:number,y:number,z:number}, arrived:boolean, usingPath?:boolean }|null}
     */
    update(dt, actor, encoder) {
        if (!this._navActive || !this.destination) return null;

        // Check arrival
        const dx = this.destination.x - actor.position.x;
        const dy = this.destination.y - actor.position.y;
        const dz = this.destination.z - actor.position.z;
        const dist = Math.hypot(dx, dy, dz);
        if (dist < this._arrivalThreshold) {
            this.clearDestination();
            return { arrived: true, usingPath: false };
        }

        // Update tangent frame cache
        this._updateTangentFrame(actor.position);
        const directDir = this._computeDirectTangentDir(actor.position, this.destination);

        // Pathfind timer
        this._pathfindTimer += dt;
        this._blockedTime = actor.movementState === MovementState.BLOCKED
            ? this._blockedTime + dt
            : 0;

        const ctBuf = this.treeDetailSystem?.getCloseTreeBuffer?.();
        const ctcBuf = this.treeDetailSystem?.getCloseTreeCountBuffer?.();
        const maxColl = this.treeDetailSystem?.maxCloseTrees ?? 0;

        // Within local pathfind range (GRID_SIZE/2 = 16m) AND have tree data?
        const useLocalNav = dist < 30 && ctBuf && ctcBuf && maxColl > 0 && encoder;

        if (useLocalNav && this._pathfindTimer >= this._pathfindInterval && !this._pathfindPending) {
            this.pathfinder.dispatch(
                encoder, actor.position, this.destination,
                this.planetConfig, ctBuf, ctcBuf, maxColl,
                actor.collisionRadius ?? 0.4
            );
            this._pathfindPending = true;
            this._pathfindTimer = 0;
        }

        const pathDir = this._computeWorldPathDir();
        const pathAlignment = pathDir && directDir
            ? pathDir.x * directDir.x + pathDir.y * directDir.y + pathDir.z * directDir.z
            : 1;
        if (pathDir && this._blockedTime >= this._pathUseDelay && pathAlignment > 0.15) {
            const step = Math.min(this._pathStepDistance, dist);
            return {
                target: {
                    x: actor.position.x + pathDir.x * step,
                    y: actor.position.y + pathDir.y * step,
                    z: actor.position.z + pathDir.z * step,
                },
                arrived: false,
                usingPath: true,
            };
        }

        return {
            target: { ...this.destination },
            arrived: false,
            usingPath: false,
        };
    }

    /**
     * Call after GPU submit to resolve pathfinder readback.
     */
    async resolvePathfind() {
        if (!this._pathfindPending) return;
        const result = await this.pathfinder.resolveResult();
        this._pathfindPending = false;
        if (result) {
            this._lastNavDir = result;
        }
    }

    _updateTangentFrame(pos) {
        const o = this.planetConfig.origin || { x: 0, y: 0, z: 0 };
        const upX = pos.x - o.x, upY = pos.y - o.y, upZ = pos.z - o.z;
        const upLen = Math.hypot(upX, upY, upZ) || 1;
        const ux = upX / upLen, uy = upY / upLen, uz = upZ / upLen;
        const refAbs = Math.abs(uy) > 0.99;
        const rX = refAbs ? 0 : 0, rY = refAbs ? 0 : 1, rZ = refAbs ? 1 : 0;
        let rx = uy * rZ - uz * rY, ry = uz * rX - ux * rZ, rz = ux * rY - uy * rX;
        const rl = Math.hypot(rx, ry, rz) || 1;
        rx /= rl; ry /= rl; rz /= rl;
        this._cachedRight = { x: rx, y: ry, z: rz };
        this._cachedFwd = { x: ry * uz - rz * uy, y: rz * ux - rx * uz, z: rx * uy - ry * ux };
    }

    _computeDirectTangentDir(pos, destination) {
        const toTarget = {
            x: destination.x - pos.x,
            y: destination.y - pos.y,
            z: destination.z - pos.z,
        };
        const o = this.planetConfig.origin || { x: 0, y: 0, z: 0 };
        const upX = pos.x - o.x, upY = pos.y - o.y, upZ = pos.z - o.z;
        const upLen = Math.hypot(upX, upY, upZ) || 1;
        const ux = upX / upLen, uy = upY / upLen, uz = upZ / upLen;
        const radial = toTarget.x * ux + toTarget.y * uy + toTarget.z * uz;
        const tangX = toTarget.x - ux * radial;
        const tangY = toTarget.y - uy * radial;
        const tangZ = toTarget.z - uz * radial;
        const tangLen = Math.hypot(tangX, tangY, tangZ);
        if (tangLen < 1e-4) return null;
        return {
            x: tangX / tangLen,
            y: tangY / tangLen,
            z: tangZ / tangLen,
        };
    }

    _computeWorldPathDir() {
        if (!this._lastNavDir?.valid) return null;
        const r = this._cachedRight;
        const f = this._cachedFwd;
        const lx = this._lastNavDir.dirX;
        const ly = this._lastNavDir.dirY;
        const wx = r.x * lx + f.x * ly;
        const wy = r.y * lx + f.y * ly;
        const wz = r.z * lx + f.z * ly;
        const len = Math.hypot(wx, wy, wz);
        if (len < 1e-4) return null;
        return { x: wx / len, y: wy / len, z: wz / len };
    }

    dispose() {
        this.terrainRaycaster?.dispose();
        this.objectPicker?.dispose();
        this.pathfinder?.dispose();
        this.marker?.dispose();
    }
}
