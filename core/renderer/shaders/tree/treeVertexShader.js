/**
 * Build vertex shader for tree rendering
 * @param {boolean} isInstanced - Whether to use instancing
 * @returns {string} Vertex shader code
 */
export function buildTreeVertexShader(isInstanced = true) {
    return `
        ${isInstanced ? '#define USE_INSTANCING' : ''}

        varying vec2 vUv;
        varying vec3 vNormal;
        varying vec3 vWorldPosition;
        varying float vDistanceToCamera;
        varying vec3 vViewPosition;
        varying vec3 vColor;
        
        void main() {
            vUv = uv;
            vColor = color;  // Pass to fragment shader
            
            // Transform normal
            #ifdef USE_INSTANCING
                mat3 normalMatrix = mat3(transpose(inverse(modelMatrix * instanceMatrix)));
                vNormal = normalize(normalMatrix * normal);
                vec4 worldPos = modelMatrix * instanceMatrix * vec4(position, 1.0);
            #else
                vNormal = normalize(normalMatrix * normal);
                vec4 worldPos = modelMatrix * vec4(position, 1.0);
            #endif
            
            vWorldPosition = worldPos.xyz;
            vDistanceToCamera = length(cameraPosition - worldPos.xyz);
            
            vec4 viewPos = viewMatrix * worldPos;
            vViewPosition = viewPos.xyz;
            
            gl_Position = projectionMatrix * viewPos;
        }
    `;
}
