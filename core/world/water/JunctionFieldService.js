import { Logger } from '../../../shared/Logger.js';
import { cellDir,dirToCell } from '../hydrology/waterGraph.js';
import { planeToDir } from '../hydrology/lakeRefine.js';
import { buildJunctionField } from './buildJunctionField.js';
import { clusterJunctionSites,junctionSites,junctionTouchesBasin,JUNCTION_FIELDS_DEFAULTS } from './junctionFieldClusters.js';
import { JUNCTION_FIELD_CAPACITY } from './junctionFieldStore.js';

const frameDistance=(frame,dir,R)=>Math.max(0,Math.hypot(...dir.map((v,i)=>v-frame.c[i]))*R-
    Math.hypot(frame.width,frame.height)*frame.spacingM*.5);

export class JunctionFieldService {
    constructor({water,service,terrainGenerator,config={},onChanged,yieldBetween}) {
        this.water=water;this.service=service;this.generator=terrainGenerator;
        this.config={...JUNCTION_FIELDS_DEFAULTS,...config};this.onChanged=onChanged;this.yieldBetween=yieldBetween;
        this.store=terrainGenerator.junctionFields;this.cache=new Map();this.failed=new Map();
        this.clusters=[];this.revision=-1;this.generation=0;this.busy=false;this.isIdle=false;this.disposed=false;
        this.cameraDir=[1,0,0];this._published=[];
    }
    _rebuild() {
        const w=this.water,svc=this.service;
        const sites=junctionSites(w._appliedRivers,rec=>w._arcLengths(rec))
            .map(s=>({...s,lakeId:svc.rep?.(s.lakeId)??s.lakeId}))
            .filter(s=>junctionTouchesBasin(s,w._applied.get(s.lakeId),w.R,this.config.paddingM));
        this.clusters=clusterJunctionSites(sites,w.R,this.config);
        this.revision=w._appliedVersion;this.generation++;this.failed.clear();
        const byKey=new Map(this.clusters.map(c=>[c.key,c]));
        for(const [key,entry]of this.cache) {
            const cluster=byKey.get(key);
            if(!cluster||!this._matches(entry,cluster))this.cache.delete(key);
        }
        this._publish();
    }
    _matches(entry,cluster) {
        return cluster.sites.every(s=>entry.records.has(s.rec))&&
            cluster.lakeIds.every(id=>entry.lakes.get(id)===this.water._applied.get(id));
    }
    update(cameraRel) {
        if(this.disposed)return;
        const w=this.water,cfg=this.config,len=Math.hypot(cameraRel.x,cameraRel.y,cameraRel.z);
        this.cameraDir=[cameraRel.x/len,cameraRel.y/len,cameraRel.z/len];
        if(w._appliedVersion!==this.revision)this._rebuild();
        if(!this._selectionAt||Math.hypot(...this.cameraDir.map((v,i)=>v-this._selectionAt[i]))*w.R>64) {
            this._selectionAt=[...this.cameraDir];this._publish();
        }
        if(!cfg.enabled||len-w.R>cfg.maxAltitudeM||!w._ready||!this.service._sampler){this.isIdle=!this.busy;return;}
        if(this.busy){this.isIdle=false;return;}
        const candidates=this.clusters.filter(c=>!this.cache.has(c.key)&&!this.failed.has(c.key)&&
            c.lakeIds.every(id=>this.water._applied.has(id)))
            .map(cluster=>({cluster,distance:frameDistance(cluster.frame,this.cameraDir,w.R)}))
            .filter(c=>c.distance<cfg.radiusM).sort((a,b)=>a.distance-b.distance);
        this.isIdle=candidates.length===0;
        if(candidates.length)void this._build(candidates[0].cluster);
    }
    // Each batch waits for a frame and a readback (about 40 ms): 4096 per
    // batch spent 0.8-2.6 s of a field's bake there (2026-11-01).
    async _samples(fn,dirs) {
        const result=new Float32Array(dirs.length/4),count=8192;
        for(let i=0;i<result.length;i+=count) {
            if(this.disposed)throw new Error('Junction service disposed');
            const sample=await fn(dirs.subarray(i*4,Math.min(result.length,i+count)*4));
            if(!sample)throw new Error('Junction source terrain unavailable');
            result.set(sample,i);await this.yieldBetween?.();
        }
        return result;
    }
    async _build(cluster) {
        this.busy=true;this.isIdle=false;
        const generation=this.generation,w=this.water,cfg=this.config,start=performance.now();
        try {
            const sampler=this.service._sampler;
            const basins=cluster.lakeIds.map(id=>{
                const indexed=this.service.lakes[id];
                const lake=indexed?.id===id?indexed:this.service.lakes.find(l=>l.id===id);
                const record=w._applied.get(id);
                return {id,record,levelM:record.level,
                    seedDir:lake?.deepestDir??(Number.isInteger(lake?.deepestCell)?cellDir(lake.deepestCell,w.N):record.frame.c)};
            });
            const field=await buildJunctionField({device:w.device,resources:w.resources,sampler:this.generator._lakeMaskSampler,
                radiusM:w.R,frame:cluster.frame,lakeId:basins[0].id,referenceLevelM:basins[0].levelM,
                lakeBasin:basins[0].record,basins,blendRadiusM:cfg.blendRadiusM,
                influenceSites:cluster.sites.map(s=>s.dir),
                influenceCoreM:cfg.influenceCoreM,influenceFadeM:cfg.influenceFadeM,
                sampleNatural:dirs=>this._samples(sampler.sampleDirsNatural,dirs),
                sampleCarved:dirs=>this._samples(sampler.sampleDirsCarvedOriginal,dirs),
                yieldBetween:this.yieldBetween,
                solveOptions:{iterations:cfg.iterations,bedScreening:cfg.bedScreening,bankCollarM:cfg.bankCollarM}});
            if(this.disposed||generation!==this.generation)return;
            if(!field.converged)throw new Error(`Junction solve did not converge (${field.residualM})`);
            const compact={key:cluster.key,lakeId:field.lakeId,frame:field.frame,width:field.width,height:field.height,field:field.field};
            this.cache.set(cluster.key,{field:compact,records:new Set(cluster.sites.map(s=>s.rec)),
                lakes:new Map(basins.map(b=>[b.id,b.record])),ms:performance.now()-start,timing:field.timing,iterations:field.iterations});
            this._publish();
            Logger.debug(`[Water] junction ${cluster.key}: ${field.width}x${field.height}, ${field.iterations} iterations`);
        } catch(error) {
            if(!this.disposed&&generation===this.generation){this.failed.set(cluster.key,String(error));Logger.warn(`[Water] junction ${cluster.key}: ${error}`);}
        } finally {this.busy=false;}
    }
    _publish() {
        const cfg=this.config,R=this.water.R;
        const ranked=[...this.cache.values()].sort((a,b)=>frameDistance(a.field.frame,this.cameraDir,R)-frameDistance(b.field.frame,this.cameraDir,R));
        const selected=ranked.slice(0,Math.min(JUNCTION_FIELD_CAPACITY,cfg.maxFields)).map(e=>e.field).sort((a,b)=>a.key.localeCompare(b.key));
        for(const entry of ranked.slice(cfg.maxCachedFields))this.cache.delete(entry.field.key);
        if(selected.length===this._published.length&&selected.every((f,i)=>f===this._published[i]))return;
        const old=new Set(this._published),next=new Set(selected),changed=[...this._published.filter(f=>!next.has(f)),...selected.filter(f=>!old.has(f))];
        this.store.publish(selected);this._published=selected;
        const cells=new Set(),step=R/this.water.N*.25;
        for(const field of changed) {
            const F=field.frame,endX=F.x0+(F.width-1)*F.spacingM,endY=F.y0+(F.height-1)*F.spacingM;
            const nx=Math.max(1,Math.ceil((endX-F.x0)/step)),ny=Math.max(1,Math.ceil((endY-F.y0)/step));
            for(let y=0;y<=ny;y++)for(let x=0;x<=nx;x++)cells.add(dirToCell(planeToDir(
                F.x0+(endX-F.x0)*x/nx,F.y0+(endY-F.y0)*y/ny,F,R),this.water.N));
        }
        this.onChanged?.(cells);
    }
    summary() {return {busy:this.busy,idle:this.isIdle,clusters:this.clusters.length,cached:this.cache.size,
        published:this.store.fields.length,failed:[...this.failed]};}
    dispose() {this.disposed=true;this.generation++;this.cache.clear();this.store.clear();this.store.afterSubmit();}
}
