// node fieldArms.mjs OUTDIR TAG: writes the river field's capture configs (armReview.mjs) into OUTDIR,
// one per area so each run stays within one field radius: a (z 1400-6250), b (z 7900-12200), c (o04).
import fs from 'node:fs';
import path from 'node:path';
const here = path.dirname(new URL(import.meta.url).pathname), repo = path.resolve(here, '../../..');
const views = f => JSON.parse(fs.readFileSync(path.join(here, f), 'utf8')).views.map(({ note, ...v }) => v);
const pick = (list, names) => names.map(n => list.find(v => v.name === n));
const acc = views('acceptanceViews.json'), o3 = views('ownerViews-2026-11-03.json'), o4 = views('ownerViews-2026-11-04.json'), o5 = views('ownerViews-2026-11-05.json'), far = views('farViews-2026-11-05.json');
const A = [...acc, ...o3, ...pick(o5, ['o05-hill-terrace', 'o05-lake-crease', 'o05-poly-shore', 'o05-poly-triangles'])].sort((a, b) => Math.round(a.pos[1] / 1500) - Math.round(b.pos[1] / 1500) || a.pos[2] - b.pos[2]);
const B = [...pick(o5, ['o05-poly-wedge', 'o05-bend-bands', 'o05-groove-terrace', 'o05-poly-diagonal', 'o05-poly-corner', 'o05-mouth-trumpet', 'o05-mouth-lines', 'o05-mouth-top', 'o05-sand-wall', 'o05-side-trench', 'o05-mouth-edge', 'o05-water-streaks']), far[1]];
const C = [...o4, far[0]];
const out = process.argv[2], tag = process.argv[3] ?? 'f8';
const results = path.join(repo, 'tools/perf/structured-terrain-results/river-2026-11-05/field');
for (const [k, vs] of [['a', A], ['b', B], ['c', C]]) {
    fs.writeFileSync(path.join(out, `${tag}${k}.json`), JSON.stringify({ root: '/private/tmp/spherecraft-river-experiment', out: results, fixedQuality: true,
        arms: [{ name: tag + k, views: vs, modes: ['w10', '91+w10'],
            viewProbes: [{ label: 'sum', m: '/tools/perf/riverBanks/fieldProbe.js', e: 'fieldSummary', a: {} }] }] }, null, 1));
}

// Cost A/B: committed HEAD (git archive into HEAD_ROOT) and the working tree,
// the same 80 tiles and poses, one arm per run.
const accFile = JSON.parse(fs.readFileSync(path.join(here, 'acceptanceViews.json'), 'utf8'));
const genView = accFile.views.find(v => v.name === 'o29c-mouth-both-banks');
const gen = l => ({ m: '/tools/perf/riverBanks/regenTiming.js', e: 'fixedTilesGpu', label: l, a: { view: genView, tiles: 80 } });
const costViews = [...pick(o5, ['o05-lake-crease', 'o05-poly-shore']), ...pick(o3, ['o03-thalweg', 'o03-berm']), ...pick(acc, ['o29c-reach', 'o29c-mouth-corner']), ...far];
for (const [name, root] of [['cost-head', '/private/tmp/spherecraft-river-head'], ['cost-field', '/private/tmp/spherecraft-river-experiment']]) {
    fs.writeFileSync(path.join(out, `${tag}${name}.json`), JSON.stringify({ root, out: results, fixedQuality: true, tileKeys: accFile.tileKeys,
        arms: [{ name: tag + name, views: costViews, modes: [], probes: [gen('gen-warm'), gen('gen-1'), gen('gen-2')] }] }, null, 1));
}
