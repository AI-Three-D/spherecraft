// A render description of the same bed used by terrain generation. Fits the
// existing R8 mask: 0 outside coverage; 64..127 dry coverage; 128 zero depth;
// 129..255 submerged. The lake record supplies the positive depth range.
// This sampled representation supports coarse shading, not basin certification.
export function encodeLakeSurfaceDepth(depthM,rangeM) {
    return Math.max(64,Math.min(255,128+Math.floor(depthM*127/rangeM)));
}

export function decodeLakeSurfaceDepth(code,rangeM) {
    return (code-128)*rangeM/127;
}

export function resampleLakeSurfaceMask(rec,coverage,size) {
    const {nx,ny}=rec.frame,source=rec.surfaceDepthMask,out=new Uint8Array(size*size);
    if(source.length!==nx*ny||coverage.length!==source.length) throw new Error('Lake surface field/frame mismatch');
    for(let y=0;y<size;y++) {
        const j=Math.min(ny-1,Math.floor((y+.5)*ny/size));
        for(let x=0;x<size;x++) {
            const i=Math.min(nx-1,Math.floor((x+.5)*nx/size)),k=j*nx+i;
            out[y*size+x]=coverage[k]?source[k]:0;
        }
    }
    return out;
}
