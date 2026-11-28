// @ts-nocheck
// The forest floor's surfaces the terrain draws under a stand's canopy (terrainPass.wgsl.js floorSurfaceOf), by the
// ground type names an ecosystem lists (core/world/ecology/ecologyRegistry.js; a game's ecology.json). The plants on
// the floor are the grass system's (core/renderer/grass/floorPlants.js).

/** Ground type names a registry may use for the floor itself, and the surface each is drawn with. */
export const FLOOR_SURFACES = Object.freeze({ moss: 'moss', 'leaf-litter': 'litter', 'needle-litter': 'litter', lichen: 'lichen' });

/**
 * Per stand with any floor surface "under" its canopy: { stand: numeric id, moss, litter, lichen }, each the share of
 * the floor it covers (an entry's `cover`, 1 when not given). Litter takes what they leave; stands not listed are all
 * litter.
 */
export function forestFloorSurfaces(compiled) {
    const out = [];
    for (const eco of compiled?.ecosystems ?? []) {
        for (const stand of eco.stands) {
            const s = { stand: stand.numericId, moss: 0, litter: 0, lichen: 0 };
            for (const g of eco.ground ?? []) {
                if (g?.where === 'open') continue;
                if (Array.isArray(g?.stands) && !g.stands.includes(stand.id)) continue;
                const surface = FLOOR_SURFACES[g?.type];
                if (surface) s[surface] += Number.isFinite(g.cover) ? Math.max(0, g.cover) : 1;
            }
            if (s.moss + s.litter + s.lichen > 0) out.push(s);
        }
    }
    return out;
}
