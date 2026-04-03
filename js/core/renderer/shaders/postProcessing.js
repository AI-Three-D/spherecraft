import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.178.0/build/three.module.js';

const blurShader = {
    uniforms: {
        tDiffuse:    { value: null },
        resolution:  { value: new THREE.Vector2(1, 1) },
        direction:   { value: new THREE.Vector2(1.0, 0.0) }, // horizontal default
        strength:    { value: 1.0 }
    },
    vertexShader: `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = vec4(position.xy, 0.0, 1.0);
        }
    `,
    fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform vec2 resolution;
        uniform vec2 direction;
        uniform float strength;
        varying vec2 vUv;

        void main() {
            float offsets[5];
            offsets[0] = -2.0; offsets[1] = -1.0; offsets[2] = 0.0; offsets[3] = 1.0; offsets[4] = 2.0;
            float weights[5];
            weights[0] = 0.05; weights[1] = 0.20; weights[2] = 0.5; weights[3] = 0.20; weights[4] = 0.05;

            vec4 color = vec4(0.0);
            for(int i = 0; i < 5; i++) {
                vec2 offset = direction * offsets[i] * strength / resolution;
                color += texture2D(tDiffuse, vUv + offset) * weights[i];
            }
            gl_FragColor = color;
        }
    `
};

// You *must* pass a new uniforms object to each ShaderMaterial instance (use clone)
const blurMaterial = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.clone(blurShader.uniforms),
    vertexShader: blurShader.vertexShader,
    fragmentShader: blurShader.fragmentShader
});

// Composite and Tone-Mapping Shader (combines scene + blurred bloom, then tone-maps)
const compositeShader = {
    uniforms: {
        tScene:        { value: null },
        tBloom:        { value: null },
        bloomStrength: { value: 0.7 }
    },
    vertexShader: `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = vec4(position.xy, 0.0, 1.0);
        }
    `,
    fragmentShader: `
        uniform sampler2D tScene;
        uniform sampler2D tBloom;
        uniform float bloomStrength;
        varying vec2 vUv;

        // ACES Filmic Tone Mapping
        vec3 ACESFilm(vec3 x) {
            float a = 2.51;
            float b = 0.03;
            float c = 2.43;
            float d = 0.59;
            float e = 0.14;
            return clamp((x*(a*x+b))/(x*(c*x+d)+e), 0.0, 1.0);
        }

        void main() {
            vec3 sceneCol = texture2D(tScene, vUv).rgb;
            vec3 bloomCol = texture2D(tBloom, vUv).rgb;

            vec3 color = sceneCol + bloomCol * bloomStrength;
            color = ACESFilm(color);

            gl_FragColor = vec4(color, 1.0);
        }
    `
};

// Same pattern: uniforms must be cloned!
const compositeMaterial = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.clone(compositeShader.uniforms),
    vertexShader: compositeShader.vertexShader,
    fragmentShader: compositeShader.fragmentShader
});

export { blurMaterial, compositeMaterial, blurShader, compositeShader };