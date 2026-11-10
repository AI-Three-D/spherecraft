// js/config/textures/reusable/grassTextures.js

export const GRASS_SHORT_A = [
  { type: 'fbm', octaves: 2, frequency: 4.115, amplitude: 1.0, color: '#305520', opacity: 1.0, seed: 1101 },
  {
    type: 'perlin',
    octaves: 3,
    frequency: 0.195,
    amplitude: 0.14,
    color: '#47672b',
    opacity: 0.45,
    blendMode: 'multiply',
    filter: 'blur',
    filterStrength: 4.7,
    seed: 40111
  },
  {
    type: 'fbm',
    octaves: 2,
    frequency: 0.150,
    amplitude: 0.18,
    color: '#706b3f',
    opacity: 0.45,
    blendMode: 'multiply',
    filter: 'blur',
    filterStrength: 5.0,
    seed: 40121
  },
  { type: 'grain', amplitude: 2.2, color: '#FFFFFF', opacity: 0.05, blendMode: 'overlay', seed: 18031 },
  { type: 'grain', amplitude: 2.2, color: '#000000', opacity: 0.05, blendMode: 'overlay', seed: 2983 }
];

export const GRASS_SHORT_B = [
  { type: 'fbm', octaves: 2, frequency: 5.115, amplitude: 1.0, color: '#305420', opacity: 1.0, seed: 4101 },
  {
    type: 'perlin',
    octaves: 3,
    frequency: 0.195,
    amplitude: 0.14,
    color: '#47672b',
    opacity: 0.45,
    blendMode: 'multiply',
    filter: 'blur',
    filterStrength: 4.7,
    seed: 40111
  },
  {
    type: 'fbm',
    octaves: 2,
    frequency: 0.150,
    amplitude: 0.18,
    color: '#706b3f',
    opacity: 0.45,
    blendMode: 'multiply',
    filter: 'blur',
    filterStrength: 5.0,
    seed: 40121
  }
];

// Slightly darker + slightly different (non-repeating) patterning.
// Keeps the same “feel”, but shifts base/overlay tones down and nudges freqs/rotation/seeds.
export const GRASS_MEDIUM_A = [
  {
    type: 'fbm',
    octaves: 2,
    frequency: 4.42,
    amplitude: 1.0,
    color: '#294918',
    opacity: 1.0,
    seed: 1129
  },
  {
    type: 'perlin',
    octaves: 3,
    frequency: 0.223,
    amplitude: 0.135,
    color: '#3c5a22',
    opacity: 0.46,
    blendMode: 'multiply',
    rotation: 17,
    domainWarp: true,
    warpStrength: 0.16,
    warpFrequency: 0.045,
    filter: 'blur',
    filterStrength: 4.9,
    seed: 40183
  },
  {
    type: 'fbm',
    octaves: 2,
    frequency: 0.118,
    amplitude: 0.16,
    color: '#2a3323',
    opacity: 0.22,
    blendMode: 'multiply',
    filter: 'blur',
    filterStrength: 6.2,
    seed: 40217
  },
  {
    type: 'fbm',
    octaves: 2,
    frequency: 0.162,
    amplitude: 0.17,
    color: '#5e5832',
    opacity: 0.40,
    blendMode: 'multiply',
    filter: 'blur',
    filterStrength: 5.2,
    seed: 40149
  },
  { type: 'grain', amplitude: 2.15, color: '#FFFFFF', opacity: 0.045, blendMode: 'overlay', seed: 18097 },
  { type: 'grain', amplitude: 2.15, color: '#000000', opacity: 0.055, blendMode: 'overlay', seed: 3119 }
];

export const GRASS_MEDIUM_B = [
  {
    type: 'fbm',
    octaves: 2,
    frequency: 5.62,
    amplitude: 1.0,
    color:  '#284717',
    opacity: 1.0,
    seed: 4177
  },
  {
    type: 'perlin',
    octaves: 3,
    frequency: 0.187,
    amplitude: 0.145,
    color: '#3a5721',
    opacity: 0.44,
    blendMode: 'multiply',
    rotation: -11,
    domainWarp: true,
    warpStrength: 0.12,
    warpFrequency: 0.058,
    filter: 'blur',
    filterStrength: 4.6,
    seed: 40291
  },
  {
    type: 'cells',
    cellScale: 0.72,
    cellRandomness: 0.92,
    cellElongation: 0.62,
    cellStretch: [1.25, 0.85],
    frequency: 0.042,
    amplitude: 0.12,
    color: '#31441f',
    opacity: 0.18,
    blendMode: 'multiply',
    filter: 'blur',
    filterStrength: 6.6,
    seed: 40333
  },
  {
    type: 'fbm',
    octaves: 2,
    frequency: 0.141,
    amplitude: 0.165,
    color: '#5b5530',
    opacity: 0.38,
    blendMode: 'multiply',
    filter: 'blur',
    filterStrength: 5.4,
    seed: 40177
  },
  { type: 'grain', amplitude: 2.05, color: '#FFFFFF', opacity: 0.04, blendMode: 'overlay', seed: 18141 },
  { type: 'grain', amplitude: 2.05, color: '#000000', opacity: 0.055, blendMode: 'overlay', seed: 2999 }
];

// Meadow: lighter, softer, slightly warmer.
// Same idea as flower field: swap the *base* greens into the mid-range between '#284717' and '#305520'.
// midpoint ≈ '#2C4E1C'
// Same idea as flower field: swap the *base* greens into the mid-range between '#284717' and '#305520'.
// midpoint ≈ '#2C4E1C'


// Taller grass: slightly darker + richer contrast.

// Darker + slightly varied (non-repeating) tall grass pair.
// A and B keep the same “recipe”, but differ in freqs/rotations/warp + seeds so they don’t echo.

// Mid-tone between '#284717' (40,71,23) and '#305520' (48,85,32) ≈ '#2C4E1C' (44,78,28)

export const GRASS_TALL_A = [
  {
    type: 'fbm',
    octaves: 2,
    frequency: 5.88,
    amplitude: 1.0,
    color: '#2C4E1C',     // mid between the two
    opacity: 1.0,
    seed: 4289
  },
  {
    type: 'perlin',
    octaves: 3,
    frequency: 0.173,
    amplitude: 0.14,
    color: '#365323',     // slightly darker than original overlay, not too dark
    opacity: 0.46,
    blendMode: 'multiply',
    rotation: -7,
    domainWarp: true,
    warpStrength: 0.14,
    warpFrequency: 0.064,
    filter: 'blur',
    filterStrength: 4.8,
    seed: 40407
  },
  {
    type: 'cells',
    cellScale: 0.78,
    cellRandomness: 0.90,
    cellElongation: 0.66,
    cellStretch: [1.18, 0.88],
    frequency: 0.039,
    amplitude: 0.13,
    color: '#2C3F1C',     // gentle deepen, still close to original
    opacity: 0.20,
    blendMode: 'multiply',
    filter: 'blur',
    filterStrength: 6.9,
    seed: 40511
  },
  {
    type: 'fbm',
    octaves: 2,
    frequency: 0.128,
    amplitude: 0.155,
    color: '#57512D',     // slightly darkened warmth wash, but not heavy
    opacity: 0.36,
    blendMode: 'multiply',
    filter: 'blur',
    filterStrength: 5.7,
    seed: 40219
  },
  { type: 'grain', amplitude: 2.0, color: '#FFFFFF', opacity: 0.038, blendMode: 'overlay', seed: 18213 },
  { type: 'grain', amplitude: 2.0, color: '#000000', opacity: 0.060, blendMode: 'overlay', seed: 3083 }
];

export const GRASS_TALL_B = [
  {
    type: 'fbm',
    octaves: 2,
    frequency: 5.73,
    amplitude: 1.0,
    color: '#2C4E1C',     // same mid base, different patterning via params/seeds
    opacity: 1.0,
    seed: 4399
  },
  {
    type: 'perlin',
    octaves: 3,
    frequency: 0.201,
    amplitude: 0.138,
    color: '#365223',
    opacity: 0.44,
    blendMode: 'multiply',
    rotation: -15,
    domainWarp: true,
    warpStrength: 0.11,
    warpFrequency: 0.052,
    filter: 'blur',
    filterStrength: 4.5,
    seed: 40631
  },
  {
    type: 'cells',
    cellScale: 0.70,
    cellRandomness: 0.94,
    cellElongation: 0.60,
    cellStretch: [1.30, 0.82],
    frequency: 0.046,
    amplitude: 0.115,
    color: '#2B3E1C',
    opacity: 0.19,
    blendMode: 'multiply',
    filter: 'blur',
    filterStrength: 6.4,
    seed: 40717
  },
  {
    type: 'fbm',
    octaves: 2,
    frequency: 0.149,
    amplitude: 0.150,
    color: '#56502C',
    opacity: 0.34,
    blendMode: 'multiply',
    filter: 'blur',
    filterStrength: 5.2,
    seed: 40307
  },
  { type: 'grain', amplitude: 2.05, color: '#FFFFFF', opacity: 0.036, blendMode: 'overlay', seed: 18301 },
  { type: 'grain', amplitude: 2.05, color: '#000000', opacity: 0.058, blendMode: 'overlay', seed: 3197 }
];
// Flower field: slightly lighter + warm hints.
// Replacing the '#FF00FF' base with a mid-tone in the range between '#284717' and '#305520':
// midpoint ≈ '#2C4E1C'

export const GRASS_FLOWER_FIELD_A = [
  // { type: 'fbm', octaves: 2, frequency: 4.18, amplitude: 1.0, color: '#376324', opacity: 1.0, seed: 1181 },
  { type: 'fbm', octaves: 2, frequency: 4.05, amplitude: 1.0, color: '#2C4E1C', opacity: 1.0, seed: 1151 },
  {
    type: 'perlin',
    octaves: 3,
    frequency: 0.210,
    amplitude: 0.13,
    color: '#507a2f',
    opacity: 0.40,
    blendMode: 'multiply',
    filter: 'blur',
    filterStrength: 4.8,
    seed: 40133
  },
  {
    type: 'fbm',
    octaves: 2,
    frequency: 0.145,
    amplitude: 0.16,
    color: '#8f6a3e',
    opacity: 0.14,
    blendMode: 'overlay',
    filter: 'blur',
    filterStrength: 5.4,
    seed: 40157
  },
  {
    type: 'cells',
    cellScale: 1.25,
    cellRandomness: 0.95,
    frequency: 0.055,
    amplitude: 0.12,
    color: '#c96a6a',
    opacity: 0.10,
    blendMode: 'screen',
    seed: 40191
  },
  { type: 'grain', amplitude: 2.1, color: '#FFFFFF', opacity: 0.05, blendMode: 'overlay', seed: 18061 },
  { type: 'grain', amplitude: 2.1, color: '#000000', opacity: 0.045, blendMode: 'overlay', seed: 2971 }
];

export const GRASS_FLOWER_FIELD_B = [
  // { type: 'fbm', octaves: 2, frequency: 5.00, amplitude: 1.0, color: '#356123', opacity: 1.0, seed: 4211 },
  { type: 'fbm', octaves: 2, frequency: 4.05, amplitude: 1.0, color: '#2C4E1C', opacity: 1.0, seed: 1151 },
  {
    type: 'perlin',
    octaves: 3,
    frequency: 0.185,
    amplitude: 0.14,
    color: '#4f742c',
    opacity: 0.38,
    blendMode: 'multiply',
    rotation: 12,
    domainWarp: true,
    warpStrength: 0.10,
    warpFrequency: 0.052,
    filter: 'blur',
    filterStrength: 4.7,
    seed: 40203
  },
  {
    type: 'fbm',
    octaves: 2,
    frequency: 0.130,
    amplitude: 0.14,
    color: '#a07a45',
    opacity: 0.12,
    blendMode: 'overlay',
    filter: 'blur',
    filterStrength: 5.0,
    seed: 40231
  },
  {
    type: 'cells',
    cellScale: 1.15,
    cellRandomness: 0.92,
    frequency: 0.050,
    amplitude: 0.10,
    color: '#d38a6e',
    opacity: 0.08,
    blendMode: 'screen',
    seed: 40263
  },
  { type: 'grain', amplitude: 2.0, color: '#FFFFFF', opacity: 0.05, blendMode: 'overlay', seed: 18071 },
  { type: 'grain', amplitude: 2.0, color: '#000000', opacity: 0.045, blendMode: 'overlay', seed: 2961 }
];

export const GRASS_MACRO = [
  {
    type: 'fbm',
    octaves: 5,
    frequency: 0.0030,
    amplitude: 1.0,
    persistence: 0.58,
    domainWarp: true,
    warpStrength: 1.15,
    warpFrequency: 0.012,
    rotation: 19,
    color: '#3f6e18',
    opacity: 1.0,
    seed: 14001
  },
  {
    type: 'voronoi',
    frequency: 0.0022,
    cellScale: 1.65,
    cellRandomness: 0.92,
    rotation: -13,
    color: '#7ea834',
    opacity: 0.13,
    blendMode: 'overlay',
    seed: 14011
  },
  {
    type: 'turbulence',
    octaves: 3,
    frequency: 0.009,
    amplitude: 1.0,
    persistence: 0.52,
    turbulencePower: 1.9,
    domainWarp: true,
    warpStrength: 0.55,
    warpFrequency: 0.020,
    rotation: 9,
    color: '#2d4a12',
    opacity: 0.12,
    blendMode: 'multiply',
    seed: 14021
  }
];
