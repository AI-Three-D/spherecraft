import { tangentBasis,dirToPlane,planeToDir } from '../hydrology/lakeRefine.js';
import { riverMouths } from './riverMouth.js';

export const JUNCTION_FIELDS_DEFAULTS=Object.freeze({
    enabled:true,radiusM:1800,paddingM:192,spacingM:2,maxGridSide:513,
    blendRadiusM:64,bankCollarM:40,bedScreening:.04,iterations:6000,
    influenceCoreM:128,influenceFadeM:48,
    maxFields:16,maxCachedFields:32,maxAltitudeM:2000,
});
const normalize=v=>{const n=Math.hypot(...v);return v.map(x=>x/n);};
const distance=(a,b)=>Math.hypot(...a.map((v,j)=>v-b[j]));

// Traces can stop at another river before their nominal downstream lake.
// Such an endpoint is not a lake boundary condition for a local junction.
export function junctionTouchesBasin(site,record,radiusM,reachM) {
    if(!record?.frame||Math.abs(site.levelM-record.level)>.05)return false;
    const F=record.frame,k=site.dir.reduce((sum,v,i)=>sum+v*F.c[i],0);
    if(k<=0)return false;
    const [x,y]=dirToPlane(site.dir,F,radiusM);
    const dx=Math.max(0,F.x0-x,x-F.x0-F.nx*F.spacing);
    const dy=Math.max(0,F.y0-y,y-F.y0-F.ny*F.spacing);
    return Math.hypot(dx,dy)<=reachM;
}

export function junctionSites(rivers,arcOf) {
    const sites=[];
    for(const [riverId,rec] of rivers) {
        const arc=arcOf(rec),P=rec.points,st=rec.stride;
        for(const m of riverMouths(rec,arc)) {
            let k=0;while(k+2<arc.length&&arc[k+1]<m.s)k++;
            const t=(m.s-arc[k])/Math.max(.001,arc[k+1]-arc[k]);
            const dir=normalize([0,1,2].map(j=>P[k*st+j]+(P[(k+1)*st+j]-P[k*st+j])*t));
            const lakeId=m.sign<0?rec.src:rec.dest.id;
            sites.push({key:`${riverId}:${m.sign}`,riverId,lakeId,levelM:m.level,sign:m.sign,dir,rec});
        }
    }
    return sites;
}

export function junctionClusterFrame(sites,radiusM,options={}) {
    const cfg={...JUNCTION_FIELDS_DEFAULTS,...options};
    const c=normalize([0,1,2].map(j=>sites.reduce((sum,s)=>sum+s.dir[j],0))),basis={c,...tangentBasis(c)};
    const points=sites.map(s=>dirToPlane(s.dir,basis,radiusM));
    const lo=[0,1].map(j=>Math.min(...points.map(p=>p[j]))-cfg.paddingM);
    const hi=[0,1].map(j=>Math.max(...points.map(p=>p[j]))+cfg.paddingM);
    let spacingM=cfg.spacingM;
    while(Math.max(...hi.map((v,j)=>Math.ceil((v-lo[j])/spacingM)+2))>cfg.maxGridSide)spacingM*=2;
    const [x0,y0]=lo.map(v=>Math.floor(v/spacingM)*spacingM);
    const width=1+Math.ceil((hi[0]-x0)/spacingM),height=1+Math.ceil((hi[1]-y0)/spacingM);
    return {...basis,x0,y0,width,height,spacingM};
}

function frameCorners(frame,radiusM) {
    return [[0,0],[1,0],[1,1],[0,1]].map(([x,y])=>planeToDir(
        frame.x0+x*(frame.width-1)*frame.spacingM,frame.y0+y*(frame.height-1)*frame.spacingM,frame,radiusM));
}

export function junctionFramesOverlap(a,b,radiusM) {
    if(distance(a.c,b.c)*radiusM>Math.hypot(a.width,a.height)*a.spacingM+Math.hypot(b.width,b.height)*b.spacingM)return false;
    const A=frameCorners(a,radiusM).map(d=>dirToPlane(d,a,radiusM));
    const B=frameCorners(b,radiusM).map(d=>dirToPlane(d,a,radiusM));
    for(const polygon of [A,B])for(let i=0;i<4;i++) {
        const p=polygon[i],q=polygon[(i+1)%4],axis=[p[1]-q[1],q[0]-p[0]];
        const range=poly=>poly.map(v=>v[0]*axis[0]+v[1]*axis[1]);
        const aa=range(A),bb=range(B);
        if(Math.max(...aa)<=Math.min(...bb)+.001||Math.max(...bb)<=Math.min(...aa)+.001)return false;
    }
    return true;
}

// Spatial hashing limits comparisons to nearby patches. A second merge pass
// accounts for bounding boxes grown by an earlier merge, keeping final fields
// disjoint even around a lake with several inlets and outlets.
export function clusterJunctionSites(sites,radiusM,options={}) {
    const cfg={...JUNCTION_FIELDS_DEFAULTS,...options},bin=cfg.paddingM*4;
    let clusters=sites.map(site=>({sites:[site],frame:junctionClusterFrame([site],radiusM,cfg)}));
    for(;;) {
        const parent=clusters.map((_,i)=>i),buckets=new Map();let merged=false;
        const root=i=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
        for(let i=0;i<clusters.length;i++) {
            const frame=clusters[i].frame,center=frame.c.map(v=>v*radiusM);
            const reach=Math.hypot(frame.width,frame.height)*frame.spacingM*.55;
            const lo=center.map(v=>Math.floor((v-reach)/bin)),hi=center.map(v=>Math.floor((v+reach)/bin));
            const seen=new Set();
            for(let z=lo[2];z<=hi[2];z++)for(let y=lo[1];y<=hi[1];y++)for(let x=lo[0];x<=hi[0];x++) {
                const key=`${x},${y},${z}`,list=buckets.get(key)??[];
                for(const j of list)if(!seen.has(j)) {
                    seen.add(j);
                    if(root(i)!==root(j)&&junctionFramesOverlap(frame,clusters[j].frame,radiusM)){
                        parent[root(i)]=root(j);merged=true;
                    }
                }
                list.push(i);buckets.set(key,list);
            }
        }
        if(!merged)break;
        const groups=new Map();
        for(let i=0;i<clusters.length;i++) {
            const k=root(i);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(...clusters[i].sites);
        }
        clusters=[...groups.values()].map(group=>({sites:group,frame:junctionClusterFrame(group,radiusM,cfg)}));
    }
    return clusters.map(c=>({...c,key:c.sites.map(s=>s.key).sort().join('|'),lakeIds:[...new Set(c.sites.map(s=>s.lakeId))]}));
}
