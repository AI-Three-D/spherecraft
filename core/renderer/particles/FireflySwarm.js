// core/renderer/particles/FireflySwarm.js
//
// CPU-side Boids simulation for a small swarm (4-10) of fireflies.
// Each frame the swarm updates positions and emits tiny bright particles
// through the existing particle system. A dim point light follows the
// swarm centroid.
//
// The swarm uses a loose Boids algorithm (high separation, low cohesion)
// so individual fireflies meander independently rather than flocking.

import { Vector3 } from '../../../shared/math/index.js';

const DEFAULT_SWARM_SIZE = 7;
const BOID_SPEED_MIN = 0.15;
const BOID_SPEED_MAX = 0.5;
const BOID_SEPARATION_RADIUS = 1.2;
const BOID_SEPARATION_WEIGHT = 0.8;
const BOID_ALIGNMENT_WEIGHT = 0.05;
const BOID_COHESION_WEIGHT = 0.02;
const BOID_BOUNDARY_WEIGHT = 0.3;
const BOID_WANDER_WEIGHT = 0.15;
const BOID_BOUNDARY_RADIUS = 4.0;
const BOID_HEIGHT_RANGE = [1.5, 4.0];  // height above spawn (local up)

export class FireflySwarm {
    constructor({
        position,
        swarmSize = DEFAULT_SWARM_SIZE,
        planetOrigin = { x: 0, y: 0, z: 0 },
    }) {
        this.origin = { x: position.x, y: position.y, z: position.z };
        this.swarmSize = Math.max(4, Math.min(10, swarmSize));
        this.planetOrigin = planetOrigin;

        // Per-firefly state.
        this.positions = [];
        this.velocities = [];
        this.phases = [];      // per-firefly glow oscillation phase
        this.glowFactors = []; // per-firefly glow intensity multiplier (varies)

        // Centroid for the point light.
        this.centroid = { x: position.x, y: position.y, z: position.z };

        // Time-of-day glow multiplier (0-1). Set externally each frame.
        this.timeOfDayGlow = 1.0;

        // Current emitter index — cycles through fireflies each frame.
        this._emitIndex = 0;
        this._time = 0;

        this._initBoids();
    }

    _initBoids() {
        const ox = this.origin.x;
        const oy = this.origin.y;
        const oz = this.origin.z;

        // Compute local up at the origin.
        const ux = ox - this.planetOrigin.x;
        const uy = oy - this.planetOrigin.y;
        const uz = oz - this.planetOrigin.z;
        const ulen = Math.sqrt(ux * ux + uy * uy + uz * uz);
        this._localUp = ulen > 1e-6
            ? { x: ux / ulen, y: uy / ulen, z: uz / ulen }
            : { x: 0, y: 1, z: 0 };

        for (let i = 0; i < this.swarmSize; i++) {
            const angle = Math.random() * Math.PI * 2;
            const r = Math.random() * BOID_BOUNDARY_RADIUS * 0.5;
            const h = BOID_HEIGHT_RANGE[0] + Math.random() * (BOID_HEIGHT_RANGE[1] - BOID_HEIGHT_RANGE[0]);

            // Scatter in a disc perpendicular to local up + height offset.
            const up = this._localUp;
            // Build a rough tangent basis.
            let rx, ry, rz;
            if (Math.abs(up.y) < 0.9) {
                rx = 0; ry = 1; rz = 0;
            } else {
                rx = 1; ry = 0; rz = 0;
            }
            // Cross product for tangent.
            const tx = up.y * rz - up.z * ry;
            const ty = up.z * rx - up.x * rz;
            const tz = up.x * ry - up.y * rx;
            const tlen = Math.sqrt(tx * tx + ty * ty + tz * tz);
            const t1x = tx / tlen, t1y = ty / tlen, t1z = tz / tlen;
            // Second tangent via cross.
            const t2x = up.y * t1z - up.z * t1y;
            const t2y = up.z * t1x - up.x * t1z;
            const t2z = up.x * t1y - up.y * t1x;

            this.positions.push({
                x: ox + t1x * Math.cos(angle) * r + t2x * Math.sin(angle) * r + up.x * h,
                y: oy + t1y * Math.cos(angle) * r + t2y * Math.sin(angle) * r + up.y * h,
                z: oz + t1z * Math.cos(angle) * r + t2z * Math.sin(angle) * r + up.z * h,
            });

            const speed = BOID_SPEED_MIN + Math.random() * (BOID_SPEED_MAX - BOID_SPEED_MIN);
            const va = Math.random() * Math.PI * 2;
            this.velocities.push({
                x: t1x * Math.cos(va) * speed + t2x * Math.sin(va) * speed,
                y: t1y * Math.cos(va) * speed + t2y * Math.sin(va) * speed,
                z: t1z * Math.cos(va) * speed + t2z * Math.sin(va) * speed,
            });

            this.phases.push(Math.random() * Math.PI * 2);
            this.glowFactors.push(0.7 + Math.random() * 0.6); // 0.7-1.3
        }
    }

    // Call once per frame. Returns the centroid position.
    update(deltaTime) {
        const dt = Math.min(deltaTime, 0.05);
        this._time += dt;

        const n = this.swarmSize;
        const up = this._localUp;

        // Compute centroid.
        let cx = 0, cy = 0, cz = 0;
        for (let i = 0; i < n; i++) {
            cx += this.positions[i].x;
            cy += this.positions[i].y;
            cz += this.positions[i].z;
        }
        cx /= n; cy /= n; cz /= n;
        this.centroid.x = cx; this.centroid.y = cy; this.centroid.z = cz;

        for (let i = 0; i < n; i++) {
            const p = this.positions[i];
            const v = this.velocities[i];

            // --- Boids forces ---
            let sepX = 0, sepY = 0, sepZ = 0;
            let aliX = 0, aliY = 0, aliZ = 0;
            let cohX = 0, cohY = 0, cohZ = 0;
            let neighbors = 0;

            for (let j = 0; j < n; j++) {
                if (j === i) continue;
                const op = this.positions[j];
                const dx = p.x - op.x;
                const dy = p.y - op.y;
                const dz = p.z - op.z;
                const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

                if (dist < BOID_SEPARATION_RADIUS && dist > 0.001) {
                    const inv = 1.0 / dist;
                    sepX += dx * inv;
                    sepY += dy * inv;
                    sepZ += dz * inv;
                }

                aliX += this.velocities[j].x;
                aliY += this.velocities[j].y;
                aliZ += this.velocities[j].z;
                cohX += op.x;
                cohY += op.y;
                cohZ += op.z;
                neighbors++;
            }

            if (neighbors > 0) {
                aliX /= neighbors; aliY /= neighbors; aliZ /= neighbors;
                cohX /= neighbors; cohY /= neighbors; cohZ /= neighbors;
            }

            // Boundary: pull back toward origin if too far.
            const toOriginX = this.origin.x - p.x;
            const toOriginY = this.origin.y - p.y;
            const toOriginZ = this.origin.z - p.z;
            // Project distance onto the horizontal plane (tangent to up).
            const dot = toOriginX * up.x + toOriginY * up.y + toOriginZ * up.z;
            const horizX = toOriginX - up.x * dot;
            const horizY = toOriginY - up.y * dot;
            const horizZ = toOriginZ - up.z * dot;
            const horizDist = Math.sqrt(horizX * horizX + horizY * horizY + horizZ * horizZ);
            let boundX = 0, boundY = 0, boundZ = 0;
            if (horizDist > BOID_BOUNDARY_RADIUS) {
                const excess = (horizDist - BOID_BOUNDARY_RADIUS) / horizDist;
                boundX = horizX * excess;
                boundY = horizY * excess;
                boundZ = horizZ * excess;
            }

            // Height constraint: keep within BOID_HEIGHT_RANGE above origin.
            // Height is measured along local up from origin.
            const heightVec = p.x - this.origin.x;
            const heightDot = (p.x - this.origin.x) * up.x +
                              (p.y - this.origin.y) * up.y +
                              (p.z - this.origin.z) * up.z;
            let heightForce = 0;
            if (heightDot < BOID_HEIGHT_RANGE[0]) {
                heightForce = (BOID_HEIGHT_RANGE[0] - heightDot) * 0.5;
            } else if (heightDot > BOID_HEIGHT_RANGE[1]) {
                heightForce = (BOID_HEIGHT_RANGE[1] - heightDot) * 0.5;
            }

            // Wander: gentle random perturbation.
            const wanderAngle = this._time * 0.7 + this.phases[i] * 3.0;
            const wanderX = Math.sin(wanderAngle * 1.3 + i * 7.1) * BOID_WANDER_WEIGHT;
            const wanderY = Math.cos(wanderAngle * 0.9 + i * 3.7) * BOID_WANDER_WEIGHT * 0.3;
            const wanderZ = Math.sin(wanderAngle * 1.7 + i * 11.3) * BOID_WANDER_WEIGHT;

            // Apply forces.
            v.x += (sepX * BOID_SEPARATION_WEIGHT +
                    (aliX - v.x) * BOID_ALIGNMENT_WEIGHT +
                    (cohX - p.x) * BOID_COHESION_WEIGHT +
                    boundX * BOID_BOUNDARY_WEIGHT +
                    wanderX) * dt;
            v.y += (sepY * BOID_SEPARATION_WEIGHT +
                    (aliY - v.y) * BOID_ALIGNMENT_WEIGHT +
                    (cohY - p.y) * BOID_COHESION_WEIGHT +
                    boundY * BOID_BOUNDARY_WEIGHT +
                    wanderY +
                    heightForce * up.y) * dt;
            v.z += (sepZ * BOID_SEPARATION_WEIGHT +
                    (aliZ - v.z) * BOID_ALIGNMENT_WEIGHT +
                    (cohZ - p.z) * BOID_COHESION_WEIGHT +
                    boundZ * BOID_BOUNDARY_WEIGHT +
                    wanderZ) * dt;

            // Height force along up.
            v.x += up.x * heightForce * dt;
            v.y += up.y * heightForce * dt;
            v.z += up.z * heightForce * dt;

            // Clamp speed.
            const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
            if (speed > BOID_SPEED_MAX) {
                const s = BOID_SPEED_MAX / speed;
                v.x *= s; v.y *= s; v.z *= s;
            } else if (speed < BOID_SPEED_MIN && speed > 0.001) {
                const s = BOID_SPEED_MIN / speed;
                v.x *= s; v.y *= s; v.z *= s;
            }

            // Integrate position.
            p.x += v.x * dt;
            p.y += v.y * dt;
            p.z += v.z * dt;
        }

        return this.centroid;
    }

    // Returns the position of the next firefly to emit from.
    // Called once per frame by the particle system to set the emitter position.
    getNextEmitPosition() {
        const idx = this._emitIndex % this.swarmSize;
        this._emitIndex++;
        return this.positions[idx];
    }

    // Returns a per-firefly glow intensity (0-1) modulated by time of day
    // and per-firefly variation.
    getGlowIntensity(index) {
        const phase = this.phases[index];
        const factor = this.glowFactors[index];
        // Subtle pulsing.
        const pulse = 0.7 + 0.3 * Math.sin(this._time * 2.5 + phase);
        return pulse * factor * this.timeOfDayGlow;
    }

    // Computes the time-of-day glow multiplier from a light level (0-1).
    // lightLevel comes from GameTime.getLightLevel().
    static computeTimeOfDayGlow(lightLevel) {
        // Night (0.3): full glow 1.0
        // Dawn/Dusk (0.5-0.6): moderate glow ~0.3-0.5
        // Day (>=0.8): nearly off 0.02
        if (lightLevel <= 0.3) return 1.0;
        if (lightLevel >= 0.8) return 0.02;
        // Smooth interpolation between night and day.
        const t = (lightLevel - 0.3) / (0.8 - 0.3);
        return 1.0 - t * 0.98; // 1.0 -> 0.02
    }
}
