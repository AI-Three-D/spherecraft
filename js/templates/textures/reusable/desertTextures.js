// js/config/textures/reusable/desertTextures.js

export const DESERT_DRY_A = [
  { type: 'fill', color: '#c8b07a', opacity: 1.0 },
  { type: 'fbm', octaves: 4, frequency: 0.065, persistence: 0.56, color: '#b79a63', opacity: 0.40, blendMode: 'multiply', seed: 18101 },
  { type: 'perlin', octaves: 2, frequency: 0.16, amplitude: 0.28, color: '#dcc896', opacity: 0.16, blendMode: 'overlay', filter: 'blur', filterStrength: 1.6, seed: 18111 },
  { type: 'grain', amplitude: 2.1, color: '#FFFFFF', opacity: 0.04, blendMode: 'overlay', seed: 18121 },
  { type: 'grain', amplitude: 2.1, color: '#000000', opacity: 0.05, blendMode: 'overlay', seed: 18122 }
];

export const DESERT_DRY_B = [
  { type: 'fill', color: '#c4ab73', opacity: 1.0 },
  { type: 'fbm', octaves: 4, frequency: 0.072, persistence: 0.56, color: '#b2945d', opacity: 0.38, blendMode: 'multiply', seed: 18102 },
  { type: 'perlin', octaves: 2, frequency: 0.14, amplitude: 0.30, color: '#d8c18a', opacity: 0.17, blendMode: 'overlay', filter: 'blur', filterStrength: 1.5, seed: 18112 },
  { type: 'grain', amplitude: 2.0, color: '#FFFFFF', opacity: 0.04, blendMode: 'overlay', seed: 18123 },
  { type: 'grain', amplitude: 2.0, color: '#000000', opacity: 0.05, blendMode: 'overlay', seed: 18124 }
];

export const DESERT_SEMI_ARID_A = [
  { type: 'fill', color: '#b89f6e', opacity: 1.0 },
  { type: 'fbm', octaves: 4, frequency: 0.060, persistence: 0.58, color: '#9c8457', opacity: 0.42, blendMode: 'multiply', seed: 18201 },
  { type: 'perlin', octaves: 2, frequency: 0.12, amplitude: 0.30, color: '#ccb88a', opacity: 0.16, blendMode: 'overlay', filter: 'blur', filterStrength: 1.6, seed: 18211 },
  { type: 'grain', amplitude: 2.0, color: '#FFFFFF', opacity: 0.04, blendMode: 'overlay', seed: 18221 },
  { type: 'grain', amplitude: 2.0, color: '#000000', opacity: 0.05, blendMode: 'overlay', seed: 18222 }
];

export const DESERT_SEMI_ARID_B = [
  { type: 'fill', color: '#b29563', opacity: 1.0 },
  { type: 'fbm', octaves: 4, frequency: 0.068, persistence: 0.58, color: '#987f52', opacity: 0.40, blendMode: 'multiply', seed: 18202 },
  { type: 'perlin', octaves: 2, frequency: 0.14, amplitude: 0.28, color: '#c9b381', opacity: 0.15, blendMode: 'overlay', filter: 'blur', filterStrength: 1.5, seed: 18212 },
  { type: 'grain', amplitude: 2.0, color: '#FFFFFF', opacity: 0.04, blendMode: 'overlay', seed: 18223 },
  { type: 'grain', amplitude: 2.0, color: '#000000', opacity: 0.05, blendMode: 'overlay', seed: 18224 }
];

export const DESERT_TREES_DRY_A = [
  { type: 'fill', color: '#bfa36d', opacity: 1.0 },
  { type: 'fbm', octaves: 4, frequency: 0.060, persistence: 0.58, color: '#a88f5f', opacity: 0.40, blendMode: 'multiply', seed: 18301 },
  { type: 'perlin', octaves: 2, frequency: 0.20, amplitude: 0.22, color: '#6b6a3f', opacity: 0.12, blendMode: 'multiply', filter: 'blur', filterStrength: 1.8, seed: 18311 },
  { type: 'grain', amplitude: 2.0, color: '#FFFFFF', opacity: 0.04, blendMode: 'overlay', seed: 18321 },
  { type: 'grain', amplitude: 2.0, color: '#000000', opacity: 0.05, blendMode: 'overlay', seed: 18322 }
];

export const DESERT_TREES_DRY_B = [
  { type: 'fill', color: '#b99c66', opacity: 1.0 },
  { type: 'fbm', octaves: 4, frequency: 0.068, persistence: 0.58, color: '#a18658', opacity: 0.38, blendMode: 'multiply', seed: 18302 },
  { type: 'perlin', octaves: 2, frequency: 0.18, amplitude: 0.24, color: '#66653c', opacity: 0.12, blendMode: 'multiply', filter: 'blur', filterStrength: 1.7, seed: 18312 },
  { type: 'grain', amplitude: 2.0, color: '#FFFFFF', opacity: 0.04, blendMode: 'overlay', seed: 18323 },
  { type: 'grain', amplitude: 2.0, color: '#000000', opacity: 0.05, blendMode: 'overlay', seed: 18324 }
];

export const DESERT_TREES_SEMI_ARID_A = [
  { type: 'fill', color: '#a88b5e', opacity: 1.0 },
  { type: 'fbm', octaves: 4, frequency: 0.060, persistence: 0.58, color: '#8f764f', opacity: 0.42, blendMode: 'multiply', seed: 18401 },
  { type: 'perlin', octaves: 2, frequency: 0.18, amplitude: 0.24, color: '#6c6e44', opacity: 0.13, blendMode: 'multiply', filter: 'blur', filterStrength: 1.8, seed: 18411 },
  { type: 'grain', amplitude: 2.0, color: '#FFFFFF', opacity: 0.04, blendMode: 'overlay', seed: 18421 },
  { type: 'grain', amplitude: 2.0, color: '#000000', opacity: 0.05, blendMode: 'overlay', seed: 18422 }
];

export const DESERT_TREES_SEMI_ARID_B = [
  { type: 'fill', color: '#a28558', opacity: 1.0 },
  { type: 'fbm', octaves: 4, frequency: 0.068, persistence: 0.58, color: '#8a724a', opacity: 0.40, blendMode: 'multiply', seed: 18402 },
  { type: 'perlin', octaves: 2, frequency: 0.16, amplitude: 0.24, color: '#6a6c43', opacity: 0.13, blendMode: 'multiply', filter: 'blur', filterStrength: 1.7, seed: 18412 },
  { type: 'grain', amplitude: 2.0, color: '#FFFFFF', opacity: 0.04, blendMode: 'overlay', seed: 18423 },
  { type: 'grain', amplitude: 2.0, color: '#000000', opacity: 0.05, blendMode: 'overlay', seed: 18424 }
];

export const DESERT_MACRO = [
  { type: 'fbm', octaves: 4, frequency: 0.0020, persistence: 0.56, domainWarp: true, warpStrength: 0.9, warpFrequency: 0.011, color: '#d8c08a', opacity: 1, seed: 18501 },
  { type: 'perlin', octaves: 2, frequency: 0.0032, amplitude: 0.35, color: '#f0ddb0', opacity: 0.10, blendMode: 'overlay', filter: 'blur', filterStrength: 6.0, seed: 18511 }
];
