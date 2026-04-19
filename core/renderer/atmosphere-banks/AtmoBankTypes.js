export const ATMO_BANK_TYPES = Object.freeze({
    VALLEY_MIST: 0,
    FOG_POCKET:  1,
    LOW_CLOUD:   2,
});

export const ATMO_TYPE_CAPACITY    = 4;
export const ATMO_EMITTER_CAPACITY = 64;
export const ATMO_MAX_PARTICLES    = 384;
export const ATMO_PARTICLE_STRIDE  = 96;
export const ATMO_TYPE_DEF_STRIDE  = 64;
export const ATMO_EMITTER_STRIDE   = 80;
export const ATMO_GLOBALS_SIZE     = 256;
export const ATMO_INDIRECT_SIZE    = 16;
export const ATMO_SCRATCH_SIZE     = 16;
export const ATMO_FLAG_ALIVE       = 1;
export const ATMO_WORKGROUP_SIZE   = 64;
export const ATMO_VOLUME_SLICE_COUNT = 5;
export const ATMO_VERTICES_PER_PARTICLE = ATMO_VOLUME_SLICE_COUNT * 6;
