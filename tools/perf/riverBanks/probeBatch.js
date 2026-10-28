// tools/perf/riverBanks/probeBatch.js
//
// Page side (pageProbe.mjs): several probe calls in one page load, in order:
// calls = [{ m: '/tools/perf/riverBanks/MODULE.js', e: 'EXPORT', a: {args}, label }].
// Returns { label: result } (errors as { error }).
export async function batch({ calls }) {
    const out = {};
    for (const [i, c] of calls.entries()) {
        const key = c.label ?? `${i}:${c.e}`;
        try { out[key] = await (await import(c.m))[c.e](c.a); } catch (e) { out[key] = { error: String(e?.stack ?? e).slice(0, 400) }; }
    }
    return out;
}
