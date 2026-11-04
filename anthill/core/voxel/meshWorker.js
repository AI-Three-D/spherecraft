import { remodelMesh } from './meshRemodel.js';

self.onmessage = ({data}) => {
    try {
        const start=performance.now();
        const mesh=remodelMesh(data.snapshot);
        const transfer=mesh.stages.flatMap(s=>[s.vertices.buffer,s.indices.buffer]);
        self.postMessage({id:data.id,generation:data.generation,mesh,milliseconds:performance.now()-start},transfer);
    } catch(error) {
        self.postMessage({id:data.id,generation:data.generation,error:String(error)});
    }
};
