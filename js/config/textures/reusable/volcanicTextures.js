// js/config/textures/reusable/volcanicTextures.js

export const VOLCANIC_MICRO_A = [
  { type: 'fill', color: '#2a2524', opacity: 1.0 },
  { type: 'turbulence', octaves: 4, frequency: 0.02, turbulencePower: 2.2, domainWarp: true, warpStrength: 0.6, warpFrequency: 0.03, color: '#0f0d0c', opacity: 0.36, blendMode: 'multiply', seed: 23001 },
  { type: 'ridged', octaves: 3, frequency: 0.11, ridgeOffset: 0.62, color: '#5a2a22', opacity: 0.10, blendMode: 'overlay', seed: 23002 }
];

export const VOLCANIC_MICRO_B = [
  { type: 'fill', color: '#24201f', opacity: 1.0 },
  { type: 'fbm', octaves: 5, frequency: 0.06, persistence: 0.6, color: '#090807', opacity: 0.34, blendMode: 'multiply', seed: 23011 },
  { type: 'voronoi', frequency: 0.18, cellRandomness: 0.95, color: '#4a1f18', opacity: 0.08, blendMode: 'screen', seed: 23012 }
];

export const VOLCANIC_MACRO = [
  { type: 'fbm', octaves: 6, frequency: 0.0028, persistence: 0.62, domainWarp: true, warpStrength: 0.9, warpFrequency: 0.016, color: '#2a2524', opacity: 1, seed: 23021 }
];
