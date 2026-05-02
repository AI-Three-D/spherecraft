import { installQuadtreeTileManagerRuntimeDiagnostics } from './gpuQuadtreeTerrainRuntimeDiagnostics.js';
import { installQuadtreeTileManagerSeamDiagnostics } from './gpuQuadtreeTerrainSeamDiagnostics.js';

export function installQuadtreeTileManagerDiagnostics(QuadtreeTileManager) {
    installQuadtreeTileManagerRuntimeDiagnostics(QuadtreeTileManager);
    installQuadtreeTileManagerSeamDiagnostics(QuadtreeTileManager);
}
