// debugAtlas.js - Add this to your project for testing

import { TextureAtlasManager } from '../core/texture/TextureManager.js';
import { TEXTURE_LEVELS, SEASONS, TILE_CONFIG } from '../texture/TileConfig.js';
import { TILE_TYPES } from '../templates/configs/tileTypes.js';

// Test configuration that matches between file-based and procedural
export const TEST_CONFIG = {
    tilesToTest: [
        TILE_TYPES.GRASS_SHORT_1,
        TILE_TYPES.TUNDRA_BARREN_1,
        TILE_TYPES.ROCK_OUTCROP_1,
        TILE_TYPES.SAND_COARSE_1
    ],
    seasonsToTest: Object.values(SEASONS),
    levelsToTest: [
        TEXTURE_LEVELS.MICRO,
        TEXTURE_LEVELS.MACRO
    ]
};

export async function downloadAllAtlases(atlasManager, prefix = 'atlas') {
    for (const [level, atlas] of atlasManager.atlases.entries()) {
      const link = document.createElement('a');
      link.download = `${prefix}_${level}.png`;

      link.href = atlas.canvas.toDataURL('image/png');
      link.click();
      await new Promise(r => setTimeout(r, 200));
    }
  }

// Function 1: Render atlas to a visible canvas
export function renderAtlasToCanvas(atlasManager, level, canvasId = null) {
    const atlas = atlasManager.atlases.get(level);
    if (!atlas || !atlas.canvas) {
        return null;
    }

    // Create or get canvas element
    let displayCanvas;
    if (canvasId) {
        displayCanvas = document.getElementById(canvasId);
        if (!displayCanvas) {
            displayCanvas = document.createElement('canvas');
            displayCanvas.id = canvasId;
            document.body.appendChild(displayCanvas);
        }
    } else {
        displayCanvas = document.createElement('canvas');
        document.body.appendChild(displayCanvas);
    }

    // Copy atlas to display canvas
    displayCanvas.width = atlas.canvas.width;
    displayCanvas.height = atlas.canvas.height;
    const ctx = displayCanvas.getContext('2d');
    ctx.drawImage(atlas.canvas, 0, 0);

    // Draw grid overlay to show tile boundaries
    ctx.strokeStyle = 'rgba(255, 0, 0, 0.3)';
    ctx.lineWidth = 1;
    
    if (atlas.layout) {
        const { paddedTextureSize, tilesPerRow, rows } = atlas.layout;
        
        // Draw vertical lines
        for (let i = 0; i <= tilesPerRow; i++) {
            ctx.beginPath();
            ctx.moveTo(i * paddedTextureSize, 0);
            ctx.lineTo(i * paddedTextureSize, rows * paddedTextureSize);
            ctx.stroke();
        }
        
        // Draw horizontal lines
        for (let i = 0; i <= rows; i++) {
            ctx.beginPath();
            ctx.moveTo(0, i * paddedTextureSize);
            ctx.lineTo(tilesPerRow * paddedTextureSize, i * paddedTextureSize);
            ctx.stroke();
        }

        // Draw actual texture boundaries (inside padding)
        ctx.strokeStyle = 'rgba(0, 255, 0, 0.5)';
        const padding = atlasManager.PADDING;
        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < tilesPerRow; col++) {
                const x = col * paddedTextureSize + padding;
                const y = row * paddedTextureSize + padding;
                ctx.strokeRect(x, y, atlas.layout.textureSize, atlas.layout.textureSize);
            }
        }
    }

    // Add label
    ctx.fillStyle = 'white';
    ctx.strokeStyle = 'black';
    ctx.lineWidth = 3;
    ctx.font = 'bold 16px Arial';
    const label = `Atlas: ${level}`;
    ctx.strokeText(label, 10, 25);
    ctx.fillText(label, 10, 25);

    displayCanvas.style.border = '2px solid blue';
    displayCanvas.style.margin = '10px';
    displayCanvas.style.maxWidth = '100%';
    displayCanvas.style.height = 'auto';

    return displayCanvas;
}

// Function 2: Comprehensive atlas debug logger
export function debugAtlasDetails(atlasManager, level) {
    const atlas = atlasManager.atlases.get(level);
    
    if (!atlas) {
        return;
    }
}

// Detailed comparison function
export function compareAtlasImplementations(fileAtlas, procAtlas, level) {
    const fileAtlasData = fileAtlas.atlases.get(level);
    const procAtlasData = procAtlas.atlases.get(level);
    
    const layoutProps = ['atlasSize', 'textureSize', 'paddedTextureSize', 'padding', 'tilesPerRow', 'rows', 'totalTextures', 'maxCapacity'];
    const textureProps = ['minFilter', 'magFilter', 'wrapS', 'wrapT', 'generateMipmaps', 'anisotropy', 'format', 'type', 'encoding'];
    
    const differences = [];
    
    if (fileAtlasData.canvas?.width !== procAtlasData.canvas?.width) {
        differences.push('Canvas width differs');
    }
    if (fileAtlasData.canvas?.height !== procAtlasData.canvas?.height) {
        differences.push('Canvas height differs');
    }
    
    for (const prop of layoutProps) {
        if (fileAtlasData.layout?.[prop] !== procAtlasData.layout?.[prop]) {
            differences.push(`Layout.${prop} differs: file=${fileAtlasData.layout?.[prop]}, proc=${procAtlasData.layout?.[prop]}`);
        }
    }
    
    for (const prop of textureProps) {
        if (fileAtlasData.texture?.[prop] !== procAtlasData.texture?.[prop]) {
            differences.push(`Texture.${prop} differs: file=${fileAtlasData.texture?.[prop]}, proc=${procAtlasData.texture?.[prop]}`);
        }
    }
    
    return differences;
}

// Update the test runner to use this comparison
export async function runAtlasComparison() {
    // Create file-based atlas
    const fileAtlas = new TextureAtlasManager();
    await fileAtlas.initializeAtlases(false);
    
    // Create procedural atlas
    const procAtlas = new TextureAtlasManager();
    await procAtlas.initializeAtlases(true);
    
    // Clear any existing test canvases
    const existingCanvases = document.querySelectorAll('canvas[id^="atlas-"]');
    existingCanvases.forEach(c => c.remove());
    
    // Test each level
    for (const level of TEST_CONFIG.levelsToTest) {
        // Render both atlases
        renderAtlasToCanvas(fileAtlas, level, `atlas-file-${level}`);
        renderAtlasToCanvas(procAtlas, level, `atlas-proc-${level}`);
        
        // Debug file-based atlas
        debugAtlasDetails(fileAtlas, level);
        
        // Debug procedural atlas
        debugAtlasDetails(procAtlas, level);
        
        // Detailed comparison
        compareAtlasImplementations(fileAtlas, procAtlas, level);
    }
    
    return { fileAtlas, procAtlas };
}

// Update window exports
window.debugAtlas = {
    renderAtlasToCanvas,
    debugAtlasDetails,
    compareAtlasImplementations,
    runAtlasComparison,
    TEST_CONFIG
};

export function setup() {
    window.debugAtlas = {
        renderAtlasToCanvas,
        debugAtlasDetails,
        runAtlasComparison,
        TEST_CONFIG
    };
}

export async function downloadCpuAndGpuAtlases(options = {}) {
    const {
      prefix = 'atlas',
      levels = null,
      showInPage = true,
      delayBetweenDownloadsMs = 150
    } = options;
  
    try {
      const gpuAtlasMgr = new TextureAtlasManager();
      await gpuAtlasMgr.initializeAtlases(true, false);

      // Determine which levels to operate on
      const levelsToProcess = levels || Array.from(gpuAtlasMgr.atlases.keys());
  
      // Optionally render to page for quick visual comparison
      if (showInPage) {
        const wrapper = document.createElement('div');
        wrapper.style.display = 'flex';
        wrapper.style.flexWrap = 'wrap';
        wrapper.style.gap = '16px';
        wrapper.style.padding = '12px';
        wrapper.style.background = '#111';
        wrapper.style.color = '#fff';
        wrapper.id = 'proc-atlas-debug-wrapper';
        document.body.appendChild(wrapper);
  
        const makeLabel = (title) => {
          const el = document.createElement('div');
          el.style.width = '100%';
          el.style.textAlign = 'left';
          el.style.font = '14px/1.2 monospace';
          el.style.margin = '6px 0';
          el.textContent = title;
          return el;
        };
  
        for (const level of levelsToProcess) {
          // GPU canvas
          const gpuAtlas = gpuAtlasMgr.atlases.get(level);
          if (gpuAtlas?.canvas) {
            const container = document.createElement('div');
            container.style.border = '1px solid #333';
            container.style.padding = '6px';
            container.style.background = '#222';
            const label = makeLabel(`GPU procedural - level: ${level}`);
            container.appendChild(label);
  
            const c = document.createElement('canvas');
            c.width = gpuAtlas.canvas.width;
            c.height = gpuAtlas.canvas.height;
            c.style.maxWidth = '48vw';
            c.style.height = 'auto';
            const ctx = c.getContext('2d');
            ctx.drawImage(gpuAtlas.canvas, 0, 0);
            container.appendChild(c);
            wrapper.appendChild(container);
          }
        }
      }
  
      // Download canvases for each level
      for (const level of levelsToProcess) {
        const gpuAtlas = gpuAtlasMgr.atlases.get(level);
  
        if (gpuAtlas?.canvas) {
          const gpuLink = document.createElement('a');
          gpuLink.href = gpuAtlas.canvas.toDataURL('image/png');
          gpuLink.download = `${prefix}_procedural_gpu_${level}.png`;
          gpuLink.style.display = 'none';
          document.body.appendChild(gpuLink);
          gpuLink.click();
          gpuLink.remove();
          await new Promise(r => setTimeout(r, delayBetweenDownloadsMs));
        }
      }
  
      // Return atlas managers for further inspection
      return { gpuAtlasMgr };
  
    } catch (err) {
      throw err;
    }
  }

downloadCpuAndGpuAtlases();
