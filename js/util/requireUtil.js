import { LogLevel } from '../config/Logger.js';

export function requireObject(value, name) {
    if (!value || typeof value !== 'object') {
        throw new Error(`Frontend missing required object: ${name}`);
    }
    return value;
}

export function requireString(value, name) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`Frontend missing required string: ${name}`);
    }
    return value;
}

export function requireNumber(value, name) {
    if (!Number.isFinite(value)) {
        throw new Error(`Frontend missing required number: ${name}`);
    }
    return value;
}

export function requireInt(value, name, min = null) {
    if (!Number.isFinite(value)) {
        throw new Error(`Frontend missing required integer: ${name}`);
    }
    const n = Math.floor(value);
    if (min !== null && n < min) {
        throw new Error(`Frontend ${name} must be >= ${min}`);
    }
    return n;
}


export function requireNumberArray(value, name, minLength = 1, allowInfinity = false) {
    if (!Array.isArray(value) || value.length < minLength) {
        throw new Error(`Frontend missing required array: ${name}`);
    }
    value.forEach((entry) => {
        const ok = Number.isFinite(entry) || (allowInfinity && entry === Infinity);
        if (!ok) {
            throw new Error(`Frontend ${name} has invalid entry: ${entry}`);
        }
    });
    return value.slice();
}

export function requireMaxFinite(values, name) {
    const finite = values.filter((entry) => Number.isFinite(entry));
    if (finite.length === 0) {
        throw new Error(`Frontend ${name} must include at least one finite value`);
    }
    return Math.max(...finite);
}

export function requireChunksPerFace(planetConfig, sphericalMapper) {
    const planet = requireObject(planetConfig, 'planetConfig');
    const planetChunks = requireInt(planet.chunksPerFace, 'planetConfig.chunksPerFace', 1);
    if (sphericalMapper) {
        const mapperChunks = requireInt(sphericalMapper.chunksPerFace, 'sphericalMapper.chunksPerFace', 1);
        if (mapperChunks !== planetChunks) {
            throw new Error('Frontend requires sphericalMapper.chunksPerFace to match planetConfig.chunksPerFace');
        }
    }
    return planetChunks;
}



export function requireStringArray(value, name, minLength = 1) {
    if (!Array.isArray(value) || value.length < minLength) {
        throw new Error(`[DataTextureConfig] missing required array: ${name}`);
    }
    value.forEach((entry) => {
        if (typeof entry !== 'string' || entry.length === 0) {
            throw new Error(`[DataTextureConfig] ${name} has invalid entry`);
        }
    });
    return value.slice();
}



  
export function requireBool(value, name) {
    if (typeof value !== 'boolean') {
      throw new Error(`EngineConfig missing required boolean: ${name}`);
    }
    return value;
  }

  
  export function requireIntArray(value, name, minLength = 1) {
    if (!Array.isArray(value) || value.length < minLength) {
      throw new Error(`EngineConfig missing required array: ${name}`);
    }
    return value.map((entry) => requireInt(entry, name));
  }
  
  export  function requireLogLevel(value, name) {
    const level = requireInt(value, name);
    if (level < LogLevel.DEBUG || level > LogLevel.NONE) {
      throw new Error(`EngineConfig ${name} out of range`);
    }
    return level;
  }
  


  
  export function requireArray(value, name, minLength = 1) {
    if (!Array.isArray(value) || value.length < minLength) {
      throw new Error(`GameDataConfig missing required array: ${name}`);
    }
    return value;
  }
  
  export function requirePoolConfig(value, maxLODLevels) {
    if (!value || typeof value !== 'object') {
        throw new Error('[LODAtlasConfig] missing required poolConfig');
    }
    const config = {};
    for (let lod = 0; lod < maxLODLevels; lod++) {
        const entry = value[lod];
        if (!entry || typeof entry !== 'object') {
            throw new Error(`[LODAtlasConfig] missing poolConfig entry for lod ${lod}`);
        }
        config[lod] = {
            slots: requireInt(entry.slots, `poolConfig.${lod}.slots`, 1),
            textureSize: requireInt(entry.textureSize, `poolConfig.${lod}.textureSize`, 1)
        };
    }
    return config;
}
