// js/config/textures/reusable/mudTextures.js

export const MUD_MICRO_A = [
  { type: 'fbm',    octaves: 5, frequency: 0.032, color: '#00FF00', opacity: 1.0, seed: 30101 },
  { type: 'ridged', octaves: 3, frequency: 0.060, amplitude: 0.85, color: '#171312', opacity: 0.28, blendMode: 'multiply', seed: 30111 },
  { type: 'perlin', octaves: 2, frequency: 0.090, amplitude: 0.35, color: '#3a3230', opacity: 0.14, blendMode: 'overlay', filter: 'blur', filterStrength: 1.2, seed: 30121 },
  { type: 'grain',  octaves: 1, frequency: 0.76, amplitude: 1.0,  color: '#0f0d0c', opacity: 0.12, blendMode: 'overlay', seed: 30131 }
];

export const MUD_MICRO_B = [
  { type: 'fbm',    octaves: 5, frequency: 0.036, color: '#312826', opacity: 1.0, seed: 30102 },
  { type: 'ridged', octaves: 3, frequency: 0.065, amplitude: 0.90, color: '#141111', opacity: 0.30, blendMode: 'multiply', seed: 30112 },
  { type: 'perlin', octaves: 2, frequency: 0.082, amplitude: 0.38, color: '#3f3735', opacity: 0.13, blendMode: 'overlay', filter: 'blur', filterStrength: 1.1, seed: 30122 },
  { type: 'grain',  octaves: 1, frequency: 0.80, amplitude: 1.0,  color: '#0d0c0b', opacity: 0.13, blendMode: 'overlay', seed: 30132 }
];

export const MUD_MACRO = [
  { type: 'fbm', octaves: 5, frequency: 0.0026, persistence: 0.6, domainWarp: true, warpStrength: 1.0, warpFrequency: 0.014, color: '#3a2e27', opacity: 1, seed: 22021 }
];
