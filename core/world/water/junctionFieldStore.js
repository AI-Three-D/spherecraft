export const JUNCTION_FIELD_CAPACITY=16;
export const JUNCTION_FIELD_HEADER_BYTES=16+JUNCTION_FIELD_CAPACITY*80;

export function packJunctionFields(fields,radiusM) {
    if(fields.length>JUNCTION_FIELD_CAPACITY)throw new Error('Junction field capacity exceeded');
    if(!Number.isFinite(radiusM)||radiusM<=0)throw new Error('Invalid junction planet radius');
    const header=new ArrayBuffer(JUNCTION_FIELD_HEADER_BYTES),f32=new Float32Array(header),u32=new Uint32Array(header);
    u32[0]=fields.length;
    let cells=0;
    for(let slot=0;slot<fields.length;slot++) {
        const field=fields[slot],F=field.frame,n=F.width*F.height;
        if(!Number.isInteger(F.width)||!Number.isInteger(F.height)||F.width<4||F.height<4||
            !(F.spacingM>0)||field.field.length!==n*4)throw new Error('Invalid junction field dimensions');
        const o=4+slot*20;
        const values=[...F.c,radiusM,...F.e1,F.x0,...F.e2,F.y0,F.width,F.height,F.spacingM,1];
        if(!values.every(Number.isFinite))throw new Error('Non-finite junction coordinates');
        f32.set(values,o);
        u32.set([cells,n,(field.lakeId??-1)+1,0],o+16);
        cells+=n;
    }
    const texels=new Float32Array(Math.max(4,cells*4));let at=0;
    for(const field of fields){texels.set(field.field,at);at+=field.field.length;}
    return {header,texels};
}

// Owns immutable published generations. Replaced buffers retire after a frame
// has submitted, so render and terrain encoders can finish using the old set.
export class JunctionFieldStore {
    constructor(device,radiusM) {
        this.device=device;this.radiusM=radiusM;this.version=0;this.fields=[];this.retired=[];this.disposed=false;
        this.bindGroupLayout=device.createBindGroupLayout({label:'JunctionFields',entries:[
            {binding:0,visibility:GPUShaderStage.COMPUTE|GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:'uniform'}},
            {binding:1,visibility:GPUShaderStage.COMPUTE|GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:'read-only-storage'}},
        ]});
        this.empty=this._allocate(packJunctionFields([],radiusM));this.resources=this.empty;
    }
    _allocate({header,texels}) {
        if(texels.byteLength>this.device.limits.maxStorageBufferBindingSize)throw new Error('Junction fields exceed the GPU storage limit');
        const params=this.device.createBuffer({label:'JunctionFields-Params',size:header.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
        const data=this.device.createBuffer({label:'JunctionFields-Texels',size:texels.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
        this.device.queue.writeBuffer(params,0,header);this.device.queue.writeBuffer(data,0,texels);
        const entries=[{binding:0,resource:{buffer:params}},{binding:1,resource:{buffer:data}}];
        const bindGroup=this.device.createBindGroup({layout:this.bindGroupLayout,entries});
        return {params,data,entries,bindGroup,paramsData:new Float32Array(header)};
    }
    publish(fields) {
        if(this.disposed)throw new Error('Junction fields already disposed');
        const next=this._allocate(packJunctionFields(fields,this.radiusM));
        if(this.resources!==this.empty)this.retired.push(this.resources);
        this.resources=next;this.fields=[...fields];this.version++;
        return next;
    }
    clear() {
        if(this.resources!==this.empty)this.retired.push(this.resources);
        this.resources=this.empty;this.fields=[];this.version++;
    }
    afterSubmit() {
        const retired=this.retired.splice(0);
        if(!retired.length)return;
        this.device.queue.onSubmittedWorkDone().catch(()=>{}).then(()=>{
            for(const r of retired){r.params.destroy();r.data.destroy();}
        });
    }
    dispose() {
        if(this.disposed)return;this.disposed=true;
        const all=new Set([this.empty,this.resources,...this.retired]);
        for(const r of all){r.params.destroy();r.data.destroy();}
        this.retired.length=0;this.fields.length=0;
    }
}
