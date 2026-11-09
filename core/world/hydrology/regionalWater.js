import { tangentBasis, planeToDir, dirToPlane } from './lakeRefine.js';
import { dirToCell, faceUVToDir } from './waterGraph.js';

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
// The lookup cells (water grid N) a lake's mask has water in: every cell its
// water texels' footprints touch, since the bilinear mask reads water out to
// them. The footprints are split to at most half the smallest cell (0.9 R/N
// at a face corner): a piece touches a cell when one of its corners lies in
// it, or one of the cell's corners lies in the piece (a rotated piece over a
// cell corner); no piece can cross a cell otherwise. Texel centres alone
// left holes in the big lakes, whose texels are wider than a cell (owner
// 2026-11-09, the checkerboard; lakeWaterIndexCheck.mjs). Sorted.
export function lakeMaskCells(frame, mask, radius, N) {
    const { nx, ny, spacing } = frame, owned = new Set();
    const k = Math.max(1, Math.ceil(spacing / (0.45 * radius / N)));
    const water = (i, j) => i >= 0 && j >= 0 && i < nx && j < ny && mask[j * nx + i] !== 0;
    for (let b = 0; b <= ny * k; b++) {
        const j1 = Math.floor(b / k), j0 = Math.ceil(b / k) - 1;
        for (let a = 0; a <= nx * k; a++) {
            const i1 = Math.floor(a / k), i0 = Math.ceil(a / k) - 1;
            if (!(water(i1, j1) || water(i0, j1) || water(i1, j0) || water(i0, j0))) continue;
            owned.add(dirToCell(planeToDir(frame.x0 + a / k * spacing, frame.y0 + b / k * spacing, frame, radius), N));
        }
    }
    // Corners of the cells found, in the water: the cells around them (a
    // piece over a cell corner has its own corners in a cell sharing it).
    const NN = N * N, e = 1e-3, seen = new Set();
    for (const cell of [...owned]) {
        const face = Math.floor(cell / NN), ci = cell % NN % N, cj = Math.floor(cell % NN / N);
        for (let q = 0; q < 4; q++) {
            const vi = ci + (q & 1), vj = cj + (q >> 1), key = (face * (N + 1) + vj) * (N + 1) + vi;
            if (seen.has(key)) continue;
            seen.add(key);
            const d = faceUVToDir(face, vi / N, vj / N);
            if (d[0] * frame.c[0] + d[1] * frame.c[1] + d[2] * frame.c[2] <= 0) continue;
            const [x, y] = dirToPlane(d, frame, radius);
            if (!water(Math.floor((x - frame.x0) / spacing), Math.floor((y - frame.y0) / spacing))) continue;
            for (let r = 0; r < 4; r++) owned.add(dirToCell(faceUVToDir(face, (vi + (r & 1 ? e : -e)) / N, (vj + (r & 2 ? e : -e)) / N), N));
        }
    }
    return Int32Array.from(owned).sort();
}

export function regionalWaterModel(regional, radius, N) {
    const riverRecs=new Map(regional.drainageConfig?.carve&&regional.basins.length?regional.drainagePlan.rivers.map(r=>[r.id,r]):[]);
    const lakes=[], refined=new Map(), cells=[], starts=[0];
    for(const basin of regional.basins) {
        const spacing=basin.frame?.spacing??basin.radiusM/16,nx=basin.frame?.nx??32,ny=basin.frame?.ny??32;
        const frame=basin.frame??{c:basin.centre,...tangentBasis(basin.centre),x0:-basin.radiusM,y0:-basin.radiusM,spacing,nx,ny};
        let mask=basin.mask;
        if(!mask) {
            mask=new Uint8Array(nx*ny);
            for(let j=0;j<ny;j++) for(let i=0;i<nx;i++) {
                if(Math.hypot(frame.x0+(i+.5)*spacing,frame.y0+(j+.5)*spacing)<=basin.radiusM) mask[j*nx+i]=2;
            }
        }
        // basin.maskCells: the caller's (lakeMaskCells at this N), kept per lake.
        const maskCells=basin.maskCells??lakeMaskCells(frame,mask,radius,N);
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
