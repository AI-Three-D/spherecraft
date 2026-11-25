// templates/configs/weatherConfig.js
//
// Data table for runtime weather effects. WeatherController consumes this
// shape directly, so designers can tune state probabilities and visual effects
// without changing controller logic.

export const WEATHER_CONFIG = Object.freeze({
  enabled: true,
  resolution: 128,
  updateHz: 2,
  windStrength: 20.0,
  advection: 1.0,
  diffusion: 0.15,
  precipitationRate: 0.6,
  evaporation: 0.2,
  noiseScale: 2.0,

  initialWeather: 'clear',
  transitionDurationSeconds: 90,
  previewTransitionSeconds: 12,
  rainLeadFraction: 0.32,
  weatherChangeChancePerSecond: 0.06,
  // How often the same weather turns into another of its variants, and how long that takes.
  variantChangeChancePerSecond: 0.012,
  variantTransitionSeconds: 45,
  windChangeChancePerSecond: 0.30,
  windSpeedRange: [2.0, 22.0],
  cloudLayerRefreshHz: 1.0,
  transitions: {
    clear: ['partly_cloudy', 'foggy'],
    partly_cloudy: ['clear', 'cloudy', 'foggy'],
    cloudy: ['partly_cloudy', 'overcast', 'foggy'],
    overcast: ['cloudy', 'rain', 'foggy'],
    rain: ['overcast', 'storm', 'foggy'],
    storm: ['rain', 'overcast'],
    foggy: ['clear', 'partly_cloudy', 'cloudy', 'overcast'],
  },

  // Each spell of a weather lies between two of its forms: the one given first and its variants, which list only what differs.
  // clouds: deck (how much sheet cloud) with its thickness, opacity (1 = the full rain deck), evenness (1 = no gaps) and cells
  // (0 billows .. 1 a field of cells); alto: share of the altocumulus; rainShade darkens the deck; low: scud and low stratus; mist: on the ground.
  effects: {
    clear: {
      label: 'Clear sky',
      clouds: { presence: 0, mist: 0.025 },
      weight: 3.0,
      intensity: 0.0,
      cloudCoverage: 0.08,
      precipitationIntensity: 0.0,
      fogDensity: 0.0,
      fogMultiplier: 1.0,
      water: {
        waveHeight: 0.20,
        windWaveScale: 1.0,
        precipitationWaveScale: 0.1,
        waveFrequency: 1.20,
        windFrequencyScale: 0.50,
        precipitationFrequencyScale: 0.05,
        foamIntensity: 0.25,
        windFoamScale: 1.2,
        precipitationFoamScale: 0.15,
        foamDepthEnd: 2.0,
        foamDepthWeatherScale: 0.2
      },
      rainParticles: { enabled: false }
    },

    partly_cloudy: {
      label: 'Scattered clouds',
      clouds: { mist: 0.08, thickness: 0.6, evenness: 0 },
      variants: [
        { name: 'A few small clouds', cloudCoverage: 0.26, clouds: { mist: 0.05, alto: 0.3 } },
        { name: 'Many clouds', cloudCoverage: 0.55, clouds: { deck: 0.1, mist: 0.1 } },
        { name: 'Thin veil among the clouds', weight: 0.7, cloudCoverage: 0.36, clouds: { deck: 0.45, thickness: 0.35, opacity: 0.3, evenness: 0.5, alto: 0.2 } },
      ],
      weight: 2.6,
      intensity: 0.30,
      cloudCoverage: 0.40,
      precipitationIntensity: 0.0,
      fogDensity: 0.04,
      fogMultiplier: 1.05,
      water: {
        waveHeight: 0.24,
        windWaveScale: 1.0,
        precipitationWaveScale: 0.1,
        waveFrequency: 1.10,
        windFrequencyScale: 0.45,
        precipitationFrequencyScale: 0.05,
        foamIntensity: 0.30,
        windFoamScale: 1.2,
        precipitationFoamScale: 0.2,
        foamDepthEnd: 2.0,
        foamDepthWeatherScale: 0.2
      },
      rainParticles: { enabled: false }
    },

    cloudy: {
      label: 'Cloudy',
      clouds: { deck: 0.27, mist: 0.16 },
      variants: [
        { name: 'Field of cells', clouds: { deck: 0.66, thickness: 0.5, opacity: 0.8, cells: 0.9, alto: 0.15 } },
        { name: 'Large clouds', cloudCoverage: 0.72, clouds: { deck: 0.12, alto: 0.35 } },
        { name: 'Clouds under a veil', cloudCoverage: 0.5, clouds: { deck: 0.62, thickness: 0.45, opacity: 0.35, evenness: 0.6, alto: 0.2 } },
      ],
      weight: 2.2,
      intensity: 0.50,
      cloudCoverage: 0.62,
      precipitationIntensity: 0.0,
      fogDensity: 0.08,
      fogMultiplier: 1.12,
      water: {
        waveHeight: 0.30,
        windWaveScale: 1.05,
        precipitationWaveScale: 0.15,
        waveFrequency: 1.00,
        windFrequencyScale: 0.45,
        precipitationFrequencyScale: 0.08,
        foamIntensity: 0.35,
        windFoamScale: 1.25,
        precipitationFoamScale: 0.25,
        foamDepthEnd: 2.1,
        foamDepthWeatherScale: 0.3
      },
      rainParticles: { enabled: false }
    },

    overcast: {
      label: 'Overcast',
      clouds: { deck: 0.86, rainShade: 0.22, mist: 0.23, evenness: 0.3 },
      variants: [
        { name: 'Even grey', weight: 1.2, clouds: { deck: 0.92, rainShade: 0.2, thickness: 0.6, opacity: 0.8, evenness: 0.95 } },
        { name: 'Hazy veil', clouds: { deck: 0.9, rainShade: 0, thickness: 0.6, opacity: 0.09, evenness: 1, alto: 0, mist: 0.18 } },
        { name: 'Thin high layer', clouds: { deck: 0.88, rainShade: 0.05, thickness: 0.45, opacity: 0.2, evenness: 0.7, cells: 0.4, alto: 0 } },
        { name: 'Cells', clouds: { deck: 0.9, rainShade: 0.14, thickness: 0.55, opacity: 0.9, evenness: 0.25, cells: 0.95, alto: 0 } },
        { name: 'Heavy', weight: 0.7, clouds: { deck: 0.92, rainShade: 0.42, thickness: 1, evenness: 0.45 } },
      ],
      weight: 1.4,
      intensity: 0.68,
      cloudCoverage: 0.88,
      precipitationIntensity: 0,
      fogDensity: 0.16,
      fogMultiplier: 1.24,
      water: {
        waveHeight: 0.36,
        windWaveScale: 1.15,
        precipitationWaveScale: 0.35,
        waveFrequency: 0.88,
        windFrequencyScale: 0.48,
        precipitationFrequencyScale: 0.12,
        foamIntensity: 0.42,
        windFoamScale: 1.35,
        precipitationFoamScale: 0.45,
        foamDepthEnd: 2.2,
        foamDepthWeatherScale: 0.45
      },
      rainParticles: { enabled: false }
    },

    rain: {
      label: 'Rain',
      clouds: { deck: 0.96, rainShade: 0.85, low: 0.08, mist: 0.52, evenness: 0.35 },
      variants: [
        { name: 'Steady rain from an even sky', weight: 1.4, precipitationIntensity: 0.6, clouds: { deck: 0.96, rainShade: 0.5, thickness: 0.65, opacity: 0.8, evenness: 1, low: 0.05 } },
        { name: 'Drizzle from thin grey', precipitationIntensity: 0.34, clouds: { deck: 0.94, rainShade: 0.45, thickness: 0.55, opacity: 0.6, evenness: 0.95, alto: 0, low: 0.04, mist: 0.58 } },
        { name: 'Showers', precipitationIntensity: 0.66, cloudCoverage: 0.8, clouds: { deck: 0.74, rainShade: 0.85, evenness: 0, low: 0.06, mist: 0.36, alto: 0.3 } },
        { name: 'Low ragged cloud', weight: 0.8, clouds: { deck: 0.95, rainShade: 0.7, thickness: 0.85, evenness: 0.7, low: 0.22, mist: 0.62 } },
      ],
      weight: 1.0,
      intensity: 0.74,
      cloudCoverage: 0.94,
      precipitationIntensity: 0.78,
      fogDensity: 0.28,
      fogMultiplier: 1.48,
      water: {
        waveHeight: 0.42,
        windWaveScale: 1.20,
        precipitationWaveScale: 1.05,
        waveFrequency: 0.76,
        windFrequencyScale: 0.50,
        precipitationFrequencyScale: 0.22,
        foamIntensity: 0.55,
        windFoamScale: 1.45,
        precipitationFoamScale: 0.85,
        foamDepthEnd: 2.5,
        foamDepthWeatherScale: 1.0
      },
      rainParticles: {
        enabled: true,
        spawnBudgetPerFrame: 210,
        distanceCutoff: 110.0,
        lodNearDistance: 22.0,
        lodFarDistance: 95.0,
        lodMinScale: 0.38,
        maxCameraAltitude: 4800
      }
    },

    storm: {
      label: 'Storm',
      clouds: { deck: 0.78, rainShade: 1, low: 0.20, mist: 0.70, opacity: 1.35, evenness: 0.15 },
      variants: [
        { name: 'Black ceiling', clouds: { deck: 0.97, rainShade: 1, thickness: 1.1, opacity: 1.2, evenness: 0.7, low: 0.26 } },
        { name: 'Towers with gaps', clouds: { deck: 0.66, rainShade: 1, thickness: 1.2, evenness: 0, low: 0.12, mist: 0.5, alto: 0 } },
        { name: 'Squall', clouds: { deck: 0.88, rainShade: 0.9, thickness: 0.9, evenness: 0.35, cells: 0.4, low: 0.24 } },
      ],
      weight: 0.55,
      intensity: 0.92,
      cloudCoverage: 0.98,
      precipitationIntensity: 1.0,
      fogDensity: 0.40,
      fogMultiplier: 1.85,
      water: {
        waveHeight: 0.70,
        windWaveScale: 1.55,
        precipitationWaveScale: 1.45,
        waveFrequency: 0.58,
        windFrequencyScale: 0.62,
        precipitationFrequencyScale: 0.32,
        foamIntensity: 0.75,
        windFoamScale: 1.8,
        precipitationFoamScale: 1.15,
        foamDepthEnd: 3.0,
        foamDepthWeatherScale: 1.5
      },
      rainParticles: {
        enabled: true,
        spawnBudgetPerFrame: 340,
        distanceCutoff: 125.0,
        lodNearDistance: 25.0,
        lodFarDistance: 110.0,
        lodMinScale: 0.45,
        maxCameraAltitude: 5600
      }
    },

    foggy: {
      label: 'Low clouds and mist',
      clouds: { presence: 0.6, deck: 0.12, low: 0.92, mist: 0.76 },
      variants: [
        { name: 'Low cloud', clouds: { low: 0.95, mist: 0.5 } },
        { name: 'Mist under a clear sky', cloudCoverage: 0.3, clouds: { presence: 0.4, deck: 0, low: 0.3, mist: 0.7 } },
        { name: 'Grey and misty', clouds: { presence: 0.9, deck: 0.85, thickness: 0.4, opacity: 0.35, evenness: 1, low: 0.45, mist: 0.8 } },
      ],
      weight: 0.9,
      intensity: 0.44,
      cloudCoverage: 0.55,
      precipitationIntensity: 0.0,
      fogDensity: 0.62,
      fogMultiplier: 2.10,
      water: {
        waveHeight: 0.18,
        windWaveScale: 0.45,
        precipitationWaveScale: 0.05,
        waveFrequency: 1.00,
        windFrequencyScale: 0.25,
        precipitationFrequencyScale: 0.02,
        foamIntensity: 0.18,
        windFoamScale: 0.6,
        precipitationFoamScale: 0.05,
        foamDepthEnd: 2.0,
        foamDepthWeatherScale: 0.2
      },
      rainParticles: { enabled: false }
    }
  }
});
