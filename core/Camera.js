export class Camera {
    constructor(config = {}) {
        this.position = { x: 0, y: 50, z: 0 };
        this.target = { x: 0, y: 0, z: 0 };
        this.up = { x: 0, y: 1, z: 0 };

        this.aspect = config.aspect || 16 / 9;
        this.fov = config.fov || 75;
        this.near = config.near || 0.1;
        this.far = config.far || 50000;

        this.following = null;

        this.cameraDistance = config.cameraDistance || 15;
        this.cameraHeight = config.cameraHeight || 6;
        this.baseLookAtSmoothing = config.lookAtSmoothing || 0.15;
        this.lookAheadDistance = config.lookAheadDistance || 10;
        this.lookAheadHeight = config.lookAheadHeight || 2;

        this.orbitYaw = 0;
        this.orbitPitch = 0.3;
        this.orbitPitchMin = -Math.PI / 2 + 0.1;
        this.orbitPitchMax = Math.PI / 2 - 0.1;

        this.manualYaw = 0;
        this.manualPitch = 0;

        // Spherical planet support
        this.planetCenter = config.planetCenter || null; // { x, y, z }
        this.useSphericalMovement = config.useSphericalMovement || false;
    }

    setPlanetCenter(center) {
        this.planetCenter = center;
        this.useSphericalMovement = center !== null;
    }

    _getLocalUp() {
        if (!this.useSphericalMovement || !this.planetCenter) {
            return { x: 0, y: 1, z: 0 };
        }
        // Local up is direction from planet center to camera position
        const dx = this.position.x - this.planetCenter.x;
        const dy = this.position.y - this.planetCenter.y;
        const dz = this.position.z - this.planetCenter.z;
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 0.001) return { x: 0, y: 1, z: 0 };
        return { x: dx / len, y: dy / len, z: dz / len };
    }

    _getFallbackRight(localUp) {
        const useWorldY = Math.abs(localUp.y) < 0.9;
        const refX = useWorldY ? 0 : 1;
        const refY = useWorldY ? 1 : 0;
        const refZ = 0;

        const x = refY * localUp.z - refZ * localUp.y;
        const y = refZ * localUp.x - refX * localUp.z;
        const z = refX * localUp.y - refY * localUp.x;
        const len = Math.sqrt(x * x + y * y + z * z);

        if (len < 0.001) {
            return { x: 0, y: 0, z: 1 };
        }

        return { x: x / len, y: y / len, z: z / len };
    }

    follow(entity) {
        this.following = entity;
        if (entity) {
            this._snapToEntity(entity);
        }
    }

    unfollow() {
        this.following = null;
    }
    
    /**
     * Snap camera to entity position.
     */
    _snapToEntity(entity) {
        const fwd = entity.getForwardVector2D();

        const offsetX = -fwd.x * this.cameraDistance;
        const offsetZ = -fwd.y * this.cameraDistance;
        
        this.position.x = entity.position.x + offsetX;
        this.position.y = entity.position.z + this.cameraHeight;
        this.position.z = entity.position.y + offsetZ;
        
        const targetOffsetX = fwd.x * this.lookAheadDistance;
        const targetOffsetZ = fwd.y * this.lookAheadDistance;
        
        this.target.x = entity.position.x + targetOffsetX;
        this.target.y = entity.position.z + this.lookAheadHeight;
        this.target.z = entity.position.y + targetOffsetZ;
    }

    
    handleOrbitInput(deltaX, deltaY, sensitivity = 0.005) {
        this.orbitYaw -= deltaX * sensitivity;
        this.orbitPitch += deltaY * sensitivity;
        this.orbitPitch = Math.max(this.orbitPitchMin, Math.min(this.orbitPitchMax, this.orbitPitch));
    }
    
    resetOrbit() {
        this.orbitYaw = 0;
        this.orbitPitch = 0.3;
    }
    
    /**
     * Move camera relative to look direction
     * Uses local up direction on spherical planets
     */
    moveRelative(forward, right, up) {
        const dx = this.target.x - this.position.x;
        const dy = this.target.y - this.position.y;
        const dz = this.target.z - this.position.z;
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);

        if (len < 0.001) return;

        // Get the local up direction (planet surface normal or world Y)
        const localUp = this._getLocalUp();

        // Forward direction (from camera to target)
        let fwdX = dx / len;
        let fwdY = dy / len;
        let fwdZ = dz / len;

        // Right = forward cross localUp (then normalized)
        let rightX = fwdY * localUp.z - fwdZ * localUp.y;
        let rightY = fwdZ * localUp.x - fwdX * localUp.z;
        let rightZ = fwdX * localUp.y - fwdY * localUp.x;
        const rightLen = Math.sqrt(rightX * rightX + rightY * rightY + rightZ * rightZ);
        if (rightLen > 0.001) {
            rightX /= rightLen;
            rightY /= rightLen;
            rightZ /= rightLen;
        } else {
            // Fallback if forward is parallel to up
            const fallbackRight = this._getFallbackRight(localUp);
            rightX = fallbackRight.x;
            rightY = fallbackRight.y;
            rightZ = fallbackRight.z;
        }

        // Recompute forward to be perpendicular to localUp (for horizontal movement)
        // This ensures movement stays tangent to the planet surface
        if (this.useSphericalMovement) {
            // Forward on surface = localUp cross right
            fwdX = localUp.y * rightZ - localUp.z * rightY;
            fwdY = localUp.z * rightX - localUp.x * rightZ;
            fwdZ = localUp.x * rightY - localUp.y * rightX;
            const fLen = Math.sqrt(fwdX * fwdX + fwdY * fwdY + fwdZ * fwdZ);
            if (fLen > 0.001) {
                fwdX /= fLen;
                fwdY /= fLen;
                fwdZ /= fLen;
            }
        }

        // Compute movement vector
        const moveX = fwdX * forward + rightX * right + localUp.x * up;
        const moveY = fwdY * forward + rightY * right + localUp.y * up;
        const moveZ = fwdZ * forward + rightZ * right + localUp.z * up;

        this.position.x += moveX;
        this.position.y += moveY;
        this.position.z += moveZ;

        this.target.x += moveX;
        this.target.y += moveY;
        this.target.z += moveZ;
    }
    
    /**
     * Manual look controls (for free camera mode)
     * Rotates the look-at vector directly around up (yaw) and right (pitch) axes
     */
    handleManualLook(deltaX, deltaY, sensitivity = 0.003) {
        // Get current look direction
        let lookX = this.target.x - this.position.x;
        let lookY = this.target.y - this.position.y;
        let lookZ = this.target.z - this.position.z;
        const distance = Math.sqrt(lookX * lookX + lookY * lookY + lookZ * lookZ);

        if (distance < 0.001) return;

        // Normalize look direction
        lookX /= distance;
        lookY /= distance;
        lookZ /= distance;

        // Get local up (for spherical planets) or world up
        const localUp = this._getLocalUp();

        // Compute right vector = look cross up
        let rightX = lookY * localUp.z - lookZ * localUp.y;
        let rightY = lookZ * localUp.x - lookX * localUp.z;
        let rightZ = lookX * localUp.y - lookY * localUp.x;
        const rightLen = Math.sqrt(rightX * rightX + rightY * rightY + rightZ * rightZ);

        if (rightLen > 0.001) {
            rightX /= rightLen;
            rightY /= rightLen;
            rightZ /= rightLen;
        } else {
            // Looking straight up/down - use a fallback right vector
            const fallbackRight = this._getFallbackRight(localUp);
            rightX = fallbackRight.x;
            rightY = fallbackRight.y;
            rightZ = fallbackRight.z;
        }

        // Rotate around up axis (yaw - horizontal mouse movement)
        const yawAngle = -deltaX * sensitivity;
        if (Math.abs(yawAngle) > 0.0001) {
            const result = this._rotateVectorAroundAxis(lookX, lookY, lookZ, localUp.x, localUp.y, localUp.z, yawAngle);
            lookX = result.x;
            lookY = result.y;
            lookZ = result.z;

            // Update right vector after yaw rotation
            rightX = lookY * localUp.z - lookZ * localUp.y;
            rightY = lookZ * localUp.x - lookX * localUp.z;
            rightZ = lookX * localUp.y - lookY * localUp.x;
            const rLen = Math.sqrt(rightX * rightX + rightY * rightY + rightZ * rightZ);
            if (rLen > 0.001) {
                rightX /= rLen;
                rightY /= rLen;
                rightZ /= rLen;
            }
        }

        // Rotate around right axis (pitch - vertical mouse movement)
        const pitchAngle = -deltaY * sensitivity;
        if (Math.abs(pitchAngle) > 0.0001) {
            const result = this._rotateVectorAroundAxis(lookX, lookY, lookZ, rightX, rightY, rightZ, pitchAngle);
            lookX = result.x;
            lookY = result.y;
            lookZ = result.z;
        }

        // Update target position
        this.target.x = this.position.x + lookX * distance;
        this.target.y = this.position.y + lookY * distance;
        this.target.z = this.position.z + lookZ * distance;
    }

    /**
     * Rotate a vector around an axis using Rodrigues' rotation formula
     */
    _rotateVectorAroundAxis(vx, vy, vz, ax, ay, az, angle) {
        const cosA = Math.cos(angle);
        const sinA = Math.sin(angle);
        const dot = vx * ax + vy * ay + vz * az;

        // v * cos(a) + (axis x v) * sin(a) + axis * (axis . v) * (1 - cos(a))
        return {
            x: vx * cosA + (ay * vz - az * vy) * sinA + ax * dot * (1 - cosA),
            y: vy * cosA + (az * vx - ax * vz) * sinA + ay * dot * (1 - cosA),
            z: vz * cosA + (ax * vy - ay * vx) * sinA + az * dot * (1 - cosA)
        };
    }
    
    handleZoom(delta, zoomSpeed = 0.001) {
        const zoomFactor = 1.0 + delta * zoomSpeed;
        this.cameraDistance *= zoomFactor;
        this.cameraDistance = Math.max(5, Math.min(100, this.cameraDistance));
    }

    setPosition(x, y, z) {
        this.position.x = x;
        this.position.y = y;
        this.position.z = z;
    }

    lookAt(x, y, z) {
        this.target.x = x;
        this.target.y = y;
        this.target.z = z;
    }
}
