
import { requireNumber, requireObject, requireInt } from '../../shared/requireUtil.js';
export class MasterChunkLoader {

    constructor(backend) {
        this._backend = backend;
       
    }

    set backend(value) {
        this._backend = value;
     
    }

    get backend() {
        return this._backend;
    }

    async initialize() {
 
    }

    setStreamingEnabled(enabled) {
        this._streamingEnabled = enabled !== false;
    }

    /**
     * Main update loop called by Frontend
     */
    update(cameraPosition, terrain, deltaTime, planetConfig, sphericalMapper) {

    }


    cleanupAll() {

        
    }
}
