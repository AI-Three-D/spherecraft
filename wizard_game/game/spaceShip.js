export class Spaceship {
    constructor() {
        this.position = { x: 0, y: 0, z: 15 };
        this.velocity = { x: 0, y: 0, z: 0 };
        
        this.speed = 5;
        this.maxSpeed = 20;
        this.acceleration = 8;
        this.deceleration = 12;
        
        this.direction = 0;
        this.pitch = 0;
        this.roll = 0;
        
        this.turnRate = 1.5;
        this.pitchRate = 1.0;
        this.maxPitch = Math.PI / 3;
        
        this.verticalThrust = 0;
        this.maxVerticalThrust = 10;
        this.verticalThrustRate = 15;
        
        // Improved smoothing
        this.targetVelocity = { x: 0, y: 0, z: 0 };
        this.baseVelocitySmoothing = 0.15; // Base smoothing
        this.minVelocitySmoothing = 0.4;   // At high speed, respond faster
        
        this.minSafeAltitude = 3;
        this.criticalAltitude = 80;
        
        this.state = 'flying';
        this.spinSpeed = 0;
        this.controlLoss = 0;
    }
    
    update(deltaTime, terrainHeight) {
        if (this.state === 'crashed') return 'crashed';
        
        // Clamp deltaTime to prevent huge jumps
        deltaTime = Math.min(deltaTime, 1/30); // Max 33ms
        
        // Out of control
        if (this.position.z > this.criticalAltitude) {
            this.controlLoss = Math.min(1, this.controlLoss + deltaTime * 0.5);
            this.spinSpeed += deltaTime * 2;
            this.state = 'outOfControl';
        } else {
            this.controlLoss = Math.max(0, this.controlLoss - deltaTime * 0.3);
            if (this.state === 'outOfControl' && this.controlLoss < 0.3) {
                this.state = 'flying';
                this.spinSpeed = 0;
            }
        }
        
        if (this.state === 'outOfControl') {
            this.direction += this.spinSpeed * deltaTime;
            this.verticalThrust = -20;
            this.roll += deltaTime * this.spinSpeed * 2;
        }
        
        // Calculate 3D direction vector
        const directionVector = {
            x: Math.cos(this.pitch) * Math.cos(this.direction),
            y: Math.cos(this.pitch) * Math.sin(this.direction),
            z: Math.sin(this.pitch)
        };
        
        // Target velocity
        this.targetVelocity.x = directionVector.x * this.speed;
        this.targetVelocity.y = directionVector.y * this.speed;
        this.targetVelocity.z = directionVector.z * this.speed + this.verticalThrust;
        
        // Speed-adaptive smoothing: smooth less at high speeds
        const speedRatio = this.speed / this.maxSpeed;
        const smoothing = this.baseVelocitySmoothing + 
                         (this.minVelocitySmoothing - this.baseVelocitySmoothing) * speedRatio;
        
        // Smooth velocity changes
        this.velocity.x += (this.targetVelocity.x - this.velocity.x) * smoothing;
        this.velocity.y += (this.targetVelocity.y - this.velocity.y) * smoothing;
        this.velocity.z += (this.targetVelocity.z - this.velocity.z) * smoothing;
        
        // Apply velocity
        this.position.x += this.velocity.x * deltaTime;
        this.position.y += this.velocity.y * deltaTime;
        this.position.z += this.velocity.z * deltaTime;
        
        // Terrain collision
        const minAltitude = terrainHeight + this.minSafeAltitude;
        if (this.position.z < minAltitude) {
            const verticalSpeed = Math.abs(this.velocity.z);
            if (verticalSpeed > 5 || this.speed > 10) {
                this.crash();
                return 'crashed';
            } else {
                this.position.z = minAltitude;
                this.velocity.z = 0;
                this.targetVelocity.z = 0;
            }
        }
        
        // Decay vertical thrust
        const thrustDecay = 5.0 * deltaTime;
        if (Math.abs(this.verticalThrust) > thrustDecay) {
            this.verticalThrust -= Math.sign(this.verticalThrust) * thrustDecay;
        } else {
            this.verticalThrust = 0;
        }
        
        return this.state;
    }
    
    turnLeft(deltaTime) {
        if (this.state !== 'flying') return;
        this.direction -= this.turnRate * deltaTime;
        this.roll = Math.min(0.6, this.roll + deltaTime * 3);
    }
    
    turnRight(deltaTime) {
        if (this.state !== 'flying') return;
        this.direction += this.turnRate * deltaTime;
        this.roll = Math.max(-0.6, this.roll - deltaTime * 3);
    }
    
    increaseSpeed(deltaTime) {
        if (this.state !== 'flying') return;
        this.speed = Math.min(this.maxSpeed, this.speed + this.acceleration * deltaTime);
    }
    
    decreaseSpeed(deltaTime) {
        this.speed = Math.max(0, this.speed - this.deceleration * deltaTime);
    }
    
    pitchUp(deltaTime) {
        if (this.state !== 'flying') return;
        this.pitch = Math.min(this.maxPitch, this.pitch + this.pitchRate * deltaTime);
    }
    
    pitchDown(deltaTime) {
        if (this.state !== 'flying') return;
        this.pitch = Math.max(-this.maxPitch, this.pitch - this.pitchRate * deltaTime);
    }
    
    thrustUp(deltaTime) {
        if (this.state !== 'flying') return;
        this.verticalThrust = Math.min(
            this.maxVerticalThrust,
            this.verticalThrust + this.verticalThrustRate * deltaTime
        );
    }
    
    thrustDown(deltaTime) {
        if (this.state !== 'flying') return;
        this.verticalThrust = Math.max(
            -this.maxVerticalThrust,
            this.verticalThrust - this.verticalThrustRate * deltaTime
        );
    }
    
    neutralizePitch(deltaTime) {
        const returnSpeed = 1.5;
        if (Math.abs(this.pitch) > 0.01) {
            this.pitch -= Math.sign(this.pitch) * Math.min(Math.abs(this.pitch), returnSpeed * deltaTime);
        } else {
            this.pitch = 0;
        }
    }
    
    neutralizeRoll(deltaTime) {
        const returnSpeed = 2.0;
        if (Math.abs(this.roll) > 0.01) {
            this.roll -= Math.sign(this.roll) * Math.min(Math.abs(this.roll), returnSpeed * deltaTime);
        } else {
            this.roll = 0;
        }
    }
    
    crash() {
        this.state = 'crashed';
        this.speed = 0;
        this.velocity = { x: 0, y: 0, z: 0 };
        this.targetVelocity = { x: 0, y: 0, z: 0 };
        this.verticalThrust = 0;
        
    }
    
    reset(x = 0, y = 0, altitude = 15) {
        this.position = { x, y, z: altitude };
        this.velocity = { x: 0, y: 0, z: 0 };
        this.targetVelocity = { x: 0, y: 0, z: 0 };
        this.speed = 5;
        this.direction = 0;
        this.pitch = 0;
        this.roll = 0;
        this.verticalThrust = 0;
        this.state = 'flying';
        this.spinSpeed = 0;
        this.controlLoss = 0;
    }
    
    getState() {
        return {
            position: { ...this.position },
            velocity: { ...this.velocity },
            direction: this.direction,
            pitch: this.pitch,
            roll: this.roll,
            speed: this.speed,
            verticalThrust: this.verticalThrust,
            state: this.state,
            controlLoss: this.controlLoss
        };
    }
    
    getForwardVector2D() {
        return {
            x: Math.cos(this.direction),
            y: Math.sin(this.direction)
        };
    }
}