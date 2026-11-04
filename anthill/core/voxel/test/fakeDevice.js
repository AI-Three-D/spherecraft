export function fakeDevice() {
    const writes = [];
    const buffers = [];
    const copies = [];
    return {
        createCommandEncoder() {
            const commands = [];
            return {copyBufferToBuffer(source,sourceOffset,target,targetOffset,size) {
                commands.push(()=>{
                    target.data.set(source.data.subarray(sourceOffset,sourceOffset+size),targetOffset);
                    copies.push({source,target,size});
                });
            },finish(){return commands;}};
        },
        createShaderModule: descriptor => descriptor,
        createComputePipeline: descriptor => ({...descriptor,getBindGroupLayout:()=>({})}),
        createRenderPipeline: descriptor => ({...descriptor,getBindGroupLayout:()=>({})}),
        createBindGroup: descriptor => descriptor,
        createTexture: descriptor => ({...descriptor,destroyed:false,createView(){return {_isGPUTextureView:true,view:this};},destroy(){this.destroyed=true;}}),
        limits: { maxStorageBufferBindingSize: 128 * 1024 * 1024 }, writes, buffers, copies,
        createBuffer({ size, label }) {
            const buffer = { data: new Uint8Array(size), label, destroyed: false, destroy() { this.destroyed = true; } };
            buffers.push(buffer);
            return buffer;
        },
        queue: { submit(commands) { for (const batch of commands) for (const command of batch) command(); },
            writeBuffer(buffer, offset, data) {
            if (buffer.destroyed) throw new Error('write to destroyed buffer');
            const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            buffer.data.set(bytes, offset);
            writes.push({ buffer, offset, bytes: bytes.length });
        } },
    };
}
