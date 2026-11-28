// @ts-nocheck
// The ecosystem registry (ECOLOGY_FOUNDATION_PLAN.md F8): what grows where, as data a game supplies (its ecology.json),
// checked and compiled for the shaders. The engine holds no content.
//
// An ecosystem matches a cover class of the climate-driven landscape (biomeLandscape.wgsl.js biomeCover) within a band
// of temperature (deg C) and humidity (0..1), and holds stands (what the forest is there: tree species by id, canopy
// ranges), ground types, rocks and deadfall. Tree species and archetypes live in the forest system and are referred to
// by stable ids; a stand's other fields (age, competition, gaps, edges...) are optional and passed through as they are.
//
// Stands get numeric ids, global and stable (a hash of "ecosystem/stand" into 1..65534; 0 is open ground, 65535
// unknown), so data made today means the same after stands are added.

/** The landscape's cover classes, in biomeCover's order. */
export const ECO_COVER_CLASSES = Object.freeze(['grass', 'forest', 'marsh', 'tundra', 'snow', 'sand', 'rock']);
export const ECO_MAX_ECOSYSTEMS = 32;
export const ECO_MAX_STANDS = 128;
/** vec4s of the compiled table: a header, two per ecosystem, three per stand. */
export const ECO_TABLE_VEC4S = 1 + 2 * ECO_MAX_ECOSYSTEMS + 3 * ECO_MAX_STANDS;

const normalizedC = c => (c + 30) / 70;

/** A stand's stable numeric id: FNV-1a of "ecosystem/stand", into 1..65534. */
export function standNumericId(ecosystemId, standId) {
    let h = 0x811c9dc5;
    for (const ch of `${ecosystemId}/${standId}`) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
    return 1 + (h % 65534);
}

const isRange = r => Array.isArray(r) && r.length === 2 && r.every(Number.isFinite) && r[0] <= r[1];

/**
 * json: the game's ecology.json. forestSpecies: the forest system's species ids (a Set), or null to accept any.
 * Returns { ecosystems, stands, standById, errors, warnings, table: Float32Array (ECO_TABLE_VEC4S x 4) }.
 */
export function compileEcologyRegistry(json, { forestSpecies = null } = {}) {
    const errors = [], warnings = [];
    const ecosystems = [], stands = [], standById = new Map();
    const list = Array.isArray(json?.ecosystems) ? json.ecosystems : [];
    if (!list.length) warnings.push('no ecosystems');
    const ids = new Set();
    for (const raw of list.slice(0, ECO_MAX_ECOSYSTEMS)) {
        const id = String(raw?.id ?? '');
        if (!id) { errors.push('an ecosystem without an id'); continue; }
        if (ids.has(id)) { errors.push(`ecosystem ${id} given twice`); continue; }
        ids.add(id);
        const match = raw.match ?? {};
        const cover = ECO_COVER_CLASSES.indexOf(match.cover ?? 'forest');
        if (cover < 0) errors.push(`${id}: cover class ${match.cover} is not one of ${ECO_COVER_CLASSES.join(', ')}`);
        const temperatureC = match.temperatureC ?? [-30, 40];
        const humidity = match.humidity ?? [0, 1];
        if (!isRange(temperatureC)) errors.push(`${id}: temperatureC must be [low, high]`);
        if (!isRange(humidity)) errors.push(`${id}: humidity must be [low, high]`);
        const eco = { id, cover: Math.max(0, cover), temperatureC, humidity, stands: [], ground: raw.ground ?? [], rocks: raw.rocks ?? {}, deadfall: raw.deadfall ?? {}, extra: raw };
        const standIds = new Set();
        for (const s of Array.isArray(raw.stands) ? raw.stands : []) {
            const sid = String(s?.id ?? '');
            if (!sid) { errors.push(`${id}: a stand without an id`); continue; }
            if (standIds.has(sid)) { errors.push(`${id}: stand ${sid} given twice`); continue; }
            standIds.add(sid);
            if (stands.length >= ECO_MAX_STANDS) { errors.push(`more than ${ECO_MAX_STANDS} stands`); break; }
            const trees = Array.isArray(s.trees) ? s.trees : [];
            for (const t of trees) {
                if (typeof t?.species !== 'string') errors.push(`${id}/${sid}: a tree without a species id`);
                else if (forestSpecies && !forestSpecies.has(t.species)) errors.push(`${id}/${sid}: species ${t.species} is not one the forest system provides`);
            }
            const canopy = s.canopy ?? {};
            for (const k of ['cover', 'top', 'crownLAI']) {
                if (canopy[k] !== undefined && !isRange(canopy[k])) errors.push(`${id}/${sid}: canopy.${k} must be [low, high]`);
            }
            const numericId = standNumericId(id, sid);
            const clash = standById.get(numericId);
            if (clash) errors.push(`${id}/${sid} and ${clash.ecosystem}/${clash.id} hash to the same stand id ${numericId}: rename one`);
            const stand = {
                id: sid, ecosystem: id, numericId, share: Number.isFinite(s.share) ? Math.max(0, s.share) : 1, trees,
                canopy: { cover: canopy.cover ?? [0, 0], top: canopy.top ?? [0, 0], crownLAI: canopy.crownLAI ?? [0, 0] }, extra: s,
            };
            stands.push(stand);
            standById.set(numericId, stand);
            eco.stands.push(stand);
        }
        if (!eco.stands.length) warnings.push(`${id}: no stands`);
        for (const g of eco.ground) {
            for (const ref of Array.isArray(g?.stands) ? g.stands : []) {
                if (!standIds.has(ref)) errors.push(`${id}: ground type ${g.type} names stand ${ref}, which ${id} does not have`);
            }
        }
        ecosystems.push(eco);
    }
    if (list.length > ECO_MAX_ECOSYSTEMS) errors.push(`more than ${ECO_MAX_ECOSYSTEMS} ecosystems`);

    // The table the habitat writer reads (ecologyWriter.wgsl.js).
    const table = new Float32Array(ECO_TABLE_VEC4S * 4);
    table.set([ecosystems.length, stands.length, 0, 0], 0);
    let firstStand = 0;
    ecosystems.forEach((e, i) => {
        const o = 4 + i * 8;
        table.set([e.cover, normalizedC(e.temperatureC[0]), normalizedC(e.temperatureC[1]), e.humidity[0]], o);
        table.set([e.humidity[1], firstStand, e.stands.length, 0], o + 4);
        firstStand += e.stands.length;
    });
    stands.forEach((s, i) => {
        const o = 4 + ECO_MAX_ECOSYSTEMS * 8 + i * 12;
        table.set([s.numericId, s.share, s.canopy.cover[0], s.canopy.cover[1]], o);
        table.set([s.canopy.top[0], s.canopy.top[1], s.canopy.crownLAI[0], s.canopy.crownLAI[1]], o + 4);
        table.set([s.trees.length > 0 ? 1 : 0, 0, 0, 0], o + 8);
    });
    return { ecosystems, stands, standById, errors, warnings, table };
}
