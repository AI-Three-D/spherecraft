export class WaterFeature {
    constructor(chunkX, chunkY, chunkSize, waterHeight) {
        this.type = 'water';
        this.chunkX = chunkX;
        this.chunkY = chunkY;
        this.chunkSize = chunkSize;
        this.waterHeight = waterHeight;
        
        // Position at chunk origin
        this.position = {
            x: chunkX * chunkSize,
            y: waterHeight,
            z: chunkY * chunkSize
        };
        
        // For geometry generator compatibility
        this.width = chunkSize;
        this.height = chunkSize;
        
        // Environmental parameters (defaults)
        this.windDirection = { x: 1.0, y: 0.0 }; // Normalized 2D vector
        this.windSpeed = 5.0;
        this.waveHeight = 0.3;
        this.waveFrequency = 0.8;
        this.foamThreshold = 0.7;
        this.shorelineFoamWidth = 2.0;
    }
    
    getType() {
        return 'water';
    }
    
    getShapeSeed() { 
        return 1; // Constant for all water planes
    }
}