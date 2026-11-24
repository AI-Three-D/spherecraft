import { describe, expect, it } from 'vitest';
import { VolumetricCloudsModule } from './VolumetricCloudsModule.js';

const weather = [1, 0.27, 0, 0];
const view = { back: [0, 0, 1], proj: [0.7, 1.3, 0, 0, -1.00002, -2] };
const historyState = clouds => clouds._uniformData[49 * 4 + 2];

describe('conventional cloud history', () => {
    it('keeps history when a climb changes the scene depth range', () => {
        const clouds = new VolumetricCloudsModule();
        clouds._updateConventionalHistory(true, view, weather);
        expect(historyState(clouds)).toBe(1);
        clouds._resetHistory = false;
        clouds._frame++;
        clouds._updateConventionalHistory(true, { ...view, proj: [0.7, 1.3, 0, 0, -1.00003, -3] }, weather);
        expect(historyState(clouds)).toBe(2);
    });

    it('seeds fresh history after a cut, a different projection, or a disabled pass', () => {
        const clouds = new VolumetricCloudsModule();
        clouds._updateConventionalHistory(true, view, weather);
        clouds._resetHistory = false;
        clouds._frame++;
        clouds._updateConventionalHistory(true, { ...view, proj: [0.8, ...view.proj.slice(1)] }, weather);
        expect(historyState(clouds)).toBe(1);
        clouds._frame++;
        clouds._updateConventionalHistory(true, { ...view, back: [1, 0, 0], proj: [0.8, ...view.proj.slice(1)] }, weather);
        expect(historyState(clouds)).toBe(1);
        clouds._updateConventionalHistory(false, view, weather);
        expect(historyState(clouds)).toBe(0);
        clouds._frame++;
        clouds._updateConventionalHistory(true, view, weather);
        expect(historyState(clouds)).toBe(1);
    });
});
