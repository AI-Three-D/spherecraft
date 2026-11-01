import { bakeJunctionSamples } from './junctionFieldBake.js';

self.onmessage=({data})=>{
    try {
        const result=bakeJunctionSamples(data);
        const transfer=[...new Set(Object.values(result).filter(ArrayBuffer.isView).map(a=>a.buffer))];
        self.postMessage({result},transfer);
    } catch(error) {self.postMessage({error:String(error)});}
};
