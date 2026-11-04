import test from 'node:test';
import assert from 'node:assert/strict';
import { RegionFrame } from '../../core/voxel/RegionFrame.js';
import { CutPlane } from '../../core/voxel/CutPlane.js';
import { AnthillCamera } from '../../core/voxel/AnthillCamera.js';
import { InspectionCamera } from '../InspectionCamera.js';
import { inspectionPixelRatio } from '../inspectionResolution.js';

const near = (a,b) => assert.ok(Math.abs(a-b)<1e-6,`${a} vs ${b}`);
function camera() {
    const frame = new RegionFrame({origin:{x:0,y:131072.337,z:0},up:{x:0,y:1,z:0},heading:{x:1,y:0,z:0}});
    const source = new AnthillCamera({frame,plane:new CutPlane({offset:10}),center:{s:12,y:8},metersPerPixel:0.25});
    const out = new InspectionCamera(source,{pixelRatio:2});
    out.orbit(40,-10);
    return out;
}

test('retina inspection stays within pixel budgets', () => {
    for (const [width,height] of [[1000,700],[3440,1440]]) {
        assert.ok(width*height*inspectionPixelRatio(width,height,2,true)**2 <= 360001);
        assert.ok(width*height*inspectionPixelRatio(width,height,2,false)**2 <= 1000001);
    }
});

test('changing inspection render resolution preserves framing and pan distance', () => {
    const a=camera(),b=camera();
    a.update(2000,1400);
    const projection=Array.from(a.projectionMatrix.elements),position={...a.position};
    const ratio=inspectionPixelRatio(1000,700,2,true);
    a.setPixelRatio(ratio);a.update(1000*ratio,700*ratio);
    projection.forEach((v,i)=>near(a.projectionMatrix.elements[i],v));
    assert.deepEqual(a.position,position);
    a.pan(20*ratio,10*ratio);b.pan(20*2,10*2);
    for(const k of ['x','y','z'])near(a.target[k],b.target[k]);
    a.setPixelRatio(2);a.update(2000,1400);
    near(a.metersPerPixel,b.metersPerPixel);
    projection.forEach((v,i)=>near(a.projectionMatrix.elements[i],v));
});
