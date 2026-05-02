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
  weatherChangeChancePerSecond: 0.06,
  windChangeChancePerSecond: 0.30,
  windSpeedRange: [2.0, 22.0],
  cloudLayerRefreshHz: 1.0,

  effects: {
    clear: {
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
      weight: 1.4,
      intensity: 0.68,
      cloudCoverage: 0.88,
      precipitationIntensity: 0.08,
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
        maxCameraAltitude: 24000.0
      }
    },

    storm: {
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
        maxCameraAltitude: 28000.0
      }
    },

    foggy: {
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
