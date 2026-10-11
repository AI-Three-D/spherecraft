// Fixed physics step, bounded work per frame. Excess wall time is explicitly
// dropped after a stall; it never becomes an unbounded GPU catch-up burst.
export function advanceWaterSimClock(clock, elapsedS, stepS, maxSteps) {
    const elapsed=Math.max(0,elapsedS);
    const available=clock.remainderS+elapsed;
    const steps=Math.min(maxSteps,Math.floor((available+1e-10)/stepS));
    const remaining=Math.max(0,available-steps*stepS);
    clock.remainderS=remaining%stepS;
    clock.droppedS+=remaining-clock.remainderS;
    return steps;
}
