// js/assets/gltf/GLTFModel.js
// Engine‑side asset model for glTF content.
// These classes hold CPU data only; renderers build GPU resources from them.

export class GLTFAsset {
    constructor() {
        this.name       = '';
        this.nodes      = [];   // GLTFNode[]
        this.rootNodes  = [];   // number[] — indices into .nodes
        this.meshes     = [];   // GLTFMesh[]
        this.skins      = [];   // GLTFSkeleton[]
        this.animations = [];   // GLTFAnimation[]
        this.materials  = [];   // GLTFMaterialDef[]
        this.textures   = [];   // GLTFTextureDef[]
        this.images     = [];   // GLTFImage[]
    }
}

export class GLTFNode {
    constructor() {
        this.name         = '';
        this.parentIndex  = -1;
        this.childIndices = [];
        this.meshIndex    = -1;
        this.skinIndex    = -1;

        // Local transform — TRS or matrix, never both.
        this.translation = [0, 0, 0];
        this.rotation    = [0, 0, 0, 1]; // xyzw
        this.scale       = [1, 1, 1];
        this.hasMatrix   = false;
        this.matrix      = null;         // Float32Array(16) when hasMatrix
    }
}

export class GLTFMesh {
    constructor() {
        this.name       = '';
        this.primitives = []; // GLTFPrimitive[]
    }
}

export class GLTFPrimitive {
    constructor() {
        this.positions     = null; // Float32Array
        this.normals       = null; // Float32Array | null
        this.uvs0          = null; // Float32Array | null (TEXCOORD_0)
        this.joints0       = null; // Uint8/16Array | null
        this.weights0      = null; // Float32/Uint8/16Array | null
        this.indices       = null; // Uint8/16/32Array | null

        this.materialIndex = -1;
        this.vertexCount   = 0;
        this.indexCount    = 0;

        this.aabbMin = [0, 0, 0];
        this.aabbMax = [0, 0, 0];
    }
}

export class GLTFSkeleton {
    constructor() {
        this.name               = '';
        this.jointNodeIndices   = [];   // number[] into asset.nodes
        this.inverseBindMatrices = null; // Float32Array(16 * jointCount)
        this.rootNodeIndex      = -1;   // optional skeleton root
    }
    get jointCount() { return this.jointNodeIndices.length; }
}

export class GLTFAnimation {
    constructor() {
        this.name     = '';
        this.channels = []; // GLTFAnimationChannel[]
        this.duration = 0;
    }
}

export class GLTFAnimationChannel {
    constructor() {
        this.targetNodeIndex = -1;
        this.targetPath      = '';       // 'translation'|'rotation'|'scale'|'weights'
        this.interpolation   = 'LINEAR'; // LINEAR|STEP|CUBICSPLINE
        this.times           = null;     // Float32Array
        this.values          = null;     // Float32Array
    }
}

export class GLTFMaterialDef {
    constructor() {
        this.name = '';
        this.baseColorFactor          = [1, 1, 1, 1];
        this.baseColorTextureIndex    = -1;
        this.metallicFactor           = 1;
        this.roughnessFactor          = 1;
        this.metallicRoughnessTexture = -1;
        this.normalTextureIndex       = -1;
        this.normalScale              = 1;
        this.occlusionTextureIndex    = -1;
        this.occlusionStrength        = 1;
        this.emissiveFactor           = [0, 0, 0];
        this.emissiveTextureIndex     = -1;
        this.alphaMode                = 'OPAQUE';
        this.alphaCutoff              = 0.5;
        this.doubleSided              = false;
    }
}

export class GLTFTextureDef {
    constructor() {
        this.imageIndex   = -1;
        this.samplerIndex = -1;
    }
}

export class GLTFImage {
    constructor() {
        this.name     = '';
        this.mimeType = '';
        this.data     = null; // Uint8Array of encoded bytes (PNG/JPEG)
        this.uri      = null; // external ref — unsupported for now
    }
}