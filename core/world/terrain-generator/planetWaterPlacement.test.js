import {describe,it,expect} from 'vitest';
import {planetWaterOptions,selectPlanetWaterRegions,packPlanetWaterAtlas,planetWaterAtlasChunks,planetShapeOwnership,planetBasinDirectory,isPlanetWaterSiteRejection,retainPlanetLakeFootprints} from './planetWaterPlacement.js';
import {faceUVToDir,dirToFaceUV} from '../hydrology/waterGraph.js';
import {tangentBasis,planeToDir} from '../hydrology/lakeRefine.js';
import {sampleRegionalShape} from './regionalShapeModel.js';
const region=(face,depth,x,y,cells=128)=>{
 const size=cells+3,controls=Float32Array.from({length:size*size},(_,k)=>100+k*.01),mask=new Uint8Array(cells*cells);mask[50*cells+50]=1;
 return {options:{face,depth,x,y,cells},controls,lakePlan:{region:mask},basin:{levelM:90},parameters:new Float32Array([face,2**depth,x,y,cells,8,1,.25,90,1.5,.25,.125,90,120,1.5,.5])};
};
describe('planet water ownership',()=>{
 it('bounds upload chunks independently of atlas size while preserving mixed region metadata',()=>{
  const regions=Array.from({length:64},(_,i)=>region(i%6,7,i,20));
  const p=planetWaterAtlasChunks(regions,128),chunks=[...p.chunks()];
  expect(chunks).toHaveLength(66);
  expect(Math.max(...chunks.map(c=>c.values.byteLength))).toBe(2048*48*16);
  expect(p.width*p.height*16).toBeLessThan(30*1024*1024);
  expect(chunks[1].values.slice(20*61,20*61+16)).toEqual(regions[61].parameters);
  expect(chunks[63].x).toBe(p.offsets[61][0]);expect(chunks[63].y).toBe(p.offsets[61][1]);
  expect(chunks[63].values[0]).toBe(regions[61].controls[0]);
 });
 it('keeps records readable across atlas row boundaries with different control sizes',()=>{
  const regions=Array.from({length:412},(_,i)=>region(i%6,7,Math.floor(i/6)%120+1,Math.floor(i/720)+1,i%3===0?256:i%3===1?128:64));
  const p=packPlanetWaterAtlas(regions,128),id=409,first=(p.indexRows*p.width+id*5)*4;
  expect(p.values.slice(first,first+16)).toEqual(regions[id].parameters);
  expect(Array.from(p.values.slice(first+16,first+18))).toEqual(p.offsets[id]);
  const [x,y]=p.offsets[id];expect(p.values[(y*p.width+x)*4]).toBe(regions[id].controls[0]);
  expect(new Set(p.offsets.map(o=>o.join(','))).size).toBe(regions.length);
 });
 it('rejects a crowded third footprint before publication and removes its carve ownership',()=>{
  const r=region(0,6,10,11),centre=faceUVToDir(0,.5,.5),frame={c:centre,...tangentBasis(centre),x0:0,y0:0,spacing:16,nx:1,ny:1};
  r.basins=[100,103,110].map(levelM=>({levelM,frame,mask:new Uint8Array([2])}));
  r.lakePlans=r.basins.map((b,i)=>{const region=new Uint8Array(128*128);region[(50+i*10)*128+50]=1;return {region,levelM:b.levelM};});
  r.ownership=new Uint8Array(128*128).fill(1);r.levels=new Float32Array(128*128).fill(110);r.micro=new Uint8Array(131*131).fill(1);
  expect(retainPlanetLakeFootprints(r,new Map(),1,131072)).toBe(1);expect(r.basins).toHaveLength(2);
  expect(r.ownership[70*128+50]).toBe(0);expect(r.levels[60*128+50]).toBe(103);expect(r.micro[72*131+52]).toBe(0);
 });
 it('keeps distinct water levels in a shared terrain patch',()=>{
  const r=region(0,6,10,11);r.ownership=r.lakePlan.region.slice();r.ownership[70*128+70]=1;
  r.levels=new Float32Array(128*128);r.levels[50*128+50]=90;r.levels[70*128+70]=95;
  const p=packPlanetWaterAtlas([r],128),value=(x,y)=>p.values[((p.header+y)*p.width+x)*4+2];
  expect(value(50,50)).toBe(90);expect(value(70,70)).toBe(95);
 });
 it('rejects unsuitable sites while surfacing shader and programming errors',()=>{
  expect(isPlanetWaterSiteRejection(new Error('Regional course self-intersects'))).toBe(true);
  expect(isPlanetWaterSiteRejection(new Error('Regional river profile exceeds incision budget: 50m'))).toBe(true);
  expect(isPlanetWaterSiteRejection(new Error('Invalid regional river profile inputs'))).toBe(false);
  expect(isPlanetWaterSiteRejection(new Error('GPU validation failed in profile shader'))).toBe(false);
 });
 it('bounds world work and rejects unsupported payload budgets',()=>{
  expect(()=>planetWaterOptions({maxRegions:1537})).toThrow();expect(()=>planetWaterOptions({maxRegions:64,maxRivers:513})).toThrow();
  expect(()=>planetWaterOptions({maxRegions:64,maxCandidates:10})).toThrow();expect(planetWaterOptions().maxRegions).toBe(1100);
  expect(()=>planetWaterOptions({shapeCells:256,maxRegions:449})).toThrow();
 });
 it('spreads proposals across faces and rejects ocean-only regions deterministically',()=>{
  const cells=64,size=67,a=new Float32Array(6*size*size*4),b=a.slice();
  for(let k=0;k<a.length;k+=4){a[k]=1;a[k+2]=.1;b[k+2]=.1;b[k+3]=.1;}
  const input={a,b,cells,size,maxCandidates:36,heightScale:5000,shelfM:700};
  const selected=selectPlanetWaterRegions(input);expect(selected).toEqual(selectPlanetWaterRegions(input));expect(new Set(selected.slice(0,6).map(c=>c.face)).size).toBe(6);
  a.fill(0,0,size*size*4);expect(selectPlanetWaterRegions(input).some(c=>c.face===0)).toBe(false);
 });
 it('preserves each spline and wet/rim controls across mixed addresses',()=>{
  const regions=[region(0,3,2,2,256),region(4,7,21,22,64)],packed=packPlanetWaterAtlas(regions,128);
  for(let id=0;id<regions.length;id++){
   const r=regions[id],n=r.options.cells,side=n+3,x=50.35,y=50.6,u=(r.options.x+x/n)/2**r.options.depth,v=(r.options.y+y/n)/2**r.options.depth;
   const cell=(r.options.face*128+Math.floor(v*128))*128+Math.floor(u*128);expect(packed.directory[cell]).toBe(id);
   const controls=new Float32Array(side*side),[ox,oy]=packed.offsets[id];
   for(let j=0;j<side;j++)for(let i=0;i<side;i++)controls[j*side+i]=packed.values[((oy+j)*packed.width+ox+i)*4];
   expect(sampleRegionalShape(controls,n,x,y)).toBe(sampleRegionalShape(r.controls,n,x,y));
   expect(packed.values[((oy+50)*packed.width+ox+50)*4+1]).toBe(3);expect(packed.values[((oy+49)*packed.width+ox+49)*4+1]).toBe(1);
  }
  expect(()=>packPlanetWaterAtlas([region(0,6,10,11),region(0,7,20,22)],128)).toThrow(/Overlapping/);
 });
 it('keeps shape ownership local and basin broad-phase conservative',()=>{
  const r=region(2,7,35,40),p=packPlanetWaterAtlas([r],128),owns=planetShapeOwnership(p.directory,128,131072);
  expect(owns(faceUVToDir(2,35.5/128,40.5/128))).toBe(true);expect(owns(faceUVToDir(1,35.5/128,40.5/128))).toBe(false);
  const centre=faceUVToDir(3,.4,.6),b={centre,radiusM:100},d=planetBasinDirectory(p.directory,128,[b],131072),frame={c:centre,...tangentBasis(centre)};
  for(let j=0;j<128;j++){
   const dir=planeToDir(Math.cos(j*Math.PI/64)*160,Math.sin(j*Math.PI/64)*160,frame,131072),uv=dirToFaceUV(dir),k=((uv.face*128+Math.floor(uv.v*128))*128+Math.floor(uv.u*128))*4;
   expect(Array.from(d.slice(k+1,k+4))).toContain(1);
  }
  expect(()=>planetBasinDirectory(p.directory,128,[b,b,b,b],131072)).toThrow(/overflow/);
 });
});
