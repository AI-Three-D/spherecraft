// platform_game/game/CloudField.js
//
// Manages a ring of cloud platforms around the player. Uses stable
// pseudorandom hashing of spherical-shell cells so the same cell always
// contains the same cloud, regardless of how the player approaches it.
// The field keeps ~30 clouds visible, streaming in/out as the player
// walks around the planet.
//
// Movement modes (per cloud, determined by its hash):
//   0 = stationary
//   1 = ping-pong along a tangent axis
//   2 = erratic (low-freq noise in 2 tangent axes)
//   3 = spawn/fade — breathing opacity via uniform scale + emissive (no
//       particle rain yet; that comes with the extended particle types)
//
// Turn 2 scope: visual placement + motion. Actual landing/collision
// against these clouds needs a movementResolver.wgsl extension and is
// deferred to a later turn.

import { Logger } from '../../shared/Logger.js';
import { CloudPlatformModel } from './CloudPlatformModel.js';

const TAU = Math.PI * 2;

function hash32(x, y, z, seed) {
    // Small, branchless integer hash — enough for stable per-cell values.
    let h = (x | 0) * 374761393 ^ (y | 0) * 668265263 ^ (z | 0) * 2147483647 ^ (seed | 0);
    h = (h ^ (h >>> 13)) * 1274126177;
    h = h ^ (h >>> 16);
    return h >>> 0;
}
function hash01(x, y, z, seed) { return hash32(x, y, z, seed) / 0xFFFFFFFF; }

/** Orthonormal tangent frame at a point on the sphere. */
function tangentFrameAt(p, origin) {
    const ux = p.x - origin.x, uy = p.y - origin.y, uz = p.z - origin.z;
    const ul = Math.hypot(ux, uy, uz) || 1;
    const nx = ux / ul, ny = uy / ul, nz = uz / ul;
    // Reference that won't be parallel to the up.
    let rx = 0, ry = 1, rz = 0;
    if (Math.abs(ny) > 0.99) { rx = 0; ry = 0; rz = 1; }
    // tangent = normalize(cross(up, ref))
    let tx = ny * rz - nz * ry;
    let ty = nz * rx - nx * rz;
    let tz = nx * ry - ny * rx;
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    // bitangent = cross(up, tangent)
    const bx = ny * tz - nz * ty;
    const by = nz * tx - nx * tz;
    const bz = nx * ty - ny * tx;
    return { up: { x: nx, y: ny, z: nz }, tangent: { x: tx, y: ty, z: tz }, bitangent: { x: bx, y: by, z: bz } };
}

export class CloudField {
    /**
     * @param {object} opts
     * @param {object} opts.planetConfig       — { origin, radius }
     * @param {object} opts.genericMeshRenderer
     * @param {number} [opts.targetCount=28]   — how many clouds to keep live
     * @param {number} [opts.cellSizeMeters=90]
     * @param {number} [opts.streamRadiusCells=4] — cells from player in each direction
     * @param {number} [opts.minAltitude=30]   — meters above terrain
     * @param {number} [opts.maxAltitude=180]
     * @param {number} [opts.seed=0xC10UD]
     */
    constructor(opts) {
        this.planetConfig = opts.planetConfig;
        this.genericMeshRenderer = opts.genericMeshRenderer;
        this.targetCount = opts.targetCount ?? 28;
        this.cellSize = opts.cellSizeMeters ?? 90;
        this.streamRadius = opts.streamRadiusCells ?? 4;
        this.minAltitude = opts.minAltitude ?? 30;
        this.maxAltitude = opts.maxAltitude ?? 180;
        this.seed = opts.seed ?? 0xC10D;

        // Active clouds keyed by "fx,fy,fz" cell string.
        this._active = new Map();
        this._time = 0;
    }

    /**
     * Publish the current cloud top-surfaces as colliders to the
     * movement resolver. Call AFTER update() has run for the frame.
     */
    publishColliders(platformColliderSystem) {
        if (!platformColliderSystem) return;
        platformColliderSystem.beginFrame();
        const origin = this.planetConfig.origin;
        for (const cloud of this._active.values()) {
            const m = cloud.model;
            // Model position is the ellipsoid CENTER; top-surface sits
            // thickness meters along the local radial. Use that for the
            // collider's top position so the actor rests on the visible
            // cloud surface, not the center.
            const cx = m.position.x, cy = m.position.y, cz = m.position.z;
            let dx = cx - origin.x, dy = cy - origin.y, dz = cz - origin.z;
            const dl = Math.hypot(dx, dy, dz) || 1;
            dx /= dl; dy /= dl; dz /= dl;
            const top = {
                x: cx + dx * cloud.model.thickness,
                y: cy + dy * cloud.model.thickness,
                z: cz + dz * cloud.model.thickness,
            };
            // Spawn/fade clouds: only solid when scale is non-trivial,
            // so the player can't stand on a ghost-phase cloud.
            const s = cloud.model.scale?.x ?? 1;
            if (s < 0.45) continue;
            platformColliderSystem.add(top, cloud.model.radius * s, 1.4);
        }
        platformColliderSystem.upload();
    }

    /** Call each frame with the player position. */
    async update(dt, playerPosition) {
        if (!playerPosition || !this.genericMeshRenderer) return;
        this._time += dt;

        const origin = this.planetConfig.origin;
        const cs = this.cellSize;

        // Player's altitude is our reference: clouds are placed
        // minAltitude..maxAltitude meters ABOVE this. That way they sit
        // above the terrain regardless of where on the planet the player
        // is, without needing a CPU terrain sample.
        const pdx = playerPosition.x - origin.x;
        const pdy = playerPosition.y - origin.y;
        const pdz = playerPosition.z - origin.z;
        this._playerAltitude = Math.hypot(pdx, pdy, pdz);

        // Project player into integer cell grid around the origin.
        const pcx = Math.round((playerPosition.x - origin.x) / cs);
        const pcy = Math.round((playerPosition.y - origin.y) / cs);
        const pcz = Math.round((playerPosition.z - origin.z) / cs);

        const wanted = new Set();
        const R = this.streamRadius;

        // Candidate cells within a cube around the player; kept only
        // when (a) their hash density gate fires and (b) the cell's
        // terrain-projected position is within range.
        const candidates = [];
        for (let dx = -R; dx <= R; dx++) {
            for (let dy = -R; dy <= R; dy++) {
                for (let dz = -R; dz <= R; dz++) {
                    const cx = pcx + dx, cy = pcy + dy, cz = pcz + dz;
                    const gate = hash01(cx, cy, cz, this.seed);
                    // ~25% of cells host a cloud. Density is tuned to
                    // hit targetCount within an R-neighborhood.
                    if (gate > 0.25) continue;
                    candidates.push({ cx, cy, cz, gate });
                }
            }
        }
        // Keep the closest candidates (by cube-distance) up to targetCount.
        candidates.sort((a, b) =>
            (Math.abs(a.cx - pcx) + Math.abs(a.cy - pcy) + Math.abs(a.cz - pcz)) -
            (Math.abs(b.cx - pcx) + Math.abs(b.cy - pcy) + Math.abs(b.cz - pcz))
        );
        const keep = candidates.slice(0, this.targetCount);
        for (const c of keep) wanted.add(`${c.cx},${c.cy},${c.cz}`);

        // Evict clouds outside the wanted set.
        for (const [key, cloud] of this._active) {
            if (!wanted.has(key)) {
                this.genericMeshRenderer.removeModel(cloud.modelName);
                this._active.delete(key);
            }
        }

        // Spawn missing clouds.
        for (const c of keep) {
            const key = `${c.cx},${c.cy},${c.cz}`;
            if (this._active.has(key)) continue;
            await this._spawnCloud(c.cx, c.cy, c.cz);
        }

        // Per-frame animation update for all active clouds.
        for (const cloud of this._active.values()) {
            this._animateCloud(cloud, dt);
        }
    }

    async _spawnCloud(cx, cy, cz) {
        const origin = this.planetConfig.origin;
        const radius = this.planetConfig.radius;
        const cs = this.cellSize;

        // Deterministic per-cell parameters.
        const h0 = hash01(cx, cy, cz, this.seed ^ 0xAAA1);
        const h1 = hash01(cx, cy, cz, this.seed ^ 0xAAA2);
        const h2 = hash01(cx, cy, cz, this.seed ^ 0xAAA3);
        const h3 = hash01(cx, cy, cz, this.seed ^ 0xAAA4);
        const h4 = hash01(cx, cy, cz, this.seed ^ 0xAAA5);
        const h5 = hash01(cx, cy, cz, this.seed ^ 0xAAA6);

        // Cell center jittered inside the cell.
        const jx = (h0 - 0.5) * cs * 0.85;
        const jy = (h1 - 0.5) * cs * 0.85;
        const jz = (h2 - 0.5) * cs * 0.85;
        const baseX = origin.x + cx * cs + jx;
        const baseY = origin.y + cy * cs + jy;
        const baseZ = origin.z + cz * cs + jz;

        // Project onto the planet surface then lift by altitude.
        let dx = baseX - origin.x, dy = baseY - origin.y, dz = baseZ - origin.z;
        const dl = Math.hypot(dx, dy, dz) || 1;
        dx /= dl; dy /= dl; dz /= dl;

        const altitude = this.minAltitude + (this.maxAltitude - this.minAltitude) * h3;
        // Base off the player's altitude so the cloud sits ABOVE terrain
        // regardless of where on the planet we are. This snapshot is
        // captured at spawn time and frozen for the cloud's lifetime so
        // the player's jumping/falling doesn't drag clouds around.
        const baseAlt = this._playerAltitude || (radius + 100);
        const surfaceR = baseAlt + altitude;
        const px = origin.x + dx * surfaceR;
        const py = origin.y + dy * surfaceR;
        const pz = origin.z + dz * surfaceR;

        // Mode: 0 static, 1 ping-pong, 2 erratic, 3 spawn/fade.
        const mode = Math.floor(h4 * 4) & 3;

        const platformRadius = 4.5 + h5 * 4.5;        // 4.5–9.0 m
        const thickness = 1.2 + h0 * 1.0;             // 1.2–2.2 m

        const model = new CloudPlatformModel({
            name: `cloud-${cx}_${cy}_${cz}`,
            radius: platformRadius,
            thickness
        });

        // Position BEFORE addModel. addModel awaits the async backend
        // initialize; a render frame can fire during that await and would
        // see the model at (0,0,0) if we deferred positioning until after.
        model.setPositionDirect(px, py, pz);
        model.updateModelMatrix();

        const modelName = `cloud-${cx}_${cy}_${cz}`;
        await this.genericMeshRenderer.addModel(modelName, model);

        const frame = tangentFrameAt({ x: px, y: py, z: pz }, origin);
        const cloud = {
            modelName,
            model,
            basePos: { x: px, y: py, z: pz },
            frame,
            mode,
            // Per-mode parameters:
            pingPongAmplitude: 6 + h5 * 10,           // m
            pingPongPhase: h0 * TAU,
            pingPongPeriod: 6 + h1 * 6,               // s
            erraticAmpA: 4 + h2 * 8,
            erraticAmpB: 4 + h3 * 8,
            erraticFreqA: 0.12 + h4 * 0.25,
            erraticFreqB: 0.18 + h5 * 0.32,
            fadePeriod: 8 + h0 * 6,
            fadePhase: h1 * TAU,
            birth: this._time,
        };
        this._active.set(`${cx},${cy},${cz}`, cloud);
    }

    _animateCloud(cloud, _dt) {
        const t = this._time;
        const base = cloud.basePos;
        let offsetT = 0, offsetB = 0, scale = 1;

        if (cloud.mode === 1) {
            offsetT = Math.sin((t / cloud.pingPongPeriod) * TAU + cloud.pingPongPhase) * cloud.pingPongAmplitude;
        } else if (cloud.mode === 2) {
            offsetT = Math.sin(t * cloud.erraticFreqA * TAU + cloud.pingPongPhase) * cloud.erraticAmpA
                    + Math.sin(t * cloud.erraticFreqB * TAU * 0.7) * 0.3 * cloud.erraticAmpA;
            offsetB = Math.cos(t * cloud.erraticFreqB * TAU + cloud.fadePhase) * cloud.erraticAmpB;
        } else if (cloud.mode === 3) {
            // Breathing spawn/fade — 0 at phase 0, full at PI, 0 at TAU.
            const k = 0.5 - 0.5 * Math.cos((t / cloud.fadePeriod) * TAU + cloud.fadePhase);
            scale = 0.25 + 0.9 * k;
        }

        const px = base.x + cloud.frame.tangent.x * offsetT + cloud.frame.bitangent.x * offsetB;
        const py = base.y + cloud.frame.tangent.y * offsetT + cloud.frame.bitangent.y * offsetB;
        const pz = base.z + cloud.frame.tangent.z * offsetT + cloud.frame.bitangent.z * offsetB;

        cloud.model.setPositionDirect(px, py, pz);
        cloud.model.setScale(scale);
        cloud.model.updateModelMatrix();
    }

    dispose() {
        for (const cloud of this._active.values()) {
            this.genericMeshRenderer?.removeModel(cloud.modelName);
        }
        this._active.clear();
    }
}
