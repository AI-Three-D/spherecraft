export class CloudLayerDefinition {
    constructor(options = {}) {
        this.altitude = options.altitude || 2000;
        this.thickness = options.thickness || 1000;
        // ... more properties
    }
}