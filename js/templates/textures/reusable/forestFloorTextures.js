// js/config/textures/reusable/forestFloorTextures.js
// Goals:
// - No obvious repeating features (avoid sharp cells/ridged signatures)
// - Tile-friendly (use blurred low-contrast layers, slightly different freqs/rotations/seeds)
// - Color range closer to the grass tone band (#284717..#305520) with some grey/brown warmth,
//   but pulled greener overall.

export const FOREST_DENSE_SINGLE_A = [
  // greenish soil base (kept in your target band neighborhood)
  { type: 'fbm', octaves: 2, frequency: 4.55, amplitude: 1.0, color: '#294A1B', opacity: 1.0, seed: 71001 },

  // soft damp mottle (main breakup) — blurred + multiply
  { type: 'perlin', octaves: 3, frequency: 0.205, amplitude: 0.14, color: '#3A5524', opacity: 0.42,
    blendMode: 'multiply', filter: 'blur', filterStrength: 4.8, seed: 71011 },

  // cool shadow wash (very subtle, prevents “flat” look)
  { type: 'fbm', octaves: 2, frequency: 0.135, amplitude: 0.16, color: '#222C1E', opacity: 0.20,
    blendMode: 'multiply', filter: 'blur', filterStrength: 6.0, seed: 71021 },

  // warm / brown-grey organic tint (nudged greener)
  { type: 'fbm', octaves: 2, frequency: 0.160, amplitude: 0.15, color: '#5A563B', opacity: 0.22,
    blendMode: 'multiply', filter: 'blur', filterStrength: 5.4, seed: 71031 },

  // micro variation (tiny, helps kill any “banding”)
  { type: 'perlin', octaves: 2, frequency: 0.62, amplitude: 0.06, color: '#2A3E23', opacity: 0.10,
    blendMode: 'multiply', filter: 'blur', filterStrength: 1.6, seed: 71041 },

  // gentle grain (like grass)
  { type: 'grain', amplitude: 2.1, color: '#FFFFFF', opacity: 0.040, blendMode: 'overlay', seed: 71051 },
  { type: 'grain', amplitude: 2.1, color: '#000000', opacity: 0.050, blendMode: 'overlay', seed: 71061 },
];

export const FOREST_DENSE_SINGLE_B = [
  { type: 'fbm', octaves: 2, frequency: 5.05, amplitude: 1.0, color: '#2B4C1C', opacity: 1.0, seed: 72001 },

  { type: 'perlin', octaves: 3, frequency: 0.182, amplitude: 0.15, color: '#385022', opacity: 0.40,
    blendMode: 'multiply', rotation: 13, domainWarp: true, warpStrength: 0.10, warpFrequency: 0.050,
    filter: 'blur', filterStrength: 4.6, seed: 72011 },

  { type: 'fbm', octaves: 2, frequency: 0.125, amplitude: 0.16, color: '#242E20', opacity: 0.18,
    blendMode: 'multiply', filter: 'blur', filterStrength: 6.2, seed: 72021 },

  { type: 'fbm', octaves: 2, frequency: 0.148, amplitude: 0.15, color: '#5C583E', opacity: 0.20,
    blendMode: 'multiply', filter: 'blur', filterStrength: 5.2, seed: 72031 },

  { type: 'perlin', octaves: 2, frequency: 0.70, amplitude: 0.055, color: '#2A3C24', opacity: 0.10,
    blendMode: 'multiply', filter: 'blur', filterStrength: 1.5, seed: 72041 },

  { type: 'grain', amplitude: 2.05, color: '#FFFFFF', opacity: 0.038, blendMode: 'overlay', seed: 72051 },
  { type: 'grain', amplitude: 2.05, color: '#000000', opacity: 0.052, blendMode: 'overlay', seed: 72061 },
];

export const FOREST_SPARSE_SINGLE_A = [
  // a touch lighter / drier
  { type: 'fbm', octaves: 2, frequency: 4.35, amplitude: 1.0, color: '#2E5220', opacity: 1.0, seed: 73001 },

  { type: 'perlin', octaves: 3, frequency: 0.215, amplitude: 0.13, color: '#3E5A28', opacity: 0.38,
    blendMode: 'multiply', filter: 'blur', filterStrength: 4.9, seed: 73011 },

  { type: 'fbm', octaves: 2, frequency: 0.132, amplitude: 0.14, color: '#273022', opacity: 0.16,
    blendMode: 'multiply', filter: 'blur', filterStrength: 6.2, seed: 73021 },

  // warmer + slightly grey (but greener than before)
  { type: 'fbm', octaves: 2, frequency: 0.170, amplitude: 0.14, color: '#635E43', opacity: 0.18,
    blendMode: 'multiply', filter: 'blur', filterStrength: 5.4, seed: 73031 },

  { type: 'grain', amplitude: 2.05, color: '#FFFFFF', opacity: 0.036, blendMode: 'overlay', seed: 73051 },
  { type: 'grain', amplitude: 2.05, color: '#000000', opacity: 0.048, blendMode: 'overlay', seed: 73061 },
];

export const FOREST_SPARSE_SINGLE_B = [
  { type: 'fbm', octaves: 2, frequency: 4.95, amplitude: 1.0, color: '#2D5120', opacity: 1.0, seed: 74001 },

  { type: 'perlin', octaves: 3, frequency: 0.190, amplitude: 0.14, color: '#3B5525', opacity: 0.36,
    blendMode: 'multiply', rotation: -9, domainWarp: true, warpStrength: 0.09, warpFrequency: 0.052,
    filter: 'blur', filterStrength: 4.7, seed: 74011 },

  { type: 'fbm', octaves: 2, frequency: 0.120, amplitude: 0.14, color: '#263023', opacity: 0.15,
    blendMode: 'multiply', filter: 'blur', filterStrength: 6.0, seed: 74021 },

  { type: 'fbm', octaves: 2, frequency: 0.155, amplitude: 0.13, color: '#625C41', opacity: 0.17,
    blendMode: 'multiply', filter: 'blur', filterStrength: 5.1, seed: 74031 },

  { type: 'grain', amplitude: 2.0, color: '#FFFFFF', opacity: 0.035, blendMode: 'overlay', seed: 74051 },
  { type: 'grain', amplitude: 2.0, color: '#000000', opacity: 0.048, blendMode: 'overlay', seed: 74061 },
];

export const FOREST_DENSE_MIXED_A = [
  // denser / richer: slightly darker + a bit more contrast (still soft)
  { type: 'fbm', octaves: 2, frequency: 4.70, amplitude: 1.0, color: '#274717', opacity: 1.0, seed: 75001 },

  { type: 'perlin', octaves: 3, frequency: 0.200, amplitude: 0.15, color: '#355023', opacity: 0.44,
    blendMode: 'multiply', filter: 'blur', filterStrength: 4.8, seed: 75011 },

  { type: 'fbm', octaves: 2, frequency: 0.115, amplitude: 0.17, color: '#202A1E', opacity: 0.20,
    blendMode: 'multiply', filter: 'blur', filterStrength: 6.4, seed: 75021 },

  { type: 'fbm', octaves: 2, frequency: 0.145, amplitude: 0.16, color: '#5A553C', opacity: 0.22,
    blendMode: 'multiply', filter: 'blur', filterStrength: 5.3, seed: 75031 },

  { type: 'perlin', octaves: 2, frequency: 0.58, amplitude: 0.06, color: '#2A3E24', opacity: 0.11,
    blendMode: 'multiply', filter: 'blur', filterStrength: 1.7, seed: 75041 },

  { type: 'grain', amplitude: 2.1, color: '#FFFFFF', opacity: 0.040, blendMode: 'overlay', seed: 75051 },
  { type: 'grain', amplitude: 2.1, color: '#000000', opacity: 0.055, blendMode: 'overlay', seed: 75061 },
];

export const FOREST_DENSE_MIXED_B = [
  { type: 'fbm', octaves: 2, frequency: 5.25, amplitude: 1.0, color: '#284A18', opacity: 1.0, seed: 76001 },

  { type: 'perlin', octaves: 3, frequency: 0.176, amplitude: 0.155, color: '#344E22', opacity: 0.42,
    blendMode: 'multiply', rotation: 16, domainWarp: true, warpStrength: 0.11, warpFrequency: 0.048,
    filter: 'blur', filterStrength: 4.6, seed: 76011 },

  { type: 'fbm', octaves: 2, frequency: 0.108, amplitude: 0.16, color: '#212B1F', opacity: 0.18,
    blendMode: 'multiply', filter: 'blur', filterStrength: 6.6, seed: 76021 },

  { type: 'fbm', octaves: 2, frequency: 0.138, amplitude: 0.15, color: '#5E5940', opacity: 0.20,
    blendMode: 'multiply', filter: 'blur', filterStrength: 5.2, seed: 76031 },

  { type: 'perlin', octaves: 2, frequency: 0.64, amplitude: 0.055, color: '#2A3D24', opacity: 0.10,
    blendMode: 'multiply', filter: 'blur', filterStrength: 1.6, seed: 76041 },

  { type: 'grain', amplitude: 2.05, color: '#FFFFFF', opacity: 0.038, blendMode: 'overlay', seed: 76051 },
  { type: 'grain', amplitude: 2.05, color: '#000000', opacity: 0.055, blendMode: 'overlay', seed: 76061 },
];

export const FOREST_SPARSE_MIXED_A = [
  // sparse mixed: lighter, drier, a bit more warm-grey (but green-present)
  { type: 'fbm', octaves: 2, frequency: 4.25, amplitude: 1.0, color: '#2F5421', opacity: 1.0, seed: 77001 },

  { type: 'perlin', octaves: 3, frequency: 0.220, amplitude: 0.125, color: '#41602B', opacity: 0.34,
    blendMode: 'multiply', filter: 'blur', filterStrength: 4.9, seed: 77011 },

  { type: 'fbm', octaves: 2, frequency: 0.125, amplitude: 0.13, color: '#283124', opacity: 0.14,
    blendMode: 'multiply', filter: 'blur', filterStrength: 6.0, seed: 77021 },

  { type: 'fbm', octaves: 2, frequency: 0.168, amplitude: 0.13, color: '#6A6449', opacity: 0.16,
    blendMode: 'multiply', filter: 'blur', filterStrength: 5.2, seed: 77031 },

  { type: 'grain', amplitude: 2.0, color: '#FFFFFF', opacity: 0.034, blendMode: 'overlay', seed: 77051 },
  { type: 'grain', amplitude: 2.0, color: '#000000', opacity: 0.046, blendMode: 'overlay', seed: 77061 },
];

export const FOREST_SPARSE_MIXED_B = [
  { type: 'fbm', octaves: 2, frequency: 4.85, amplitude: 1.0, color: '#2E5321', opacity: 1.0, seed: 78001 },

  { type: 'perlin', octaves: 3, frequency: 0.192, amplitude: 0.135, color: '#3F5C29', opacity: 0.32,
    blendMode: 'multiply', rotation: -12, domainWarp: true, warpStrength: 0.09, warpFrequency: 0.050,
    filter: 'blur', filterStrength: 4.7, seed: 78011 },

  { type: 'fbm', octaves: 2, frequency: 0.118, amplitude: 0.13, color: '#293225', opacity: 0.13,
    blendMode: 'multiply', filter: 'blur', filterStrength: 6.1, seed: 78021 },

  { type: 'fbm', octaves: 2, frequency: 0.152, amplitude: 0.13, color: '#686249', opacity: 0.15,
    blendMode: 'multiply', filter: 'blur', filterStrength: 5.0, seed: 78031 },

  { type: 'grain', amplitude: 2.0, color: '#FFFFFF', opacity: 0.033, blendMode: 'overlay', seed: 78051 },
  { type: 'grain', amplitude: 2.0, color: '#000000', opacity: 0.046, blendMode: 'overlay', seed: 78061 },
];

export const FOREST_RAINFOREST_A = [
  // darker, wetter base with richer green
  { type: 'fbm', octaves: 2, frequency: 4.65, amplitude: 1.0, color: '#243B18', opacity: 1.0, seed: 79001 },

  // deep, soft mottle
  { type: 'perlin', octaves: 3, frequency: 0.195, amplitude: 0.16, color: '#2F4A1F', opacity: 0.48,
    blendMode: 'multiply', filter: 'blur', filterStrength: 5.1, seed: 79011 },

  // cool shadow wash
  { type: 'fbm', octaves: 2, frequency: 0.108, amplitude: 0.18, color: '#1F291E', opacity: 0.24,
    blendMode: 'multiply', filter: 'blur', filterStrength: 6.5, seed: 79021 },

  // warm organic tint (subtle)
  { type: 'fbm', octaves: 2, frequency: 0.150, amplitude: 0.16, color: '#4B5336', opacity: 0.20,
    blendMode: 'multiply', filter: 'blur', filterStrength: 5.4, seed: 79031 },

  // micro breakup
  { type: 'perlin', octaves: 2, frequency: 0.56, amplitude: 0.07, color: '#273A23', opacity: 0.12,
    blendMode: 'multiply', filter: 'blur', filterStrength: 1.8, seed: 79041 },

  { type: 'grain', amplitude: 2.1, color: '#FFFFFF', opacity: 0.040, blendMode: 'overlay', seed: 79051 },
  { type: 'grain', amplitude: 2.1, color: '#000000', opacity: 0.055, blendMode: 'overlay', seed: 79061 },
];

export const FOREST_RAINFOREST_B = [
  { type: 'fbm', octaves: 2, frequency: 5.20, amplitude: 1.0, color: '#253C19', opacity: 1.0, seed: 79501 },

  { type: 'perlin', octaves: 3, frequency: 0.178, amplitude: 0.165, color: '#2D4720', opacity: 0.46,
    blendMode: 'multiply', rotation: 14, domainWarp: true, warpStrength: 0.11, warpFrequency: 0.050,
    filter: 'blur', filterStrength: 4.9, seed: 79511 },

  { type: 'fbm', octaves: 2, frequency: 0.102, amplitude: 0.17, color: '#1E291D', opacity: 0.22,
    blendMode: 'multiply', filter: 'blur', filterStrength: 6.6, seed: 79521 },

  { type: 'fbm', octaves: 2, frequency: 0.142, amplitude: 0.15, color: '#4F5638', opacity: 0.19,
    blendMode: 'multiply', filter: 'blur', filterStrength: 5.3, seed: 79531 },

  { type: 'perlin', octaves: 2, frequency: 0.62, amplitude: 0.065, color: '#273824', opacity: 0.11,
    blendMode: 'multiply', filter: 'blur', filterStrength: 1.7, seed: 79541 },

  { type: 'grain', amplitude: 2.05, color: '#FFFFFF', opacity: 0.038, blendMode: 'overlay', seed: 79551 },
  { type: 'grain', amplitude: 2.05, color: '#000000', opacity: 0.054, blendMode: 'overlay', seed: 79561 },
];

export const FOREST_JUNGLE_A = [
  // warmer leaf-litter tone
  { type: 'fbm', octaves: 2, frequency: 4.40, amplitude: 1.0, color: '#2C451B', opacity: 1.0, seed: 80001 },

  { type: 'perlin', octaves: 3, frequency: 0.210, amplitude: 0.155, color: '#365022', opacity: 0.42,
    blendMode: 'multiply', filter: 'blur', filterStrength: 4.9, seed: 80011 },

  { type: 'fbm', octaves: 2, frequency: 0.118, amplitude: 0.16, color: '#242C1F', opacity: 0.20,
    blendMode: 'multiply', filter: 'blur', filterStrength: 6.2, seed: 80021 },

  { type: 'fbm', octaves: 2, frequency: 0.165, amplitude: 0.15, color: '#64583A', opacity: 0.22,
    blendMode: 'multiply', filter: 'blur', filterStrength: 5.2, seed: 80031 },

  { type: 'perlin', octaves: 2, frequency: 0.60, amplitude: 0.065, color: '#2B3A24', opacity: 0.11,
    blendMode: 'multiply', filter: 'blur', filterStrength: 1.7, seed: 80041 },

  { type: 'grain', amplitude: 2.0, color: '#FFFFFF', opacity: 0.038, blendMode: 'overlay', seed: 80051 },
  { type: 'grain', amplitude: 2.0, color: '#000000', opacity: 0.050, blendMode: 'overlay', seed: 80061 },
];

export const FOREST_JUNGLE_B = [
  { type: 'fbm', octaves: 2, frequency: 5.05, amplitude: 1.0, color: '#2D471C', opacity: 1.0, seed: 80501 },

  { type: 'perlin', octaves: 3, frequency: 0.185, amplitude: 0.16, color: '#344D22', opacity: 0.40,
    blendMode: 'multiply', rotation: -10, domainWarp: true, warpStrength: 0.10, warpFrequency: 0.052,
    filter: 'blur', filterStrength: 4.7, seed: 80511 },

  { type: 'fbm', octaves: 2, frequency: 0.110, amplitude: 0.16, color: '#243020', opacity: 0.18,
    blendMode: 'multiply', filter: 'blur', filterStrength: 6.3, seed: 80521 },

  { type: 'fbm', octaves: 2, frequency: 0.150, amplitude: 0.15, color: '#61583A', opacity: 0.20,
    blendMode: 'multiply', filter: 'blur', filterStrength: 5.1, seed: 80531 },

  { type: 'perlin', octaves: 2, frequency: 0.66, amplitude: 0.06, color: '#2B3A25', opacity: 0.10,
    blendMode: 'multiply', filter: 'blur', filterStrength: 1.6, seed: 80541 },

  { type: 'grain', amplitude: 2.0, color: '#FFFFFF', opacity: 0.036, blendMode: 'overlay', seed: 80551 },
  { type: 'grain', amplitude: 2.0, color: '#000000', opacity: 0.050, blendMode: 'overlay', seed: 80561 },
];

export const FOREST_FLOOR_MACRO = [
  // Macro should *not* introduce obvious blobs — keep it extremely soft and low contrast.
  { type: 'fbm', octaves: 5, frequency: 0.0024, persistence: 0.58, domainWarp: true, warpStrength: 0.85, warpFrequency: 0.012,
    color: '#2F4527', opacity: 1.0, seed: 88021 },

  { type: 'perlin', octaves: 2, frequency: 0.0045, amplitude: 0.35,
    color: '#5F5B44', opacity: 0.10, blendMode: 'multiply', filter: 'blur', filterStrength: 10.0, seed: 88031 }
];
