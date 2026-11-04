import test from 'node:test';
import assert from 'node:assert/strict';
import { VoxelRegion } from '../VoxelRegion.js';
import { CutPlane } from '../CutPlane.js';
import { AnthillCamera } from '../AnthillCamera.js';
import { CharacterCamera } from '../CharacterCamera.js';
import { VolumeViewModule } from '../VolumeViewModule.js';
import { InspectionCamera } from '../../../dev_harness/InspectionCamera.js';
import { fakeDevice } from './fakeDevice.js';

function scene() {
    const region = new VoxelRegion({
        heightfield: { frame: { origin:{x:0,y:131072.337,z:0},up:{x:0,y:1,z:0},heading:{x:0.8,y:0,z:0.6} },
            corner:{x:-8,z:-8},spacing:1,countX:17,countZ:17,heights:new Float32Array(289).fill(5) },
        rock:{layers:[{color:[0.5,0.4,0.3]}]}, depth:8,
    });
    const plane = new CutPlane({offset:2});
    const camera = new AnthillCamera({frame:region.frame,plane,center:{s:3,y:1}});
    camera.update(800,600);
    const destroyed = [], draws = [];
    const backend = { device:fakeDevice(), deleteTexture(){}, updateTexture(){},
        destroyMaterial(m){destroyed.push(m);}, draw(g,m){draws.push([g,m]);} };
    const module = new VolumeViewModule({region,plane});
    module.initialize({backend});
    return {region,plane,camera,module,backend,destroyed,draws};
}

test('camera rays use local precision, bypass CPU slices, sync off-plane edits and dispose resources', () => {
    const {region,plane,camera,module,backend,destroyed,draws} = scene();
    const frame = {camera,backend,viewport:{width:800,height:600}};
    module.update(frame);
    assert.equal(module.cut,null);
    assert.equal(module._sliceTextures.size,0);
    assert.deepEqual(Array.from(module.rayData.slice(28,31)),[3,1,102]);
    camera.startTurn(1); camera.advanceTurn(0.175); camera.update(800,600);
    module.showGround = false;
    module.update(frame); module.render(frame); module.renderTransparent(frame);
    assert.equal(draws.length,1);
    assert.equal(draws[0][1],module.shadeMaterial);
    assert.equal(module._sliceTextures.size,0);
    assert.ok(Math.abs(module.rayData[44]-plane.normalX)<1e-6);
    region.apply({shape:{type:'sphere',center:[0,0,-4],radius:1}});
    module.update(frame);
    assert.equal(module.volumeGPU.revision,region.volume.revision);
    assert.equal(module.rayMaterial.storageBuffers.densities,module.volumeGPU.density);
    assert.equal(module.shadeMaterial.storageBuffers.densities,module.volumeGPU.density);
    assert.equal(module.shadeMaterial.uniforms.lighting.value,module.lighting.data);
    module.dispose();
    assert.equal(destroyed.length,4);
    assert.ok(backend.device.buffers.every(b=>b.destroyed));
});

test('inspection orbit and pan preserve cut and anthill framing', () => {
    const {camera,plane,module} = scene();
    const before = {angle:plane.angle,offset:plane.offset,center:{...camera.center},zoom:camera.metersPerPixel};
    const orbit = new InspectionCamera(camera);
    orbit.orbit(80,-60); orbit.pan(10,20); orbit.zoomAt(0.5); orbit.update(800,600);
    const {right,up,back} = orbit.basis();
    const dot=(a,b)=>a.reduce((sum,x,i)=>sum+x*b[i],0);
    for (const axis of [right,up,back]) assert.ok(Math.abs(dot(axis,axis)-1)<1e-10);
    assert.ok(Math.abs(dot(right,up))<1e-10); assert.ok(Math.abs(dot(up,back))<1e-10);
    module.inspection = true; module.clipEnabled = false; module.showGround = false;
    module.update({camera:orbit,viewport:{width:800,height:600}});
    assert.deepEqual(Array.from(module.rayData.slice(17,19)),[0,1]);
    assert.deepEqual({angle:plane.angle,offset:plane.offset,center:camera.center,zoom:camera.metersPerPixel},before);
    assert.ok(Math.max(...module.rayData.slice(28,31).map(Math.abs))<1000);
    module.dispose();
});

test('compute tracing precedes shading, resizes hit storage and rebinds grown density buffers', () => {
    const {region,camera,module,backend,draws} = scene();
    const frame={camera,backend,viewport:{width:800,height:600}};
    const dispatches=[],groups=[];
    const encoder={beginComputePass(){return {setPipeline(){},setBindGroup(index,group){groups.push(group);},
        dispatchWorkgroups(x,y){dispatches.push([x,y]);},end(){}};}};
    module.update(frame);module.compute(frame,encoder);module.render(frame);
    assert.deepEqual(dispatches,[[100,75]]);
    assert.equal(draws[0][1],module.shadeMaterial);
    const hit=module.hitTexture,firstGroup=module.traceBindGroup;
    module.compute(frame,encoder);
    assert.equal(module.traceBindGroup,firstGroup);
    region.apply({shape:{type:'sphere',center:[0,0,0],radius:3}});
    module.update(frame);module.compute(frame,encoder);
    assert.equal(module.boundDensity,module.volumeGPU.density);
    assert.equal(groups.at(-1).entries.find(e=>e.binding===7).resource.buffer,module.volumeGPU.density);
    frame.viewport={width:1000,height:700};
    module.update(frame);module.compute(frame,encoder);
    assert.equal(hit.destroyed,true);
    assert.notEqual(module.hitTexture,hit);
    assert.deepEqual(dispatches.at(-1),[125,88]);
    const count=dispatches.length;
    module.useCompute=false;module.compute(frame,encoder);module.render(frame);
    assert.equal(dispatches.length,count);
    assert.equal(draws.at(-1)[1],module.rayMaterial);
    const currentHit=module.hitTexture;
    module.dispose();
    assert.equal(currentHit.destroyed,true);
    assert.ok(backend.device.buffers.every(b=>b.destroyed));
});

test('perspective rays use one local eye, near/far planes and a diverging screen basis in both render paths', () => {
    const { region, module, backend, draws, camera: sideCamera } = scene();
    const character = { position: { x: 3, y: 6, z: -2 }, heading: 0.7, pitch: -0.2, config: { height: 1.8 } };
    const camera = new CharacterCamera({ frame: region.frame, character, mode: 'first-person' });
    camera.update(800, 600);
    const frame = { camera, backend, viewport: { width: 800, height: 600 } };
    module.clipEnabled = false;
    module.update(frame);
    const d = module.rayData;
    assert.ok(Math.abs(d[28] - 3) < 1e-5);
    assert.ok(Math.abs(d[29] - 7.62) < 1e-5);
    assert.ok(Math.abs(d[30] + 2) < 1e-5);
    assert.ok(Math.abs(d[31] - camera.near) < 1e-5);
    assert.ok(Math.abs(d[43] - camera.far) < 2);
    assert.equal(d[17], 0, 'full terrain stays visible');
    assert.equal(d[18], 1, 'perspective is not restricted to the cut visibility depth');
    // Reconstruct the exact centre/corner ray convention used by traceRay.
    const direction = Array.from(d.slice(40, 43));
    const right = Array.from(d.slice(32, 35)), up = Array.from(d.slice(36, 39));
    const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
    assert.ok(Math.abs(dot(direction, right)) < 1e-6);
    assert.ok(Math.abs(dot(direction, up)) < 1e-6);
    assert.ok(Math.abs(d[39] - Math.tan(camera.fov / 2)) < 1e-6);
    assert.ok(Math.abs(d[35] / d[39] - 800 / 600) < 1e-6);
    module.render(frame); module.renderTransparent(frame);
    assert.equal(draws.length, 1, 'orthographic ground overlay is skipped automatically');
    module.useCompute = false; module.render(frame);
    assert.equal(draws.at(-1)[1], module.rayMaterial);
    module.update({ ...frame, camera: sideCamera });
    assert.equal(module.rayData[31], 0, 'returning to parallel rays clears the near-plane flag');
    assert.equal(module.rayData[18], 0);
    module.dispose();
});

test('cached hits retain live lighting and invalidate for edits, camera, cut, visibility and render-path changes', () => {
    const {region,plane,camera,module,backend,draws}=scene();
    const frame={camera,backend,viewport:{width:800,height:600},deltaTime:0.1};
    let traces=0;
    const encoder={beginComputePass({label}) {
        if(label==='Voxel ray search') traces++;
        return {setPipeline(){},setBindGroup(){},dispatchWorkgroups(){},end(){}};
    }};
    const render=()=>{module.update(frame);module.compute(frame,encoder);module.render(frame);};
    render();
    const light=module.lighting.addLight({position:[0,2,0],intensity:1,radius:5});
    module.lighting.setTimeOfDay(20);render();
    module.lighting.updateLight(light,{position:[2,2,0]});render();
    assert.equal(traces,1,'moving lights and sun reuse the physical intersections');
    assert.equal(draws.length,3,'shading still runs every frame');
    region.apply({shape:{type:'sphere',center:[0,0,-4],radius:1}});render();
    assert.equal(traces,2,'an off-plane edit invalidates before the next shading pass');
    plane.set(plane.angle,3);render();
    module.visibilityDepth++;render();
    camera.pan(1,0);camera.update(800,600);render();
    module.clipEnabled=false;render();
    module.inspection=true;render();
    assert.equal(traces,7);
    module.useCompute=false;render();module.useCompute=true;render();
    assert.equal(traces,8);
    module.reuseHits=false;render();render();
    assert.equal(traces,10);
    module.dispose();
});

test('resident geometry fills hits before tracing, participates in hit caching, and switches to the original density pipeline',()=>{
    const {module,camera,backend,region}=scene(),d=backend.device;
    const frame={camera,viewport:{width:800,height:600},deltaTime:0};
    module.update(frame);
    const r=module.meshCache._record([1,2,1]);
    const buffer=()=>d.createBuffer({size:48,usage:32|8});
    r.stages=[{vertexBuffer:buffer(),indexBuffer:buffer(),indexCount:3,error:0,targetError:0}];
    r.uniform=buffer();r.ready=true;r.fullTriangles=1;r.fade=1;
    module.meshCache.residents.add(r);
    module.meshCache.drawDirty=true;
    const operations=[];
    const encoder={beginRenderPass(){operations.push('mesh');return {setPipeline(){},setBindGroup(){},setVertexBuffer(){},setIndexBuffer(){},
        drawIndexed(count){operations.push(count);},end(){}};},
        beginComputePass({label}){operations.push(label);return {setPipeline(p){operations.push(p);},setBindGroup(){},dispatchWorkgroups(){},end(){}};}};
    module.update(frame);module.compute(frame,encoder);
    assert.ok(operations.indexOf('mesh')<operations.indexOf('Voxel ray search'));
    assert.ok(operations.includes(3));assert.ok(operations.includes(module.meshTracePipeline));
    const count=operations.length;
    module.compute(frame,encoder);assert.equal(operations.length,count,'settled mesh hits are cached');
    const drawList=module.meshCache.draws;module.update(frame);
    assert.equal(module.meshCache.draws,drawList,'settled geometry reuses its draw list');
    module.meshCache.revision++;module.compute(frame,encoder);
    assert.equal(operations.length,count,'background geometry changes preserve valid stationary intersections');
    module.meshLOD=false;module.update(frame);module.compute(frame,encoder);
    assert.equal(operations.at(-1),module.tracePipeline);
    assert.equal((module.meshCache.coverage.get(r.id)??0),0);
    module.meshLOD=true;r.fade=1;module.update(frame);module.compute(frame,encoder);
    region.apply({shape:{type:'sphere',center:[-2,1,-2],radius:1}});
    module.update(frame);module.compute(frame,encoder);
    assert.equal((module.meshCache.coverage.get(r.id)??0),0,'dirty geometry cannot conceal a new edit');
    module.dispose();assert.ok(d.buffers.every(b=>b.destroyed));
});
