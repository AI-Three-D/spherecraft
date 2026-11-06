// Diagnostic lower bound for splitting a field bake into independent groups.
// Adjacent pages may interact through floods, blur and SDF halos; pages of
// one river also share its stations. This does not prove group outputs can be
// reused: plumes and rock wakes can reach across gaps, and lake inputs,
// ordering and changes in group membership still matter.
import { pageKey, pageOf } from '../../../core/world/water/riverField.js';

export function fieldPageGroups(keys, pageRivers, layout, { includeMembers = false } = {}) {
    const parent = Int32Array.from(keys, (_, i) => i), byKey = new Map(keys.map((key, i) => [key, i])), firstRiver = new Map();
    const root = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const join = (a, b) => { a = root(a); b = root(b); if (a !== b) parent[b] = a; };
    for (let i = 0; i < keys.length; i++) {
        for (const river of pageRivers[i]) {
            if (firstRiver.has(river)) join(i, firstRiver.get(river)); else firstRiver.set(river, i);
        }
        const { face, pi, pj } = pageOf(keys[i], layout);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const x = pi + dx, y = pj + dy;
            if ((!dx && !dy) || x < 0 || y < 0 || x >= layout.PE || y >= layout.PE) continue;
            const neighbour = byKey.get(pageKey(face, x, y, layout));
            if (neighbour !== undefined) join(i, neighbour);
        }
    }
    const groups = new Map();
    for (let i = 0; i < keys.length; i++) {
        const id = root(i);
        let group = groups.get(id);
        if (!group) groups.set(id, (group = { pages: 0, rivers: new Set(), slots: [] }));
        group.pages++;
        if (includeMembers) group.slots.push(i);
        for (const river of pageRivers[i]) group.rivers.add(river);
    }
    return [...groups.values()].map(g => ({ pages: g.pages, rivers: g.rivers.size,
        ...(includeMembers ? { slots: g.slots, riverIndices: [...g.rivers].sort((a, b) => a - b) } : {}) })).sort((a, b) => b.pages - a.pages);
}

// Browser probe at the current camera. Prepare in the field worker, as the
// production bake does, but do not sample terrain or publish anything.
export async function fieldGroups() {
    const f = window.gameEngine.riverFieldService, dir = f?._lastDir;
    if (!f || !dir) return null;
    const rivers = f._riverInputs(f._nearRivers(dir));
    const plain = rivers.map(r => ({ rec: { points: r.rec.points, stride: r.rec.stride, mouths: r.rec.mouths ?? [] },
        arc: r.arc, rid: r.rid, levels: r.levels, srcLevel: r.srcLevel, destLevel: r.destLevel }));
    const prep = await f._prepare(plain);
    const groups = fieldPageGroups(prep.keys, prep.pageRivers, f.layout);
    return { rivers: rivers.length, pages: prep.keys.length, groups: groups.length,
        largestPageShare: prep.keys.length ? groups[0].pages / prep.keys.length : 0, largest: groups.slice(0, 20) };
}
