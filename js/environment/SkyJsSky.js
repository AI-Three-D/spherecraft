import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.178.0/build/three.module.js';
import { Sky } from 'https://cdn.jsdelivr.net/npm/three@0.178.0/examples/jsm/objects/Sky.js';
import { BaseSky } from './BaseSky.js';

export class SkyJsSky extends BaseSky {
    constructor(scene) {
        super();
        this.sky = new Sky();
        this.sky.scale.setScalar(450000);
        scene.add(this.sky);

        // Cache uniform references for performance
        this.uniforms = this.sky.material.uniforms;

        // Initialize defaults
        this.uniforms.turbidity.value = 3;
        this.uniforms.rayleigh.value = 2;
        this.uniforms.mieCoefficient.value = 0.005;
        this.uniforms.mieDirectionalG.value = 0.8;

        // Helper sun vector for updating
        this.sun = new THREE.Vector3();
    }

    updateFromEnvironment(envState) {
        // Sun position/direction
        const distance = 400000;
        this.sun.copy(envState.sunLightDirection).multiplyScalar(distance);
        this.uniforms.sunPosition.value.copy(this.sun);

        // Map environment weather to sky shader
        switch (envState.currentWeather) {
            case 'clear':
                this.uniforms.turbidity.value = 2;
                this.uniforms.rayleigh.value = 3;
                this.uniforms.mieCoefficient.value = 0.005;
                this.uniforms.mieDirectionalG.value = 0.8;
                break;
            case 'rain':
                this.uniforms.turbidity.value = 10 + 10 * envState.weatherIntensity;
                this.uniforms.rayleigh.value = 0.5;
                this.uniforms.mieCoefficient.value = 0.035 + envState.weatherIntensity * 0.05;
                this.uniforms.mieDirectionalG.value = 0.92 + envState.weatherIntensity * 0.01;
                break;
            case 'storm':
                this.uniforms.turbidity.value = 15 + 7 * envState.weatherIntensity;
                this.uniforms.rayleigh.value = 0.1;
                this.uniforms.mieCoefficient.value = 0.06 + envState.weatherIntensity * 0.08;
                this.uniforms.mieDirectionalG.value = 0.96 + envState.weatherIntensity * 0.03;
                break;
            case 'foggy':
                this.uniforms.turbidity.value = 18 * Math.max(0.4, envState.weatherIntensity);
                this.uniforms.rayleigh.value = 0.2;
                this.uniforms.mieCoefficient.value = 0.015 + envState.weatherIntensity * 0.08;
                this.uniforms.mieDirectionalG.value = 0.99;
                break;
            case 'snow':
                this.uniforms.turbidity.value = 8 + 8 * envState.weatherIntensity;
                this.uniforms.rayleigh.value = 1 + (1 - envState.weatherIntensity);
                this.uniforms.mieCoefficient.value = 0.012;
                this.uniforms.mieDirectionalG.value = 0.91;
                break;
        }
    }

    update(/*deltaTime*/) { /* For animating clouds etc, in custom sky */ }

    cleanup() {
        if (this.sky.parent) this.sky.parent.remove(this.sky);
        this.sky.geometry.dispose();
        this.sky.material.dispose();
    }
}