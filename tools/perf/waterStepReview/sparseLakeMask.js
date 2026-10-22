// Lossless lake-only encoding: constant 64 m pages are implicit; mixed pages
// store 4 m cell states/pointers. Refined 0.5 m states use two bits each.
// No resampling, dilation, connectivity or level changes occur here.
export function packSparseLakeMask(source) {
    const nx=source[15],ny=source[16],n=source[18],pageSize=16,px=Math.ceil(nx/pageSize),py=Math.ceil(ny/pageSize);
    const words=Array(20+px*py).fill(0);let mixedPages=0,refinedCells=0;
    const state=r=>{const v=source[4*(5+r)];if(v!==0&&v!==1&&v!==2)throw new Error('Sparse lake mask cannot encode river ownership');return v;};
    for(let y=0;y<py;y++)for(let x=0;x<px;x++) {
        const cells=[];
        for(let j=0;j<pageSize;j++)for(let i=0;i<pageSize;i++) {
            const xx=x*pageSize+i,yy=y*pageSize+j;
            if(xx>=nx||yy>=ny){cells.push(0);continue;}
            const r=yy*nx+xx,refine=source[4*(5+r)+3];
            if(!refine){cells.push(state(r));continue;}
            const start=words.length;refinedCells++;
            for(let k=0;k<n*n;k+=16) {
                let w=0;for(let b=0;b<16&&k+b<n*n;b++)w|=state(refine+k+b)<<(2*b);
                words.push(w>>>0);
            }
            cells.push((start*4+3)>>>0);
        }
        const uniform=cells[0]<3&&cells.every(v=>v===cells[0]);
        words[20+y*px+x]=uniform?cells[0]:words.length*4+3;
        if(!uniform){words.push(...cells);mixedPages++;}
    }
    while(words.length%4)words.push(0);
    const data=new Float32Array(words.length);new Uint32Array(data.buffer).set(words);data.set(source.subarray(0,20));data[19]=px;
    // Exhaustive unique-state comparison. A uniform 4 m cell needs one check;
    // every 0.5 m entry of every refined cell is checked separately.
    let checked=0,mismatches=0;
    for(let y=0;y<ny;y++)for(let x=0;x<nx;x++) {
        const r=y*nx+x,refine=source[4*(5+r)+3],count=refine?n*n:1;
        for(let k=0;k<count;k++) {
            const actual=readSparseLakeMask(data,x,y,refine?k%n:0,refine?Math.floor(k/n):0);
            checked++;if(actual!==state(refine?refine+k:r))mismatches++;
        }
    }
    if(mismatches)throw new Error(`Sparse lake encoding lost ${mismatches} states`);
    return {data,stats:{bytes:data.byteLength,denseBytes:source.byteLength,pageSizeM:source[14]*pageSize,
        directoryPages:px*py,mixedPages,implicitPages:px*py-mixedPages,refinedCells,checked,mismatches}};
}

export function readSparseLakeMask(data,x,y,sx=0,sy=0) {
    if(x<0||y<0||x>=data[15]||y>=data[16])return 0;
    const u=new Uint32Array(data.buffer,data.byteOffset,data.length),px=data[19];
    let v=u[20+Math.floor(y/16)*px+Math.floor(x/16)];if((v&3)!==3)return v;
    v=u[(v>>>2)+(y%16)*16+x%16];if((v&3)!==3)return v;
    const k=sy*data[18]+sx;return (u[(v>>>2)+(k>>>4)]>>>(2*(k&15)))&3;
}

export function sparseLakeWgsl(group,binding) {return `
@group(${group}) @binding(${binding}) var<storage,read> connectedPatch:array<vec4<f32>>;
fn lakeMaskWord(i:u32)->u32 {return bitcast<u32>(connectedPatch[i>>2u][i&3u]);}
fn connectedCoverage(dir:vec3<f32>)->i32 {
    let k=dot(dir,connectedPatch[0].xyz);if(k<=0.0){return 0;}
    let p=vec2<f32>(dot(dir,connectedPatch[1].xyz),dot(dir,connectedPatch[2].xyz))/k*connectedPatch[0].w;
    let g=(p-connectedPatch[3].xy)/connectedPatch[3].z;let ij=vec2<i32>(floor(g));
    if(any(ij<vec2<i32>(0))||ij.x>=i32(connectedPatch[3].w)||ij.y>=i32(connectedPatch[4].x)){return 0;}
    let xy=vec2<u32>(ij);
    var v=lakeMaskWord(20u+(xy.y/16u)*u32(connectedPatch[4].w)+xy.x/16u);
    if((v&3u)==3u) {
        v=lakeMaskWord((v>>2u)+(xy.y&15u)*16u+(xy.x&15u));
        if((v&3u)==3u) {
            let n=u32(connectedPatch[4].z);let uv=min(vec2<u32>(fract(g)*f32(n)),vec2<u32>(n-1u));let s=uv.y*n+uv.x;
            v=(lakeMaskWord((v>>2u)+(s>>4u))>>(2u*(s&15u)))&3u;
        }
    }
    if(v==0u){return 0;}if(v==2u){return 1;}return -1;
}
`;}
