// js/config/textures/reusable/rockTextures.js

export const ROCK_MICRO_A = [
  { type: 'fbm',    octaves: 5, frequency: 0.028, color: '#4a4f55', opacity: 1.0, seed: 30301 },
  { type: 'ridged', octaves: 3, frequency: 0.058, amplitude: 0.95, color: '#2b2f34', opacity: 0.26, blendMode: 'multiply', seed: 30311 },
  { type: 'perlin', octaves: 2, frequency: 0.070, amplitude: 0.35, color: '#5b554a', opacity: 0.08, blendMode: 'multiply', filter: 'blur', filterStrength: 1.3, seed: 30321 },
  { type: 'grain',  octaves: 1, frequency: 0.82, amplitude: 1.0,  color: '#101214', opacity: 0.12, blendMode: 'overlay', seed: 30331 }
];

export const ROCK_MICRO_B = [
  { type: 'fbm',    octaves: 5, frequency: 0.032, color: '#454a50', opacity: 1.0, seed: 30302 },
  { type: 'voronoi',octaves: 1, frequency: 0.060, amplitude: 1.0, cellScale: 1.40, cellRandomness: 0.92,
    color: '#2c3035', opacity: 0.18, blendMode: 'multiply', seed: 30312 },
  { type: 'ridged', octaves: 2, frequency: 0.050, amplitude: 1.00, color: '#23262b', opacity: 0.22, blendMode: 'multiply', seed: 30322 },
  { type: 'grain',  octaves: 1, frequency: 0.85, amplitude: 1.0,  color: '#0e1012', opacity: 0.13, blendMode: 'overlay', seed: 30332 }
];

export const ROCK_MACRO = [
  { type: 'fbm', octaves: 7, frequency: 0.006, color: '#6b6b6b', opacity: 1, seed: 14002 }
];
