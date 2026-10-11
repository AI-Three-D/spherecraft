import {describe,it,expect} from 'vitest';
import {advanceWaterSimClock} from './waterSimClock.js';
describe('bounded elapsed-time water clock',()=>{
    it('runs the same physics time at 30, 60 and 144 fps',()=>{
        for(const fps of [30,60,144]){
            const clock={remainderS:0,droppedS:0};let steps=0;
            for(let i=0;i<fps*10;i++)steps+=advanceWaterSimClock(clock,1/fps,1/120,8);
            expect(steps).toBe(1200);expect(clock.droppedS).toBeCloseTo(0,8);
        }
    });
    it('does not turn a two-second stall into a catch-up burst',()=>{
        const clock={remainderS:0,droppedS:0};
        expect(advanceWaterSimClock(clock,2,1/120,8)).toBe(8);
        expect(clock.droppedS).toBeGreaterThan(1.9);
        expect(advanceWaterSimClock(clock,1/60,1/120,8)).toBe(2);
    });
});
