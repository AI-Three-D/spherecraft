import {afterEach,describe,expect,it,vi} from 'vitest';
import {GameTime} from './gameTime.js';

afterEach(()=>vi.useRealTimers());
describe('game day progression',()=>{
    it('starts at noon and advances through night into the next day',()=>{
        vi.useFakeTimers();vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        const clock=new GameTime({});clock.update();
        expect(clock.timeOfDay).toBe(12);expect(clock.currentDay).toBe(clock.startDay);
        vi.advanceTimersByTime(clock.dayDurationMs/4);clock.update();
        expect(clock.timeOfDay).toBe(18);
        vi.advanceTimersByTime(clock.dayDurationMs/4);clock.update();
        expect(clock.timeOfDay).toBe(0);expect(clock.currentDay).toBe(clock.startDay+1);
    });
    it('holds the time of day while frozen and resumes from the same moment',()=>{
        vi.useFakeTimers();vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        const clock=new GameTime({});
        clock.setFrozen(true);expect(clock.frozen).toBe(true);
        vi.advanceTimersByTime(clock.dayDurationMs/4);clock.update();
        expect(clock.timeOfDay).toBe(12);
        clock.setFrozen(false);clock.update();
        expect(clock.timeOfDay).toBe(12);
        vi.advanceTimersByTime(clock.dayDurationMs/4);clock.update();
        expect(clock.timeOfDay).toBe(18);
    });
});
