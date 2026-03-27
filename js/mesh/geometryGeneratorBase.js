import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.178.0/build/three.module.js';

export class GeometryGeneratorBase {

    async buildGeometry(feature) {
        // This method should be overridden by subclasses
        throw new Error("buildGeometry must be implemented by subclasses");
    }

    getMaterialProfile(feature) {
        return {
          materialType: null,
          options: { }
        };
    }
}
