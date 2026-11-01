export function junctionStatus() {
    const g=window.gameEngine,store=g.terrainGenerator.junctionFields;
    return {service:g.junctionFieldService?.summary(),version:store?.version,
        fields:store?.fields.map(f=>({key:f.key,lakeId:f.lakeId,width:f.width,height:f.height,spacingM:f.frame.spacingM})),
        gpuErrors:window.__lr?.gpuErrors};
}

// Bake cost per cached junction field (ms from first terrain sample to publish).
export function junctionBakeTimes() {
    const s=window.gameEngine.junctionFieldService;
    return {clusters:s?.clusters.length,failed:s?[...s.failed]:null,
        fields:s?[...s.cache.entries()].map(([key,e])=>({key,ms:Math.round(e.ms),cells:e.field.width*e.field.height})):null};
}
