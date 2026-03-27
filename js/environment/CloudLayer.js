import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.178.0/build/three.module.js';

// Simple 3D Worley/Perlin GL noise source (e.g. https://iquilezles.org/articles/texture/)
const noise3D = `
// --- Ashima 3D Simplex Noise: https://github.com/ashima/webgl-noise ---
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x*34.0)+1.0)*x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v)
{
  const vec2  C = vec2(1.0/6.0, 1.0/3.0) ;
  const vec4  D = vec4(0.0, 0.5, 1.0, 2.0);

  // First corner
  vec3 i  = floor(v + dot(v, C.yyy) );
  vec3 x0 = v - i + dot(i, C.xxx);

  // Other corners
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min( g.xyz, l.zxy );
  vec3 i2 = max( g.xyz, l.zxy );

  //   x0 = x0 - 0.0 + 0.0 * C 
  //   x1 = x0 - i1  + 1.0 * C 
  //   x2 = x0 - i2  + 2.0 * C 
  //   x3 = x0 - 1.0 + 3.0 * C 
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy; // 2.0 * C.x = 1/3 = C.y
  vec3 x3 = x0 - D.yyy;      // -1.0 + 3.0 * C.x = -0.5

  // Permutations
  i = mod289(i); 
  vec4 p = permute( permute( permute( 
             i.z + vec4(0.0, i1.z, i2.z, 1.0 ))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0 )) 
           + i.x + vec4(0.0, i1.x, i2.x, 1.0 ));

  // Gradients
  float n_ = 1.0/7.0; // N=7
  vec3  ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);   //  mod(p,7*7)

  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);    

  vec4 x = x_ *ns.x + ns.yyyy;
  vec4 y = y_ *ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4( x.xy, y.xy );
  vec4 b1 = vec4( x.zw, y.zw );

  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;

  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy ;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww ;

  vec3 g0 = vec3(a0.xy,h.x);
  vec3 g1 = vec3(a0.zw,h.y);
  vec3 g2 = vec3(a1.xy,h.z);
  vec3 g3 = vec3(a1.zw,h.w);

  vec4 norm = taylorInvSqrt(vec4(dot(g0,g0), dot(g1,g1), dot(g2,g2), dot(g3,g3)));
  g0 *= norm.x;
  g1 *= norm.y;
  g2 *= norm.z;
  g3 *= norm.w;

  float m0 = max(0.6-dot(x0,x0),0.0);
  float m1 = max(0.6-dot(x1,x1),0.0);
  float m2 = max(0.6-dot(x2,x2),0.0);
  float m3 = max(0.6-dot(x3,x3),0.0);
  return 42.0 * ( m0*m0*dot(g0,x0) + m1*m1*dot(g1,x1) + m2*m2*dot(g2,x2) + m3*m3*dot(g3,x3) );
}
`;

const cloudParamsByType = {
  cirrus: {
    scale: 1.5, height: 4000, thickness: 1500, density: 0.12, softness: 0.18, speed: 0.011, color: new THREE.Color(0xf8f9ff)
  },
  altocumulus: {
    scale: 1.1, height: 2500, thickness: 800, density: 0.34, softness: 0.30, speed: 0.004, color: new THREE.Color(0xfcfdfb)
  },
  altostratus: {
    scale: 0.73, height: 2000, thickness: 1200, density: 0.33, softness: 0.35, speed: 0.003, color: new THREE.Color(0xf3f6ff)
  },
  stratocumulus: {
    scale: 0.5, height: 800, thickness: 600, density: 0.46, softness: 0.3, speed: 0.004, color: new THREE.Color(0xf0f1f5)
  },
  cumulus: {
    scale: 0.22, height: 500, thickness: 800, density: 0.58, softness: 0.23, speed: 0.007, color: new THREE.Color(0xf8fafb)
  },
  nimbostratus: {
    scale: 0.5, height: 300, thickness: 1000, density: 0.92, softness: 0.45, speed: 0.001, color: new THREE.Color(0xf0f2f4)
  }
};

// GLSL for cloud raymarch (simple version for prototyping)

const cloudFragmentShader = `
uniform vec3 sunDir;
uniform float globalCoverage;
uniform float baseHeight, thickness, scale, density, softness, time;
uniform vec3 cloudColor;
varying vec3 vWorldPosition;

${noise3D}

float worleyFBM(vec3 p) {
    float f = 0.0;
    float amp = 1.0, freq = 1.0;
    for (int i = 0; i < 4; i++) {
        f += snoise(p * freq) * amp;
        freq *= 2.3;
        amp *= 0.55;
    }
    return smoothstep(0.23, 0.81, f * 0.65 + 0.5); // adjust for softness
}

void main() {
    vec3 world = vWorldPosition;
    // Project world.y to sky layer (height above ground)
    vec3 snoiseInput = vec3(world.xz * 0.00012, time * 0.02);
    float cldLayer = baseHeight + snoise(snoiseInput) * 120.0;

    float h = clamp(world.y - cldLayer, 0.0, thickness);
    float fade = 1.0 - exp(-h * 0.003);
    

    // UVs for clouds
    vec3 cloudP = world * scale * 0.00009 + vec3(0, time * 0.08, time * 0.06);
    float cloudFbm = worleyFBM(cloudP);
    float densityVal = clamp((cloudFbm * density * globalCoverage) - softness, 0.0, 1.0);

    // Lighting (soft backscatter fudge)
    float sunDot = clamp(dot(sunDir, normalize(world)), 0.0, 1.0);
    float highlight = pow(sunDot, 6.0) * 0.45;

    // Alpha based on density and fade, with softness (-> transparent edges)
    float alpha = fade * densityVal * 0.97;

    // Color blend: ambient+sun highlight
    vec3 outColor = mix(cloudColor * 1.05, vec3(1.0), highlight);
 //   gl_FragColor = vec4(outColor, alpha);
gl_FragColor = vec4(outColor, 1.0);
 gl_FragColor = vec4(vec3(cloudFbm), alpha); //THIS SHOWS PROPERLY
}
`;

const CLOUD_GEOMETRY = new THREE.SphereGeometry(6000, 64, 16);

export class CloudLayer extends THREE.Mesh {
    constructor(typeName = 'cumulus', weatherMultiplier = 1.0) {
        // Use large sphere geometry but push slightly above sky sphere
        super(CLOUD_GEOMETRY, undefined);
        this.type = typeName;
        this.visible = true;
        this.setCloudType(typeName, weatherMultiplier);
        this.frustumCulled = false;
        const params = cloudParamsByType[typeName];

        this.renderOrder = -params.height; // Negative so higher altitude renders first
    }
    setCloudType(typeName, weatherMultiplier = 1.0) {
        const params = { ...cloudParamsByType[typeName] };
        this.params = params;
        this.material = new THREE.ShaderMaterial({
            uniforms: {
                sunDir: { value: new THREE.Vector3(1,1,0).normalize() },
                globalCoverage: { value: weatherMultiplier },
                baseHeight: { value: params.height },
                thickness: { value: params.thickness },
                scale: { value: params.scale },
                density: { value: params.density },
                softness: { value: params.softness },
                time: { value: 0 },
                cloudColor: { value: params.color.clone() }
            },
            side: THREE.DoubleSide,
            vertexShader: `
                varying vec3 vWorldPosition;
                void main() {
                    vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: cloudFragmentShader,
            transparent: true,
            depthWrite: false,
        });
    }
    setWeatherMultiplier(multiplier) {
      //
        this.material.uniforms.globalCoverage.value = multiplier;
    }
    setSunDir(vec3) {
        this.material.uniforms.sunDir.value.copy(vec3);
    }
    update(time) {
        this.material.uniforms.time.value = time;

        
    }
}