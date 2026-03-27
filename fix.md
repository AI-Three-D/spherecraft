**Fix Summary**
Terrain rendered only a small patch because WebGPU indirect draws were **ignoring `firstInstance`**. The feature that enables `firstInstance` in indirect draws (`indirect-first-instance`) wasn’t requested on device creation, so every LOD draw started at instance 0. Enabling the feature (and optionally falling back to direct draws when unsupported) fixes the coverage.

**Symptoms**
- Only a small area of terrain visible, regardless of camera movement.
- Indirect draw args show non‑zero `firstInstance`, but the rendered area doesn’t expand.

**Root Cause**
`drawIndexedIndirect` uses `firstInstance` only if the optional WebGPU feature `indirect-first-instance` is enabled. Without it, `firstInstance` is ignored and all LODs render the same instance range.

**Fix Steps**
1. **Request the `indirect-first-instance` feature in WebGPU backend.**
   - File: `js/renderer/backend/webgpuBackend.js` (in this repo’s runtime code, it’s under `FINAL/js/...`).
   - Add feature detection + request:
```js
// after adapter is acquired
const requiredFeatures = [];
this.supportsIndirectFirstInstance = this.adapter.features?.has?.('indirect-first-instance') === true;
if (this.supportsIndirectFirstInstance) {
  requiredFeatures.push('indirect-first-instance');
} else {
  Logger.warn('[WebGPU] Adapter missing indirect-first-instance; indirect draws will ignore firstInstance.');
}

this.device = await this.adapter.requestDevice({
  requiredFeatures,
  requiredLimits
});
Logger.info(`[WebGPU] Feature indirect-first-instance=${this.supportsIndirectFirstInstance ? 'yes' : 'no'}`);
```

2. **Use a safe fallback when the feature isn’t supported.**
   - File: `js/renderer/terrain/QuadtreeTerrainRenderer.js`.
   - If `supportsIndirectFirstInstance` is false, bypass indirect draws and issue direct draws with `instanceStart`/`instanceCount`.
   - Pseudocode:
```js
const supportsIndirectFirstInstance = this.backend?.supportsIndirectFirstInstance !== false;
const forceDirectDraw = debugConfig.terrainForceDirectDraw === true || !supportsIndirectFirstInstance;

if (forceDirectDraw) {
  // read back indirect args (CPU) and call backend.draw with instanceStart/instanceCount
  // otherwise use drawIndexedIndirect
}
```
   - This keeps rendering correct on adapters that don’t support the feature.

**Optional (Debug Hygiene)**
- Ensure fragment debug mode is **not hardcoded** so runtime debug settings can be turned off.
  - File: `js/mesh/terrain/shaders/webgpu/terrainChunkFragmentShaderBuilder.js`
  - Use:
```js
const debugMode = Number.isFinite(options.debugMode) ? Math.floor(options.debugMode) : 0;
```

**Result**
After enabling `indirect-first-instance`, indirect draws render full terrain coverage (to horizon) with `terrainForceDirectDraw=false`. If the feature is unavailable, the direct-draw fallback keeps coverage correct.
