// Local, revisioned water work products. The owner supplies regional keys and
// the loader; this cache never enumerates planetary hydrology or render LODs.
export class WaterPageCache {
    constructor({maxBytes}) {
        if(!Number.isSafeInteger(maxBytes)||maxBytes<=0)throw new Error('A positive byte budget is required');
        this.maxBytes=maxBytes;this.bytes=0;this.entries=new Map();this.pending=new Map();this.epoch=0;
        this.stats={hits:0,misses:0,evictions:0,staleBuilds:0};
    }
    async get(key,revision,load) {
        const full=JSON.stringify([key,revision]),found=this.entries.get(full);
        if(found){this.stats.hits++;this.entries.delete(full);this.entries.set(full,found);return found.value;}
        if(this.pending.has(full)){this.stats.hits++;return this.pending.get(full);}
        this.stats.misses++;const epoch=this.epoch;
        const promise=Promise.resolve().then(load).then(value=>{
            if(epoch!==this.epoch){this.stats.staleBuilds++;throw new Error('Water page invalidated during build');}
            const bytes=value.byteLength;
            if(!Number.isSafeInteger(bytes)||bytes<0)throw new Error('Water page must declare byteLength');
            if(bytes>this.maxBytes)throw new Error('Water page exceeds cache budget');
            while(this.bytes+bytes>this.maxBytes)this._remove(this.entries.keys().next().value);
            this.entries.set(full,{key,revision,value,bytes});this.bytes+=bytes;return value;
        }).finally(()=>{if(this.pending.get(full)===promise)this.pending.delete(full);});
        this.pending.set(full,promise);return promise;
    }
    _remove(full) {const e=this.entries.get(full);if(!e)return;this.entries.delete(full);this.bytes-=e.bytes;this.stats.evictions++;}
    evictWhere(predicate) {for(const [k,e]of this.entries)if(predicate(e.key,e.revision,e.value))this._remove(k);}
    clear() {this.epoch++;this.entries.clear();this.pending.clear();this.bytes=0;}
    snapshot(){return {...this.stats,bytes:this.bytes,maxBytes:this.maxBytes,entries:this.entries.size,pending:this.pending.size};}
}
