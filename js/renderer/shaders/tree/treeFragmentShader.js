/**
 * Build fragment shader for tree rendering
 * @returns {string} Fragment shader code
 */
export function buildTreeFragmentShader() {
    return `
        uniform sampler2D map;
        uniform vec4 barkUVRect;
        uniform vec4 leafUVRect;
        
        // Lighting uniforms
        uniform vec3 sunLightDirection;
        uniform vec3 sunLightColor;
        uniform float sunLightIntensity;
        uniform vec3 moonLightDirection;
        uniform vec3 moonLightColor;
        uniform float moonLightIntensity;
        uniform vec3 ambientLightColor;
        uniform float ambientLightIntensity;
        uniform vec3 skyAmbientColor;
        uniform vec3 groundAmbientColor;
        
        uniform vec3 fogColor;
        uniform float fogDensity;
        uniform float weatherIntensity;
        uniform float currentWeather;
        
        varying vec2 vUv;
        varying vec3 vNormal;
        varying vec3 vWorldPosition;
        varying float vDistanceToCamera;
        varying vec3 vColor;
        
        void main() {
            vec2 texCoord;
            vec3 baseColor;
            float alpha = 1.0;
            bool isLeaf = vColor.r > 0.5;  
            
            if (isLeaf) {
                texCoord = vec2(
                    mix(leafUVRect.x, leafUVRect.z, vUv.x),
                    mix(leafUVRect.y, leafUVRect.w, vUv.y)
                );

                vec4 leafTexture = texture2D(map, texCoord);

                baseColor = leafTexture.rgb;
                alpha = leafTexture.a;
                if (alpha < 0.15) discard;

            } else {
                texCoord = vec2(
                    mix(barkUVRect.x, barkUVRect.z, vUv.x),
                    mix(barkUVRect.y, barkUVRect.w, vUv.y)
                );
                vec3 barkTex = texture2D(map, texCoord).rgb;
                baseColor = length(barkTex) > 0.01 ? barkTex : vec3(0.3, 0.2, 0.1);
            }
            
            // Simple lighting
            vec3 N = normalize(vNormal);
            vec3 sun = normalize(sunLightDirection);
            
            float NdLsun = max(dot(N, sun), 0.0);
            
            // For leaves, add two-sided lighting
            if (isLeaf) {
                float backLight = max(dot(-N, sun), 0.0);
                NdLsun = max(NdLsun, backLight * 0.7);
            }
            
            // Hemispheric ambient
            float hemi = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
            vec3 ambient = mix(groundAmbientColor, skyAmbientColor, hemi) * ambientLightIntensity;
            
            // Combine lighting
            vec3 light = sunLightColor * sunLightIntensity * NdLsun + ambient;
            
            // Ensure minimum brightness for leaves
            if (isLeaf) {
                light += vec3(0.3, 0.35, 0.25); // Extra brightness for visibility
            } else {
                light += vec3(0.1, 0.1, 0.1);
            }
            
            vec3 lit = baseColor * light;
            
            // Fog
            float fogF = 1.0 - exp(-fogDensity * vDistanceToCamera);
            vec3 finalColor = mix(lit, fogColor, clamp(fogF, 0.0, 0.8));
            
            // DEBUG: Make leaves extra bright
            if (isLeaf) {
                finalColor = finalColor * 1.5;
            }
            
            gl_FragColor = vec4(finalColor, alpha);
        }
    `;
}
