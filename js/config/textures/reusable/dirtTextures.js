// js/config/textures/reusable/dirtTextures.js

export const DIRT_MICRO_A = [
  { type: 'fbm',    octaves: 5, frequency: 0.030, color: '#ff0000', opacity: 1.0, seed: 30201 },
  { type: 'perlin', octaves: 2, frequency: 0.095, amplitude: 0.28, color: '#5a4633', opacity: 0.18, blendMode: 'multiply', filter: 'blur', filterStrength: 1.0, seed: 30211 },
  { type: 'cells',  octaves: 1, frequency: 0.090, amplitude: 1.0, cellScale: 1.25, cellRandomness: 0.88,
    color: '#3a2d23', opacity: 0.16, blendMode: 'multiply', seed: 30221 },
  { type: 'grain',  octaves: 1, frequency: 0.72, amplitude: 1.0,  color: '#15110d', opacity: 0.10, blendMode: 'overlay', seed: 30231 }
];

export const DIRT_MICRO_B = [
  { type: 'fbm',    octaves: 5, frequency: 0.034, color: '#443528', opacity: 1.0, seed: 30202 },
  { type: 'perlin', octaves: 2, frequency: 0.088, amplitude: 0.30, color: '#5b4632', opacity: 0.16, blendMode: 'multiply', filter: 'blur', filterStrength: 1.1, seed: 30212 },
  { type: 'voronoi',octaves: 1, frequency: 0.075, amplitude: 1.0, cellScale: 1.35, cellRandomness: 0.90,
    color: '#3b2d22', opacity: 0.14, blendMode: 'multiply', seed: 30222 },
  { type: 'grain',  octaves: 1, frequency: 0.75, amplitude: 1.0,  color: '#14100c', opacity: 0.11, blendMode: 'overlay', seed: 30232 }
];

export const DIRT_MACRO = [
  { type: 'fbm', octaves: 5, frequency: 0.0024, persistence: 0.58, domainWarp: true, warpStrength: 0.85, warpFrequency: 0.013, color: '#5c402a', opacity: 1, seed: 20021 }
];
