// Read only the required controls from generation-owned regional textures.
// The returned dense array omits WebGPU row padding and owns no GPU resources.
export async function readRegionalField(device, texture, {width,height=width,channels,layers=6,origin=[0,0,0]}) {
    if(![width,height,layers].every(v=>Number.isInteger(v)&&v>0)||![1,4].includes(channels)
        ||origin.length!==3||!origin.every(v=>Number.isInteger(v)&&v>=0)) throw new Error('Invalid regional field readback');
    const row=Math.ceil(width*channels*4/256)*256,copyBytes=row*height*layers;
    const buffer=device.createBuffer({size:copyBytes,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    try {
        const encoder=device.createCommandEncoder();
        encoder.copyTextureToBuffer({texture,origin},{buffer,bytesPerRow:row,rowsPerImage:height},[width,height,layers]);
        device.queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ);
        const values=new Float32Array(width*height*channels*layers),mapped=new Float32Array(buffer.getMappedRange());
        for(let j=0;j<height*layers;j++)values.set(mapped.subarray(j*row/4,j*row/4+width*channels),j*width*channels);
        return {values,copyBytes};
    } finally {
        if(buffer.mapState==='mapped')buffer.unmap();
        buffer.destroy();
    }
}
