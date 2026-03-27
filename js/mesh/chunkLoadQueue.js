export class ChunkLoadQueue {
    constructor(maxOperationsPerFrame = 200) {
        this.loadQueue = [];
        this.unloadQueue = [];
        this.maxOperationsPerFrame = maxOperationsPerFrame;
        this.pendingLoads = new Set();
        this.pendingUnloads = new Set();
    }
    queueLoad(chunkKey, priority = 0) {
        if (this.pendingLoads.has(chunkKey)) {
            return;
        }
    
        if (this.pendingUnloads.has(chunkKey)) {
            
            this.unloadQueue = this.unloadQueue.filter(key => key !== chunkKey);
            this.pendingUnloads.delete(chunkKey);
        }
    
        this.loadQueue.push({ chunkKey, priority });
        this.pendingLoads.add(chunkKey);
    }
    
    queueUnload(chunkKey) {
        if (this.pendingUnloads.has(chunkKey)) {
            return;
        }
    
        if (this.pendingLoads.has(chunkKey)) {
            
            this.loadQueue = this.loadQueue.filter(item => item.chunkKey !== chunkKey);
            this.pendingLoads.delete(chunkKey);
        }
    
        this.unloadQueue.push(chunkKey);
        this.pendingUnloads.add(chunkKey);
    }
    sortByPriority() {
        this.loadQueue.sort((a, b) => b.priority - a.priority);
    }

    getNextLoads(count) {
        const loads = [];
        let i = 0;
        
        while (loads.length < count && i < this.loadQueue.length) {
            const item = this.loadQueue[i];
            
            if (!this.pendingUnloads.has(item.chunkKey)) {
                loads.push(item.chunkKey);
                this.pendingLoads.delete(item.chunkKey);
                this.loadQueue.splice(i, 1);
            } else {
                
                i++;
            }
        }
        
        return loads;
    }

    getNextUnloads(count) {
        const unloads = [];
        while (unloads.length < count && this.unloadQueue.length > 0) {
            const chunkKey = this.unloadQueue.shift();
            this.pendingUnloads.delete(chunkKey);
            unloads.push(chunkKey);
        }
        return unloads;
    }

    clear() {
        this.loadQueue = [];
        this.unloadQueue = [];
        this.pendingLoads.clear();
        this.pendingUnloads.clear();
    }

    get totalPending() {
        return this.loadQueue.length + this.unloadQueue.length;
    }
}
