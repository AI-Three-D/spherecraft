import {test,expect} from 'vitest';
import {screenGapRuns} from './screenGaps.js';
test('stops a rejected-water run at foreground ground and counts its lake-coloured backing',()=>{
    const positions=new Float32Array([0,0,10,635,0,0,12,1,0,0,12,1,0,0,9,1]);
    const probe=new Float32Array([0,0,10,1,0,0,10,-1,0,0,10,-1,0,0,10,-1]);
    const owners=new Float32Array([0,0,0,0,0,0,64,1,0,0,64,1,0,0,0,1]);
    const args={positions,probe,owners,edges:[{kind:'lake',status:'hanging',waterIndex:0,neighbourIndex:1}],width:4,height:1,cssWidth:2,cssHeight:.5};
    const a=screenGapRuns(args).rows[0];expect(a.renderPixels).toBe(2);expect(a.cssPixels).toBe(1);
    expect(a.nearestGroundContactRenderPx).toBe(2.5);
    expect(a.allLakeShaded).toBe(true);expect(a.stop).toBe('ground-contact');
    owners[10]=0;expect(screenGapRuns(args).rows[0].allLakeShaded).toBe(false);
    positions[7]=635;expect(screenGapRuns(args).rows[0].renderPixels).toBe(0);
});
