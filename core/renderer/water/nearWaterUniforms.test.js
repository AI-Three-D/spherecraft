import {expect,it} from 'vitest';
import {fillNearWaterUniforms,NEAR_WATER_UNIFORM_FLOATS} from './nearWaterUniforms.js';

it('packs lake-specific field masks and excludes multi-basin ownership',()=>{
    const u=new Float32Array(NEAR_WATER_UNIFORM_FLOATS),matrix=new Float32Array(16);
    const water={R:100000,near:{fadeEndM:1600},junctionFields:{fields:[9,123,-1,9].map(lakeId=>({lakeId}))}};
    const input={viewMatrix:matrix,projectionMatrix:matrix,planetConfig:{},camera:{position:{x:0,y:0,z:0}},
        water,lakes:[123,9,999],apFade:{start:100,end:1000}};
    fillNearWaterUniforms(u,input);
    expect(u[42]).toBe(11);expect(Array.from(u.slice(88,92))).toEqual([2,9,0,0]);
    water.junctionFields.fields=[];fillNearWaterUniforms(u,input);
    expect(u[42]).toBe(0);expect(Array.from(u.slice(88))).toEqual(Array(16).fill(0));
});
