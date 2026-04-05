// js/config/textures/reusable/waterTextures.js

export const WATER_MICRO_A = [
  { type: 'fbm', octaves: 4, frequency: 0.08, color: '#5ba3a8', opacity: 1, seed: 40001 },
  { type: 'ridged', octaves: 3, frequency: 0.15, color: '#4a8c91', ridgeOffset: 0.5, opacity: 0.4, blendMode: 'multiply', seed: 40002 },
  { type: 'perlin', octaves: 2, frequency: 0.12, color: '#7dc4c9', opacity: 0.3, blendMode: 'screen', seed: 40003 }
];

export const WATER_MACRO = [
  { type: 'fbm', octaves: 6, frequency: 0.01, color: '#3a7d87', opacity: 1, seed: 40301 },
  { type: 'perlin', octaves: 3, frequency: 0.015, color: '#2a5d67', opacity: 0.5, blendMode: 'multiply', seed: 40302 }
];
