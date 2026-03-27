import { GameEngine } from './gameEngine.js';
import { createEngineConfig, createGameDataConfig } from './config/runtimeConfigs.js';
import './renderer/streamer/testAssetRegistry.js';

window.qtDiag = window.qtDiag || {
    help() {
        console.log('window.qtDiag is loaded, but the engine diagnostics are not bound yet.');
    }
};

const engineConfig = createEngineConfig();
const gameDataConfig = createGameDataConfig();

const gameEngine = new GameEngine('gameCanvas', engineConfig, gameDataConfig);
installQuadtreeDiagnostics(gameEngine);

function installQuadtreeDiagnostics(engine) {
    function getTileManager() {
        return engine?.renderer?.quadtreeTileManager ?? null;
    }

    function getTileStreamer() {
        return getTileManager()?.tileStreamer ?? null;
    }

    function getQuadtreeGPU() {
        return getTileManager()?.quadtreeGPU ?? null;
    }

    function getTerrainDebugMode() {
        return engine?.engineConfig?.debug?.terrainFragmentDebugMode ?? 0;
    }

    function buildTileChain(face, depth, x, y, includeParents = true) {
        const chain = [];
        let d = depth | 0;
        let tx = x | 0;
        let ty = y | 0;
        while (d >= 0) {
            chain.push({ face: face | 0, depth: d, x: tx, y: ty });
            if (!includeParents || d === 0) break;
            d--;
            tx >>= 1;
            ty >>= 1;
        }
        return chain;
    }

    function normalizeTileArg(faceOrTile, depth, x, y) {
        if (typeof faceOrTile === 'object' && faceOrTile !== null) {
            return {
                face: faceOrTile.face | 0,
                depth: faceOrTile.depth | 0,
                x: faceOrTile.x | 0,
                y: faceOrTile.y | 0
            };
        }
        return {
            face: faceOrTile | 0,
            depth: depth | 0,
            x: x | 0,
            y: y | 0
        };
    }

    async function inspectTile(faceOrTile, depth, x, y, options = {}) {
        const tile = normalizeTileArg(faceOrTile, depth, x, y);
        const includeParents = options.includeParents !== false;
        const sampleSize = Number.isFinite(options.sampleSize) ? Math.max(1, Math.floor(options.sampleSize)) : 8;
        const readGpuTable = options.readGpuTable !== false;

        const tileManager = getTileManager();
        const tileStreamer = getTileStreamer();
        if (!tileManager || !tileStreamer) {
            console.warn('[qtDiag] GPU quadtree tile manager is not ready');
            return null;
        }

        const gpuEntries = readGpuTable ? await tileManager.debugReadGPUHashTable?.() : null;
        const chain = buildTileChain(tile.face, tile.depth, tile.x, tile.y, includeParents);
        const summary = [];

        for (const entry of chain) {
            const cpu = tileStreamer.debugLookup(entry.face, entry.depth, entry.x, entry.y);
            let gpu = null;
            if (cpu?.found && Array.isArray(gpuEntries) && Number.isInteger(cpu.slot)) {
                gpu = gpuEntries[cpu.slot] ?? null;
            }

            let heightStats = null;
            let tileStats = null;
            let scatterStats = null;
            if (cpu?.found) {
                heightStats = await tileStreamer.debugReadArrayLayerStats('height', cpu.layer, sampleSize);
                tileStats = await tileStreamer.debugReadArrayLayerStats('tile', cpu.layer, sampleSize);
                if (tileStreamer.requiredTypes?.includes?.('scatter')) {
                    scatterStats = await tileStreamer.debugReadArrayLayerStats('scatter', cpu.layer, sampleSize);
                }
            }

            const row = {
                face: entry.face,
                depth: entry.depth,
                x: entry.x,
                y: entry.y,
                cpuFound: !!cpu?.found,
                cpuLayer: cpu?.layer ?? null,
                cpuSlot: cpu?.slot ?? null,
                gpuSlotLayer: gpu?.layer ?? null,
                gpuKeyLo: gpu?.keyLo ?? null,
                gpuKeyHi: gpu?.keyHi ?? null,
                gpuMatchesCpu: !!(
                    cpu?.found &&
                    gpu &&
                    gpu.keyLo === cpu.keyLo &&
                    gpu.keyHi === cpu.keyHi &&
                    gpu.layer === cpu.layer
                ),
                heightMin: heightStats?.min?.[0] ?? null,
                heightMax: heightStats?.max?.[0] ?? null,
                heightMean: heightStats?.mean?.[0] ?? null,
                tileMean: tileStats?.mean?.[0] ?? null,
                scatterMean: scatterStats?.mean?.[0] ?? null
            };
            summary.push(row);
        }

        console.groupCollapsed(
            `[qtDiag] inspectTile f${tile.face}:d${tile.depth}:${tile.x},${tile.y}`
        );
        console.table(summary);
        console.log('raw', { tile, summary, gpuEntriesRead: Array.isArray(gpuEntries) ? gpuEntries.length : 0 });
        console.groupEnd();
        return { tile, summary, gpuEntries };
    }

    async function sampleInstances(maxToRead = 32) {
        const quadtreeGPU = getQuadtreeGPU();
        const tileManager = getTileManager();
        if (!quadtreeGPU || !tileManager) {
            console.warn('[qtDiag] quadtree GPU is not ready');
            return null;
        }

        const rawArgs = await tileManager.debugReadIndirectArgs?.();
        const args = Array.isArray(rawArgs) ? rawArgs : [];
        const totalInstances = args.reduce((sum, item) => sum + (item.instanceCount || 0), 0);
        if (totalInstances <= 0) {
            console.warn('[qtDiag] no terrain instances to sample');
            return { args, instances: [] };
        }

        const readCount = Math.min(totalInstances, Math.max(1, Math.floor(maxToRead)));
        const instances = await quadtreeGPU.debugReadInstancesRange?.(0, totalInstances, readCount);
        console.groupCollapsed(`[qtDiag] sampleInstances read=${readCount}/${totalInstances}`);
        console.table((instances || []).map((inst, index) => ({
            index,
            face: inst.face,
            lod: inst.lod,
            layer: inst.layer,
            uvScale: inst.uvScale,
            chunkU: inst.chunkLocation?.x,
            chunkV: inst.chunkLocation?.y,
            chunkSizeUV: inst.chunkSizeUV,
            edgeMask: inst.edgeMask
        })));
        console.log('raw', { args, instances });
        console.groupEnd();
        return { args, instances };
    }

    async function status() {
        const tileManager = getTileManager();
        const tileStreamer = getTileStreamer();
        const quadtreeGPU = getQuadtreeGPU();
        if (!tileManager || !tileStreamer || !quadtreeGPU) {
            console.warn('[qtDiag] GPU quadtree is not ready');
            return null;
        }

        const metaArgs = await tileManager.debugReadIndirectArgs?.();
        const statusSummary = {
            terrainDebugMode: getTerrainDebugMode(),
            poolUsed: tileStreamer._tileInfo?.size ?? 0,
            poolTotal: tileStreamer.tilePoolSize ?? 0,
            freeLayers: tileStreamer.arrayPool?.freeLayers?.length ?? 0,
            dirtySlots: tileStreamer._dirtySlots?.size ?? 0,
            pendingCopies: tileStreamer.arrayPool?._pendingCopies?.length ?? 0,
            pendingGenerations: tileStreamer._generationQueue?.queue?.length ?? 0,
            activeGenerations: tileStreamer._generationQueue?.active ?? 0,
            maxVisibleTiles: quadtreeGPU.maxVisibleTiles ?? 0,
            totalInstances: Array.isArray(metaArgs)
                ? metaArgs.reduce((sum, item) => sum + (item.instanceCount || 0), 0)
                : 0
        };

        console.groupCollapsed('[qtDiag] status');
        console.table([statusSummary]);
        console.log('raw', { statusSummary, metaArgs, hashStats: tileStreamer.getHashTableStats?.() ?? null });
        console.groupEnd();
        return { statusSummary, metaArgs, hashStats: tileStreamer.getHashTableStats?.() ?? null };
    }

    async function setTerrainDebugMode(mode) {
        await engine.setTerrainDebugMode(mode | 0);
        console.info(`[qtDiag] terrainDebugMode=${mode | 0}`);
    }

    Object.assign(window.qtDiag, {
        help() {
            console.log([
                'window.qtDiag.status()',
                'window.qtDiag.sampleInstances(64)',
                'window.qtDiag.inspectTile(face, depth, x, y)',
                'window.qtDiag.inspectTile({ face, depth, x, y }, null, null, null, { includeParents: true, sampleSize: 8 })',
                'window.qtDiag.setTerrainDebugMode(mode)'
            ].join('\n'));
        },
        status,
        sampleInstances,
        inspectTile,
        setTerrainDebugMode,
        getTileManager,
        getTileStreamer,
        getQuadtreeGPU
    });
}

// Start the game
async function init() {
    try {
        await gameEngine.start();

        let lastTime = performance.now();
        
        function gameLoop(currentTime) {
            const deltaTime = (currentTime - lastTime) / 1000; // Convert to seconds
            lastTime = currentTime;
            
            gameEngine.update(deltaTime);
            gameEngine.render(deltaTime);
            
            requestAnimationFrame(gameLoop);
        }
        
        requestAnimationFrame(gameLoop);
        
    } catch (error) {
        // Use console.error here since Logger may not be initialized yet
        
    }
}

// Start when page loads
window.addEventListener('load', init);

// Expose for debugging
window.gameEngine = gameEngine;
window.setupAudio = (callback) => gameEngine.setupAudioInput(callback);
