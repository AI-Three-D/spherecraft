import { describe, expect, it } from 'vitest';
import { EnvironmentState } from '../../environment/EnvironmentState.js';
import { WeatherController } from './WeatherController.js';

function setup(config = {}) {
    const weather = new WeatherController(null, {
        initialWeather: 'clear',
        windChangeChancePerSecond: 0,
        weatherChangeChancePerSecond: 0,
        previewTransitionSeconds: 10,
        rainLeadFraction: 0.32,
        cloudLayerProvider: (name) => name === 'clear'
            ? [{ name: 'high', coverage: 0.1, altMin: 90 }]
            : [{ name: 'high', coverage: 0.5, altMin: 80 }, { name: 'low', coverage: 0.55, altMin: 10 }],
        ...config,
    });
    const env = new EnvironmentState(null);
    weather.update(0, env);
    return { weather, env, advance: seconds => weather.update(seconds, env) };
}

describe('weather transitions', () => {
    it('builds the cloud deck and darkens it before rain starts', () => {
        const { weather, env, advance } = setup();
        expect(weather.setWeatherPreview('rain')).toBe(true);
        advance(2.5);
        expect(weather.getWeatherPreview()).toEqual({ selected: 'rain', target: 'rain', progress: 0.25 });
        expect(env.precipitationIntensity).toBe(0);
        expect(env.rainParticles.enabled).toBe(false);
        expect(env.weatherEffect.clouds.deck).toBeGreaterThan(0);
        expect(env.weatherEffect.clouds.rainShade).toBeGreaterThan(env.weatherEffect.clouds.deck);
        expect(env.cloudLayers.find(layer => layer.name === 'high').coverage).toBeCloseTo(0.1625);
        expect(env.cloudLayers.find(layer => layer.name === 'low').coverage).toBeCloseTo(0.0859375);
        advance(7.5);
        expect(env.precipitationIntensity).toBeCloseTo(0.78);
        expect(env.rainParticles.enabled).toBe(true);
        expect(env.weatherEffect.clouds.deck).toBe(0.96);
    });

    it('retargets from the current optical weather and cloud coverage without popping', () => {
        const { weather, env, advance } = setup();
        weather.setWeatherPreview('rain');
        advance(5);
        const { clouds, precipitationIntensity } = env.weatherEffect;
        const layers = env.cloudLayers;
        weather.setWeatherPreview('clear');
        advance(0);
        expect(env.weatherEffect.clouds).toEqual(clouds);
        expect(env.precipitationIntensity).toBe(precipitationIntensity);
        expect(env.cloudLayers).toEqual(layers);
        advance(7);
        expect(env.precipitationIntensity).toBe(0);
        expect(env.weatherEffect.clouds.deck).toBeGreaterThan(0);
        advance(3);
        expect(env.weatherEffect.clouds.presence).toBe(0);
        expect(env.cloudLayers).toEqual([{ name: 'high', coverage: 0.1, altMin: 90 }]);
    });

    it('holds a preview until automatic weather is selected again', () => {
        const { weather, advance } = setup({ weatherChangeChancePerSecond: 1 });
        weather._pickWeightedWeather = () => 'storm';
        weather.setWeatherPreview('foggy');
        advance(10);
        advance(2);
        expect(weather.getWeatherPreview()).toEqual({ selected: 'foggy', target: 'foggy', progress: 1 });
        weather.setWeatherPreview('auto');
        advance(2);
        expect(weather.getWeatherPreview()).toMatchObject({ selected: 'auto', target: 'storm' });
    });

    it('lets automatic clear weather develop scattered clouds or mist before severe weather', () => {
        const { weather, advance } = setup({ weatherChangeChancePerSecond: 1 });
        advance(1);
        expect(['partly_cloudy', 'foggy']).toContain(weather.getWeatherPreview().target);
    });
});
