import { tangentBasis, planeToDir } from './lakeRefine.js';
import { dirToCell } from './waterGraph.js';

// This grid is a lookup index, not terrain or lake-mask resolution. At most
// two immutable lakes cannot overflow its two slots, even in the same cell.
// Networks keep the resolution of their already generated segment indices;
// larger publications retain the existing policy until collision-aware sizing.
export function regionalWaterGridN(regional,N,minimumN=64) {
    if(!Number.isInteger(minimumN)||minimumN<16||minimumN>512||(minimumN&(minimumN-1))) {
        throw new Error('Structured lake lookup grid must be a power of two from 16 to 512');
    }
    const rivers=regional.drainageConfig?.carve&&regional.basins.length?regional.drainagePlan.rivers:[];
    return regional.basins.length<=2&&!rivers.length?Math.min(N,minimumN):N;
}

// Coarse constructed features already have their level and basin certificates.
// Channels intentionally open the certified annuli at the connecting mouths;
// `closed` below means no outgoing connection, not an uncut enclosing rim.
// Publish the same records through the existing water interface without a
// full-world height search or fine flood fill. Terrain depth hides dry banks.
export function regionalWaterModel(regional, radius, N) {
    const riverRecs=new Map(regional.drainageConfig?.carve&&regional.basins.length?regional.drainagePlan.rivers.map(r=>[r.id,r]):[]);
    const lakes=[], refined=new Map(), cells=[], starts=[0];
    for(const basin of regional.basins) {
        const spacing=basin.frame?.spacing??basin.radiusM/16,nx=basin.frame?.nx??32,ny=basin.frame?.ny??32;
        const frame=basin.frame??{c:basin.centre,...tangentBasis(basin.centre),x0:-basin.radiusM,y0:-basin.radiusM,spacing,nx,ny};
        const mask=basin.mask??new Uint8Array(nx*ny), owned=new Set();
        for(let j=0;j<ny;j++) for(let i=0;i<nx;i++) {
            const x=frame.x0+(i+.5)*spacing,y=frame.y0+(j+.5)*spacing;
            if(!basin.mask&&Math.hypot(x,y)<=basin.radiusM) mask[j*nx+i]=2;
            if(!basin.mask||mask[j*nx+i]) owned.add(dirToCell(planeToDir(x,y,frame,radius),N));
        }
        const maskCells=Int32Array.from(owned).sort();
        lakes.push({id:basin.id,level:basin.levelM,centreDir:basin.centre,frame,closed:![...riverRecs.values()].some(r=>r.fromLake===basin.id),regionalSourceKey:regional.sourceKey});
        refined.set(basin.id,{level:basin.levelM,frame,mask,maskCells,merged:[],structured:true,
            surfaceDepthMask:basin.surfaceDepthMask,surfaceDepthRangeM:basin.surfaceDepthRangeM??0});
        cells.push(...maskCells);starts.push(cells.length);
    }
    const riverOf=new Int32Array(6*N*N).fill(-1),rivers=[];
    for(const rec of riverRecs.values()) {
        if(rec.gridN!==N) throw new Error('Regional river index resolution must match water publication');
        rivers.push({id:rec.id,fromLake:rec.fromLake,dest:rec.dest,cells:rec.cells});
        for(const cell of rec.cells) riverOf[cell]=rec.id;
    }
    return {N,lakes,refined,rivers,riverRecs,lakeCells:Int32Array.from(cells),lakeCellStart:Int32Array.from(starts),riverOf,lakeOf:null,
        stats:{structured:true,basins:lakes.length,rivers:rivers.length,regionalSourceKey:regional.sourceKey}};
}
