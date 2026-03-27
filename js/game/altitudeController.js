export class AltitudeController {
    constructor(spaceship) {
        this.spaceship = spaceship;
        this.mode = 'keyboard';
    }
    
    update(deltaTime, keys) {
        if (this.mode === 'keyboard') {
            this.updateKeyboard(deltaTime, keys);
        }
    }
    
    updateKeyboard(deltaTime, keys) {
        let turningLeft = false;
        let turningRight = false;
        let pitchingUp = false;
        let pitchingDown = false;
        let thrustingUp = false;
        let thrustingDown = false;
        
        // W/S - Speed
        if (keys['w']) {
            this.spaceship.increaseSpeed(deltaTime);
        }
        if (keys['s']) {
            this.spaceship.decreaseSpeed(deltaTime);
        }
        
        // A/D - Turn (yaw)
        if (keys['a']) {
            this.spaceship.turnLeft(deltaTime);
            turningLeft = true;
        }
        if (keys['d']) {
            this.spaceship.turnRight(deltaTime);
            turningRight = true;
        }
        
        // Z/X - Pitch
        if (keys['z']) {
            this.spaceship.pitchDown(deltaTime);
            pitchingDown = true;
        }
        if (keys['x']) {
            this.spaceship.pitchUp(deltaTime);
            pitchingUp = true;
        }
        
        // Q/E - Vertical thrust (no direction change)
        if (keys['q']) {
            this.spaceship.thrustDown(deltaTime);
            thrustingDown = true;
        }
        if (keys['e']) {
            this.spaceship.thrustUp(deltaTime);
            thrustingUp = true;
        }
        
        // Auto-return to neutral
        if (!turningLeft && !turningRight) {
            this.spaceship.neutralizeRoll(deltaTime);
        }
        if (!pitchingUp && !pitchingDown) {
            this.spaceship.neutralizePitch(deltaTime);
        }
        // Note: vertical thrust decays automatically in update()
    }
    
    setupPitchInput(pitchCallback) {
        this.mode = 'pitch';
        this.pitchCallback = pitchCallback;
    }
    
    useKeyboard() {
        this.mode = 'keyboard';
    }
}