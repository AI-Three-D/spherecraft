export function junctionStatus() {
    const g=window.gameEngine,store=g.terrainGenerator.junctionFields;
    return {service:g.junctionFieldService?.summary(),version:store?.version,
        fields:store?.fields.map(f=>({key:f.key,lakeId:f.lakeId,width:f.width,height:f.height,spacingM:f.frame.spacingM})),
        gpuErrors:window.__lr?.gpuErrors};
}
