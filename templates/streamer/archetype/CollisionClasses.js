// js/renderer/streamer/archetype/CollisionClasses.js
//
// Collision classification for scattered assets. Used by the overlap
// system (Increment 5) to decide which assets block placement of which
// other assets. The class value is written into the GPU variant record
// at float [31]; the block mask at float [32].

export const CollisionClass = Object.freeze({
    NONE:           0,  // no footprint; other assets may spawn through this
    GROUND_CLUTTER: 1,  // mushrooms, pebbles — doesn't block anything
    MEDIUM_PROP:    2,  // ferns, small rocks — blocks clutter
    LARGE_PROP:     3,  // logs, stumps, boulders — blocks medium + clutter
    TREE_TRUNK:     4,  // standing tree — blocks everything below
    LANDMARK:       5,  // player structures — absolute exclusion
});

export const CollisionClassName = Object.freeze({
    0: 'NONE',
    1: 'GROUND_CLUTTER',
    2: 'MEDIUM_PROP',
    3: 'LARGE_PROP',
    4: 'TREE_TRUNK',
    5: 'LANDMARK',
});

/**
 * Build a blockedBy bitmask. The scatter shader (Inc 5) tests
 * (1u << otherClass) & thisMask to decide whether `other` blocks `this`.
 * Stored as a float in the GPU buffer — safe up to bit 22.
 */
export function makeBlockMask(...classes) {
    let mask = 0;
    for (const c of classes) {
        if (c >= 0 && c <= 22) mask |= (1 << c);
    }
    return mask;
}

/** Dev/debug only. */
export function decodeBlockMask(mask) {
    const out = [];
    for (let c = 0; c <= 5; c++) {
        if (mask & (1 << c)) out.push(CollisionClassName[c]);
    }
    return out;
}