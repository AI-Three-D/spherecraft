import {describe,it,expect} from 'vitest';
import {regionalDepression} from './regionalDepression.js';
import {planRegionalShapeLake} from './regionalShapeModel.js';
import {faceUVToDir,dirToFaceUV} from '../hydrology/waterGraph.js';
import {tangentBasis,planeToDir} from '../hydrology/lakeRefine.js';

describe('terrain-owned broad depression',()=>{
    const cells=128,face=1,grid=64,tileX=40,tileY=20;
    const frameDir=(x,y)=>faceUVToDir(face,(tileX+x/cells)/grid,(tileY+y/cells)/grid);
    const generate=controls=>regionalDepression({controls,cells,frameDir,face,grid,tileX,tileY,
        tangentBasis,planeToDir,dirToFaceUV,planetRadius:131072,radiusM:450,maxCutM:8,depthM:2.5,seed:17});
    it('adds a deterministic cut-only landform and proves substantial connected wet area with the ordinary planner',()=>{
        const original=new Float32Array((cells+3)**2);
        for(let y=0;y<cells+3;y++)for(let x=0;x<cells+3;x++)original[y*(cells+3)+x]=1000+x*.003+y*.002;
        const controls=original.slice(),feature=generate(controls),repeat=original.slice();
        expect(generate(repeat).seedCell).toBe(feature.seedCell);expect(repeat).toEqual(controls);
        expect(feature.rejected).toBeUndefined();expect(feature.modifiedControls).toBeGreaterThan(100);
        for(let i=0;i<controls.length;i++) {
            expect(controls[i]).toBeLessThanOrEqual(original[i]);expect(original[i]-controls[i]).toBeLessThanOrEqual(8.001);
        }
        const plan=planRegionalShapeLake({controls,cells,maxPotentialCells:2048,minWetCells:100,
            candidateSeeds:[feature.seedCell],levelsM:[feature.levelM],radiusOfCells:()=>450,maxRadiusM:1000});
        expect(plan.rejected).toBeUndefined();expect(plan.proof.connectedWetCells).toBeGreaterThanOrEqual(100);
        expect(plan.proof.minimumRimM).toBeGreaterThanOrEqual(.5);expect(plan.proof.guaranteedDepthM).toBeGreaterThanOrEqual(1.5);
    });
    it('rejects steep eligible proposals without spending or mutating a feature field',()=>{
        const controls=new Float32Array((cells+3)**2);
        for(let y=0;y<cells+3;y++)for(let x=0;x<cells+3;x++)controls[y*(cells+3)+x]=1000+x*3;
        const copy=controls.slice(),feature=generate(controls);
        expect(feature.rejected).toBe(true);expect(feature.proposals).toHaveLength(9);expect(controls).toEqual(copy);
    });
    it('certifies the 2D potential through the same wet-area/rim contract, with bounded cuts and unchanged exterior',()=>{
        const original=new Float32Array((cells+3)**2);
        for(let y=0;y<cells+3;y++)for(let x=0;x<cells+3;x++)original[y*(cells+3)+x]=1000+x*.003+y*.002;
        const controls=original.slice(),options={controls,cells,frameDir,face,grid,tileX,tileY,
            tangentBasis,planeToDir,dirToFaceUV,planetRadius:131072,radiusM:450,maxCutM:8,depthM:2.5,seed:17,profile:'organic'};
        const feature=regionalDepression(options),repeat=original.slice();
        regionalDepression({...options,controls:repeat});expect(repeat).toEqual(controls);
        expect(feature.rejected).toBeUndefined();expect(feature.proposals).toHaveLength(9);
        let exterior=0;
        for(let i=0;i<controls.length;i++){
            expect(controls[i]).toBeLessThanOrEqual(original[i]);expect(original[i]-controls[i]).toBeLessThanOrEqual(8.001);
            if(controls[i]===original[i])exterior++;
        }
        expect(exterior).toBeGreaterThan(controls.length*.8);
        const plan=planRegionalShapeLake({controls,cells,maxPotentialCells:2048,minWetCells:100,
            candidateSeeds:[feature.seedCell],levelsM:[feature.levelM],radiusOfCells:()=>600,maxRadiusM:1000});
        expect(plan.rejected).toBeUndefined();expect(plan.proof.connectedWetCells).toBeGreaterThanOrEqual(100);
        expect(plan.proof.minimumRimM).toBeGreaterThanOrEqual(.5);expect(plan.proof.guaranteedDepthM).toBeGreaterThanOrEqual(1.5);
    });
});
