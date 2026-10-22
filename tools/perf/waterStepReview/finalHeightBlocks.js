// Active renderer mapping: normalized UV spans texels 0 through N-1.
export function finalHeightGrid(heights,n,heightScale) {
    const at=(x,y)=>heights[Math.min(n-1,y)*n+Math.min(n-1,x)]*heightScale,out=new Float64Array((n+1)**2);
    for(let j=0;j<=n;j++)for(let i=0;i<=n;i++) {
        const u=i*(n-1)/n,v=j*(n-1)/n,x=Math.floor(u),y=Math.floor(v),a=u-x,b=v-y;
        out[j*(n+1)+i]=(at(x,y)*(1-a)+at(x+1,y)*a)*(1-b)+(at(x,y+1)*(1-a)+at(x+1,y+1)*a)*b;
    }return out;
}

export function heightBlocks(grid,n,level,emit,{include=()=>true,guardM=.1}={}) {
    function visit(i,j,size) {
        if(!include(i,j,size))return;
        let min=Infinity,max=-Infinity;
        for(let y=j;y<=j+size;y++)for(let x=i;x<=i+size;x++){const h=grid[y*(n+1)+x];min=Math.min(min,h);max=Math.max(max,h);}
        if(size>1&&!(max<level-guardM||min>level+guardM)) {
            const half=size/2;for(const dy of[0,half])for(const dx of[0,half])visit(i+dx,j+dy,half);return;
        }emit(i,j,size);
    }visit(0,0,n);
}
