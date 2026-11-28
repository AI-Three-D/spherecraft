// @ts-nocheck
// The forest floor's plants the grass system builds (grassWgsl.js FLOOR), by the ground type names an ecosystem lists
// (core/world/ecology/ecologyRegistry.js; a game's ecology.json): the community table each stand's floor draws from.
// Ground types the terrain draws (moss, litter, lichen: forestFloor.js) and those of open ground (the landscape's own
// grass) are not here.

import { FLOOR, FLOOR_ENTRIES, FLOOR_STANDS } from './grassWgsl.js';
import { FLOOR_SURFACES } from '../terrain/materials/forestFloor.js';

/** Ground type names a registry may use, and the plant the grass system builds for each. */
export const FLOOR_TYPES = Object.freeze({
    bilberry: FLOOR.BILBERRY,
    lingonberry: FLOOR.LINGONBERRY,
    fern: FLOOR.FERN,
    'broadleaf-understory': FLOOR.UNDERSTORY,
    'forest-grass': FLOOR.FOREST_GRASS,
});

/** Bytes of the community uniform: a header, the stands, the entries (all vec4). */
export const FLOOR_COMMUNITY_BYTES = 16 * (1 + FLOOR_STANDS + FLOOR_ENTRIES);

/**
 * The community table from a compiled registry: per stand, its floor plants (ground types "under" the canopy, of its
 * ecosystem, for that stand or for all), each (code, weight, light from, light to). Returns { data: ArrayBuffer,
 * stands, entries, unknown: names no plant is built for }.
 */
export function buildFloorCommunity(compiled) {
    const data = new ArrayBuffer(FLOOR_COMMUNITY_BYTES);
    const u = new Uint32Array(data), f = new Float32Array(data);
    const unknown = new Set();
    let stands = 0, entries = 0;
    for (const eco of compiled?.ecosystems ?? []) {
        for (const stand of eco.stands) {
            if (stands >= FLOOR_STANDS) break;
            const first = entries;
            for (const g of eco.ground ?? []) {
                if (g?.where === 'open') continue;
                if (Array.isArray(g?.stands) && !g.stands.includes(stand.id)) continue;
                const code = FLOOR_TYPES[g?.type];
                if (code === undefined) { if (!FLOOR_SURFACES[g?.type]) unknown.add(g?.type); continue; }
                if (entries >= FLOOR_ENTRIES) break;
                const light = Array.isArray(g.light) && g.light.length === 2 ? g.light : [-1, 2];
                const o = 4 * (1 + FLOOR_STANDS + entries);
                f.set([code, Number.isFinite(g.weight) ? g.weight : 1, light[0], light[1]], o);
                entries++;
            }
            u.set([stand.numericId, first, entries - first, 0], 4 * (1 + stands));
            stands++;
        }
    }
    u.set([stands, entries, 0, 0], 0);
    return { data, stands, entries, unknown: [...unknown] };
}
