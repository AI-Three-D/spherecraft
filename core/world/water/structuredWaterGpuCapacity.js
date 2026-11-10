import {RIVER_SUB} from './waterWgsl.js';

export const WATER_GPU_CAPACITY_DEFAULTS=Object.freeze({maxLakes:8192,maskLayerSize:512,maxMaskLayers:96,
    maxRiverSegs:262144,maxRiverCells:65536,maxValleyPages:3072});
export const STRUCTURED_WATER_GPU_LIMITS=Object.freeze({...WATER_GPU_CAPACITY_DEFAULTS,maxMaskLayers:4096,maxRiverSegs:1048576});

// Structured records are immutable for a published terrain generation. Size
// their pools once; a changed generation replaces resources. Legacy services
// can grow/refine asynchronously and retain the existing capacity policy.
export function structuredWaterGpuCapacity(service,limits=STRUCTURED_WATER_GPU_LIMITS) {
    if(service.stats?.structured!==true) return {};
    const records=[...service.riverRecs.values()],riverCells=new Set();
    let segments=0,slots=1,maskSize=32;
    for(const r of records) {
        segments+=r.segCells.length;
        for(const id of r.segCells) riverCells.add(Math.floor(id/(RIVER_SUB*RIVER_SUB)));
    }
    for(const l of service.lakes) {
        slots=Math.max(slots,l.id+1);
        const frame=service.refined.get(l.id)?.frame??l.frame;
        maskSize=Math.max(maskSize,frame.nx,frame.ny);
    }
    if(slots>limits.maxLakes||service.lakes.length>limits.maxMaskLayers||segments>limits.maxRiverSegs||riverCells.size>limits.maxRiverCells)
        throw new Error('Structured water population exceeds GPU publication capacity');
    return {maxLakes:Math.min(slots,limits.maxLakes),maxMaskLayers:Math.max(1,Math.min(service.lakes.length,limits.maxMaskLayers)),
        ...(service.lakes.length>96?{maskTilesPerAxis:4}:{}),
        maskLayerSize:Math.min(2**Math.ceil(Math.log2(maskSize)),limits.maskLayerSize),
        maxRiverSegs:Math.max(1,Math.min(segments,limits.maxRiverSegs)),maxRiverCells:Math.max(1,Math.min(riverCells.size,limits.maxRiverCells)),
        // Structured terrain owns its bed; this service never bakes legacy
        // valley pages. No duplicate terrain representation is needed.
        valley:null};
}
