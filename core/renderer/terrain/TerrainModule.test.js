import { describe, it, expect, vi } from 'vitest';
import { Renderer } from '../Renderer.js';
import { TerrainModule } from './TerrainModule.js';
import { recordingBackend, camera } from '../../../tests/helpers/recordingBackend.js';

function fixture() {
    const events = [];
    const source = {
        maxGeomLOD: 0, initialize: vi.fn(() => events.push('source.initialize')),
        isReady: vi.fn(() => true), update: vi.fn(() => events.push('source.update')),
        resolveFeedbackReadback: vi.fn(() => events.push('source.feedback')),
        dispose: vi.fn(() => events.push('source.dispose')),
    };
    const draw = {
        initialize: vi.fn(() => events.push('draw.initialize')),
        render: vi.fn(() => events.push('terrain.draw')),
        setWaterData: vi.fn(), dispose: vi.fn(() => events.push('draw.dispose')),
    };
    const water = {
        initialize: vi.fn(() => events.push('water.initialize')),
        compute: vi.fn(() => events.push('water.compute')),
        render: vi.fn(() => events.push('water.draw')),
        setWaterData: vi.fn(), dispose: vi.fn(() => events.push('water.dispose')),
    };
    return { source, draw, water, events };
}

describe('optional terrain module', () => {
    it('renders a borrowed fixture source and water without loading a planetary world', async () => {
        const { source, draw, water, events } = fixture();
        const { backend } = recordingBackend(events);
        const renderer = new Renderer({ backend });
        await renderer.initialize();
        const terrain = new TerrainModule({ source, renderer: draw, waterLayers: [water] });
        await renderer.addModule(terrain);
        await renderer.addModule({ id: 'prop', render: () => events.push('prop.draw') });
        renderer.renderFrame({ camera, deltaTime: 0.1 });
        expect(source.initialize).not.toHaveBeenCalled();
        expect(events.indexOf('source.update')).toBeLessThan(events.indexOf('water.compute'));
        expect(events.indexOf('water.compute')).toBeLessThan(events.indexOf('terrain.draw'));
        expect(events.indexOf('prop.draw')).toBeLessThan(events.indexOf('water.draw'));
        expect(events.indexOf('submit')).toBeLessThan(events.indexOf('source.feedback'));
        const data = { resources: {} };
        terrain.setWaterData(data);
        expect(draw.setWaterData).toHaveBeenLastCalledWith(data);
        expect(water.setWaterData).toHaveBeenLastCalledWith(data);
        terrain.setWaterData(null);
        expect(water.setWaterData).toHaveBeenLastCalledWith(null);
        renderer.removeModule('terrain');
        expect(water.dispose).toHaveBeenCalledTimes(1);
        expect(draw.dispose).toHaveBeenCalledTimes(1);
        expect(source.dispose).not.toHaveBeenCalled();
        renderer.renderFrame({ camera, deltaTime: 0 });
        expect(draw.render).toHaveBeenCalledTimes(1);
    });

    it('initializes and disposes an owned world, including after water initialization fails', async () => {
        const { source, draw, water } = fixture();
        const { backend } = recordingBackend();
        const renderer = new Renderer({ backend });
        await renderer.initialize();
        water.initialize = () => { throw new Error('water failed'); };
        const terrain = new TerrainModule({ source, renderer: draw, waterLayers: [water], ownsSource: true, initializeSource: true });
        await expect(renderer.addModule(terrain)).rejects.toThrow('water failed');
        expect(source.initialize).toHaveBeenCalledTimes(1);
        expect(source.dispose).toHaveBeenCalledTimes(1);
        expect(draw.dispose).toHaveBeenCalledTimes(1);
        expect(water.dispose).toHaveBeenCalledTimes(1);
        terrain.dispose();
        expect(source.dispose).toHaveBeenCalledTimes(1);
    });

    it('does not draw or simulate water while source data is unavailable', async () => {
        const { source, draw, water } = fixture();
        source.isReady.mockReturnValue(false);
        const { backend } = recordingBackend();
        const renderer = new Renderer({ backend });
        await renderer.initialize();
        await renderer.addModule(new TerrainModule({ source, renderer: draw, waterLayers: [water] }));
        renderer.renderFrame({ camera, deltaTime: 0 });
        expect(source.update).not.toHaveBeenCalled();
        expect(draw.render).not.toHaveBeenCalled();
        expect(water.compute).not.toHaveBeenCalled();
        expect(water.render).not.toHaveBeenCalled();
        expect(backend.submitCommands).toHaveBeenCalledTimes(1);
    });
});
