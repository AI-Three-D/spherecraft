export class BaseRenderer {
    constructor() {
    }

    /** 
     * Abstract render. 
     * @param {Array} loadedChunks - Array of {terrainMesh, loadedFeatures, ...} from master loader
     * @param {*} gameState 
     * @param {THREE.Camera} camera 
     */
    render(loadedChunks, gameState, camera, environmentState) {
        throw new Error('render() must be implemented by subclass');
    }

    resize(width, height) {
        throw new Error('resize() must be implemented by subclass');
    }

    cleanup() {
        throw new Error('cleanup() must be implemented by subclass');
    }
}