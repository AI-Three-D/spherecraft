import { connectedBasinDistance, junctionWetUnion, solveJunctionField } from './junctionField.js';
import { lakeMaskSdf } from './lakeMaskSdf.js';

const clamp01 = x => Math.max(0,Math.min(1,x));
const smooth = x => {const t=clamp01(x);return t*t*(3-2*t);};
const basinFields=new WeakMap();

function originalBasinMembership(lake,dirs,radiusM) {
    if(!lake?.mask||!lake.frame)throw new Error('Junction field requires the original solved lake basin');
    let sdf=basinFields.get(lake);
    const f=lake.frame;
    if(!sdf){sdf=lakeMaskSdf(lake.mask,f.nx,f.ny,f.spacing);basinFields.set(lake,sdf);}
    const dot=(o,v)=>dirs[o]*v[0]+dirs[o+1]*v[1]+dirs[o+2]*v[2];
    return Uint8Array.from({length:dirs.length/4},(_,i)=>{
        const o=4*i,k=dot(o,f.c);if(k<=0)return 0;
        const x=(radiusM*dot(o,f.e1)/k-f.x0)/f.spacing-.5;
        const y=(radiusM*dot(o,f.e2)/k-f.y0)/f.spacing-.5;
        if(x<0||y<0||x>=f.nx-1||y>=f.ny-1)return 0;
        const ix=Math.floor(x),iy=Math.floor(y),tx=x-ix,ty=y-iy,j=iy*f.nx+ix;
        const a=sdf[j]*(1-tx)+sdf[j+1]*tx,b=sdf[j+f.nx]*(1-tx)+sdf[j+f.nx+1]*tx;
        return a*(1-ty)+b*ty>0?1:0;
    });
}

export function bakeJunctionSamples({frame,radiusM,natural,oldBed,dirs,data,lakeBasin,basins=null,influenceSites=null,influenceCoreM=128,influenceFadeM=48,referenceLevelM,lakewardSign,blendRadiusM,solveOptions}) {
    const {width,height,spacingM,x0}=frame,n=width*height;
    const levelGuide=new Float64Array(n),bedGuide=new Float64Array(n),wetDistance=new Float64Array(n);
    const fixedLevel=new Uint8Array(n),fixedBed=new Uint8Array(n);
    const descriptors=basins??[{record:lakeBasin,levelM:referenceLevelM}];
    const basin={distance:new Float64Array(n).fill(-1e20),wet:new Uint8Array(n),level:new Float64Array(n)};
    for(const descriptor of descriptors) {
        const allowed=originalBasinMembership(descriptor.record,dirs,radiusM),seeds=new Uint8Array(n);
        const preferred=descriptor.seedDir?.length===3&&Array.from(descriptor.seedDir).every(Number.isFinite)?descriptor.seedDir:null;
        let seed=-1,best=-Infinity;
        for(let i=0;i<n;i++) {
            if(!allowed[i]||natural[i]>=descriptor.levelM)continue;
            let score=-natural[i];
            if(preferred)score=dirs[4*i]*preferred[0]+dirs[4*i+1]*preferred[1]+dirs[4*i+2]*preferred[2];
            else if((x0+(i%width)*spacingM)*(lakewardSign??-1)<=32)score-=1e6;
            if(score>best){best=score;seed=i;}
        }
        if(seed<0) {
            let count=0,min=Infinity;for(let i=0;i<n;i++)if(allowed[i]){count++;min=Math.min(min,natural[i]);}
            throw new Error(`Junction lake ${descriptor.id??'?'} has no connected submerged seed (allowed=${count}, min=${min}, level=${descriptor.levelM})`);
        }
        seeds[seed]=1;
        const layer=connectedBasinDistance({width,height,spacingM,natural,levelM:descriptor.levelM,seeds,allowed});
        for(let i=0;i<n;i++) {
            const both=layer.wet[i]&&basin.wet[i];
            const replace=both&&descriptor.levelM!==basin.level[i]?descriptor.levelM>basin.level[i]:layer.distance[i]>basin.distance[i];
            if(replace){basin.distance[i]=layer.distance[i];basin.wet[i]=layer.wet[i];basin.level[i]=descriptor.levelM;}
        }
    }
    for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
        const i=y*width+x,o=8*i,eta=data[o],depth=data[o+1],rd=data[o+2],le=basin.level[i],ld=basin.distance[i];
        const known=data[o+5]>.5,guard=x<2||y<2||x>=width-2||y>=height-2;
        const wet=junctionWetUnion(rd,ld,blendRadiusM),lakeWeight=smooth(.5+(ld-rd)/(2*blendRadiusM));
        levelGuide[i]=known?eta+(le-eta)*lakeWeight:le;
        if(basin.wet[i])levelGuide[i]=le;
        wetDistance[i]=wet;
        const halfWidth=data[o+6];
        const toe=smooth(wet/Math.max(1,Math.min(halfWidth*.5,blendRadiusM*.2)));
        // Preserve the submerged throat while its sediment fan disperses
        // into the basin. Mixing directly to the natural shelf at the union
        // corner filled the outlet before it reached deeper lake ground.
        const fan=1-smooth(Math.max(0,ld)/blendRadiusM);
        const guideBed=levelGuide[i]-depth*toe*fan;
        bedGuide[i]=guard?oldBed[i]:!known?natural[i]:Math.min(natural[i],guideBed);
        if(!guard&&known&&wet<=0) {
            const rise=Math.max(0,natural[i]-levelGuide[i]);
            const bankWidthM=Math.max(8,Math.min(40,6+rise/.7));
            const bank=levelGuide[i]+rise*smooth(-wet/bankWidthM);
            bedGuide[i]=Math.min(natural[i],bank);
        }
        if(!guard&&known&&ld<0) {
            const approach=smooth((ld+blendRadiusM)/(.8*blendRadiusM));
            bedGuide[i]=oldBed[i]+(bedGuide[i]-oldBed[i])*approach;
        }
        fixedLevel[i]=guard||basin.wet[i]||!known||ld>blendRadiusM||ld<-blendRadiusM?1:0;
        fixedBed[i]=guard||!known||ld>blendRadiusM?1:0;
        if(known&&ld<-blendRadiusM){bedGuide[i]=oldBed[i];fixedBed[i]=1;}
    }
    const solved=solveJunctionField({width,height,spacingM,natural,levelGuide,bedGuide,wetDistance,fixedLevel,fixedBed,options:{bankCollarM:40,...solveOptions}});
    // Generation consumes the first two channels. Surface rendering also
    // needs the connected basin distance to select a single lake owner.
    for(let i=0;i<n;i++) {
        let influence=1;
        if(influenceSites?.length) {
            let nearest=Infinity;
            for(const site of influenceSites)nearest=Math.min(nearest,Math.hypot(dirs[4*i]-site[0],dirs[4*i+1]-site[1],dirs[4*i+2]-site[2])*radiusM);
            influence=1-smooth((nearest-influenceCoreM)/Math.max(.001,influenceFadeM));
        }
        solved.field[4*i+2]=influence;solved.field[4*i+3]=basin.distance[i];
    }
    return {...solved,frame,natural,oldBed,levelGuide,bedGuide,fixedLevel,fixedBed,basinDistance:basin.distance};
}
