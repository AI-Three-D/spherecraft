// js/config/textures/reusable/swampTextures.js

export const SWAMP_MICRO_A = [
  { type: 'fill', color: '#2f4a3c', opacity: 1.0 },
  { type: 'fbm', octaves: 5, frequency: 0.05, persistence: 0.6, color: '#ffff00', opacity: 0.30, blendMode: 'multiply', seed: 19001 },
  { type: 'ridged', octaves: 2, frequency: 0.10, ridgeOffset: 0.62, color: '#4f6a5c', opacity: 0.16, blendMode: 'overlay', seed: 19002 }
];

export const SWAMP_MICRO_B = [
  { type: 'fill', color: '#2b4537', opacity: 1.0 },
  { type: 'turbulence', octaves: 3, frequency: 0.021, turbulencePower: 2.0, color: '#112019', opacity: 0.28, blendMode: 'multiply', seed: 19011 },
  { type: 'perlin', octaves: 2, frequency: 0.14, amplitude: 0.7, color: '#5f8272', opacity: 0.12, blendMode: 'screen', seed: 19012 }
];

export const SWAMP_MACRO = [
  { type: 'fbm', octaves: 5, frequency: 0.0022, persistence: 0.6, domainWarp: true, warpStrength: 1.1, warpFrequency: 0.014, color: '#2f4a3c', opacity: 1, seed: 19021 }
];
