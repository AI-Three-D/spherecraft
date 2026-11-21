#!/usr/bin/env python3
"""Serve the game with experimental terrain functions for interactive review.

The replacement is fixed at startup and reaches the terrain and water shaders
before either initializes. It does not edit the game's runtime shader file.
"""

import argparse
import functools
import hashlib
import http.server
import json
import math
from pathlib import Path
import socketserver
from urllib.parse import parse_qs, urlsplit


ROOT = Path(__file__).resolve().parents[3]
MODULE = Path("templates/terrain-shaders/features/featureMountains.wgsl.js")
SITES = {
    "1": ([46179.1189, -24430.3862, -134034.4821], [32912.0007, -32417.0834, -123729.3259]),
    "2": ([37046.7593, 117236.5801, 69169.5822], [37126.3553, 117156.5862, 69140.1634]),
    "3": ([-121290.438, 20861.9553, 51912.3074], [-116776.661, 23121.7789, 56099.5079]),
    "4": ([35841, -29989, -133981], [46360, -26590, -121590]),
    "5": ([31248.695, -35960.8, -124002.758], [29524.156, -35974.812, -124051.077]),
    "6": ([33642.514, -20742.001, -126475.615], [33281.967, -25774.757, -125120.179]),
    "7": ([26717.09, -20864.775, -127224.24], [33375.785, -24090.792, -125472.876]),
    "8": ([19710.554, -38397.182, -127990.608], [33308.91, -27548.722, -125221.465]),
    "9": ([-129148.76081539638, 21225.761858447975, -17416.5158076027], [-129147.91466254671, 21140.190051783924, -17360.295260383682]),
    "10": ([29030.2, -30349.2, -126440.6], [14886.7, -39277.6, -120916.3]),
    "11": ([25868.1, -32000.4, -129421.6], [27830.9, -41562.1, -114758.9]),
    "12": ([33889.7, -28515.3, -128039.0], [20216.4, -32426.9, -117646.1]),
    "13": ([-71313.2, -13048.7, -112234.3], [-71316.7, -13049.9, -112228.3]),
    "14": ([-70004.7336203164, -15365.876114312854, -111290.49153448884], [-70144.87275800561, -15282.79178201531, -111186.11180128648]),
    "15": ([-97814.44481471615, 64056.98787865255, -61952.79149080376], [-96972.18603206, 68757.25328164, -56740.82294346]),
    "16": ([-133789.9, -31404.9, 14286.1], [-127877, -25906.5, 20819.7]),
    "17": ([8125.7, -123948.9, -77768.6], [1299.8, -105354.8, -78670.3]),
    "18": ([-129271.3, -25518.7, 23305.9], [-128323.9, -25997, 20892.4]),
}

SITE_SUN = {"16": 0.4, "17": 0.4, "18": 0.4}
SITE_FOV = {"16": 60, "17": 60, "18": 60}

SITE_UP = {
    "9": [-0.9781395290140638, 0.16075846625321924, -0.13190821546840265],
    "14": [-0.528848499836192, -0.11608101497531845, -0.8407404249727196],
    "15": [-0.7392152840398131, 0.4840993022978231, -0.4681972120343084],
}

for pose_file in ("inland-review-poses.json", "fjord-fell-review-poses.json", "tectonic-review-poses.json"):
    with Path(__file__).with_name(pose_file).open(encoding="utf-8") as file:
        for number, pose in json.load(file).items():
            SITES[number] = (pose["position"], pose["target"])
            SITE_UP[number] = pose["up"]
            SITE_FOV[number] = pose["fov"]
            SITE_SUN[number] = pose.get("sun", 0.43)


def replace_range(source, variant):
    start = source.find("fn mtnRange_d(")
    opening = source.find("{", start)
    if start < 0 or opening < 0 or "`" in variant or "${" in variant:
        raise ValueError("Invalid range shader or replacement")
    depth = 1
    end = opening + 1
    while depth and end < len(source):
        depth += (source[end] == "{") - (source[end] == "}")
        end += 1
    if depth or "fn mtnRange_d(" not in variant:
        raise ValueError("Unbalanced original function or missing replacement")
    return source[:start] + variant + source[end:]


def foothill_module(variant, band):
    mask = "dSmoothstep(FOOTHILL_TT_START, FOOTHILL_TT_FULL, regional.terrainType)"
    if "`" in variant or "${" in variant:
        raise ValueError("Invalid foothill replacement")
    if band:
        if not all(math.isfinite(n) for n in band) or band[0] >= band[1]:
            raise ValueError("Foothill band must contain increasing finite numbers")
        mask = f"dSmoothstep({band[0]}, {band[1]}, regional.terrainType)"
    return f"export function createFoothillWgsl() {{ return {{ band: {json.dumps(mask)}, calculation: `{variant}` }}; }}"


def comparison_module(source, variant):
    """Apply the valley modifier to either runtime range model at startup."""
    name = "export function createTerrainFeatureMountains("
    if source.count(name) != 1:
        raise ValueError("Cannot wrap the terrain mountain factory")
    source = source.replace(name, "function createTerrainFeatureMountainsBase(", 1)
    helper = variant[variant.index("fn rangeDirectionalNoise_d("):variant.index("fn baseRange_d(")]
    modifier = variant[variant.index("fn valleyRange_d("):]
    return source + f'''
const valleyNoiseSource = {json.dumps(helper)};
const valleyModifierSource = {json.dumps(modifier)};
export function createTerrainFeatureMountains(options = {{}}) {{
    const params = new URLSearchParams(globalThis.location?.search ?? '');
    if (!params.get('terrainRework')?.split(',').includes('valleys')) return createTerrainFeatureMountainsBase(options);
    const source = createTerrainFeatureMountainsBase({{ ...options, rangeValleys: false }});
    const start = source.indexOf('fn mtnRange_d('), open = source.indexOf('{{', start);
    let depth = 1, end = open + 1;
    while (depth && end < source.length) {{
        if (source[end] === '{{') depth++;
        if (source[end] === '}}') depth--;
        end++;
    }}
    if (start < 0 || open < 0 || depth) throw new Error('Cannot locate mountain range function');
    const base = source.slice(start, end).replace('fn mtnRange_d(', 'fn baseRange_d(');
    const helper = source.includes('fn rangeDirectionalNoise_d(') ? '' : valleyNoiseSource;
    return source.slice(0, start) + helper + base + valleyModifierSource + source.slice(end);
}}
'''


def comparison_coast_module(source, relief, coves, canyon, dunes):
    """Select coastal geometry before terrain and water compile."""
    name = "export function createLakeLandBase("
    if (source.count(name) != 1 or (relief is not None and "TERRAIN_REWORK_COAST_RELIEF_TRIAL" not in relief)
            or (coves is not None and "TERRAIN_REWORK_COAST_MASK_TRIAL" not in coves) or "TERRAIN_REWORK_CANYON_TRIAL" not in canyon
            or "TERRAIN_REWORK_DUNES_TRIAL" not in dunes):
        raise ValueError("Cannot wrap coastal terrain shader")
    source = source.replace(name, "function createLakeLandBaseOriginal(", 1)
    return source + f"""
const coastalReliefTrial = {json.dumps(relief)};
const coveTrial = {json.dumps(coves)};
const canyonTrial = {json.dumps(canyon)};
const dunesTrial = {json.dumps(dunes)};
export function createLakeLandBase(options = {{}}) {{
    const params = new URLSearchParams(globalThis.location?.search ?? '');
    const selected = new Set(params.get('terrainRework')?.split(','));
    const customCoast = coastalReliefTrial !== null && selected.has('coast');
    const customCoves = coveTrial !== null && selected.has('coves');
    let source = createLakeLandBaseOriginal({{
        ...options,
        landformDetails: {{
            ...options.landformDetails,
            ...(customCoast ? {{ coastalHills: false }} : {{}}),
            ...(customCoves ? {{ coves: false }} : {{}}),
        }},
    }});
    if (customCoves) {{
        const anchor = 'let regional = foundationData.regional;';
        if (!source.includes(anchor)) throw new Error('Cannot locate coastal regional field');
        source = source.replace(anchor, 'var regional = foundationData.regional;\\n        ' + coveTrial);
    }}
    if (customCoast) {{
        const anchor = 'var b0 = select(dConst(0.0), regional.baseElevation * amp.continentalShelf, terrainFeatureOn(TF_CONTINENT_RELIEF));';
        if (!source.includes(anchor)) throw new Error('Cannot locate coastal relief band');
        source = source.replace(anchor, anchor + '\\n        ' + coastalReliefTrial);
    }}
    if (selected.has('canyon')) {{
        const functionAnchor = 'fn landBands_d(seed: i32, unitDir: vec3<f32>) -> LandBands {{';
        if (!source.includes(functionAnchor)) throw new Error('Cannot locate canyon insertion');
        source = source.replace(functionAnchor, canyonTrial + '\\n' + functionAnchor);
        if (canyonTrial.includes('fn canyonCompose_d(')) {{
            const anchor = 'out.b0 = b0;';
            if (!source.includes(anchor)) throw new Error('Cannot locate canyon composition');
            source = source.replace(anchor, anchor + '\\n        out = canyonCompose_d(unitDir, seed, regional, out);');
        }} else if (canyonTrial.includes('fn canyonLand_d(')) {{
            // Regional canyon country: after the large landforms (so it can
            // avoid mountains), counted as erosion relief, calming the
            // rolling and meso relief on the tableland.
            const anchors = ['b0 += bigHillsH + mountainsH;', 'let relief = foothillsH + bigHillsH + mountainsH;', 'out.b2 = b2;'];
            if (!anchors.every(a => source.includes(a))) throw new Error('Cannot locate canyon land hooks');
            source = source.replace(anchors[0], anchors[0] + '\\n        let canyon = canyonLand_d(unitDir, seed, regional, foothillsH + bigHillsH + mountainsH);\\n        b0 += canyon.h;');
            source = source.replace(anchors[1], 'let relief = foothillsH + bigHillsH + mountainsH + canyon.relief;');
            source = source.replace(anchors[2], 'out.b2 = dMul(b2, canyon.calm);\\n        out.b3 = dMul(out.b3, canyon.calm);');
        }} else {{
            const heightAnchor = 'let bigHillsH = featureBigHillsHeight_d(unitDir, seed, amp);';
            if (!source.includes(heightAnchor)) throw new Error('Cannot locate canyon insertion');
            source = source.replace(heightAnchor, 'b0 += canyonNetwork_d(unitDir, seed, regional);\\n        ' + heightAnchor);
        }}
    }}
    if (selected.has('dunes')) {{
        // Sand seas: after erosion and the other bands; calm what sand fills.
        // Sand smooths only the fine, zero-mean meso band. The rolling band
        // and the erosion change carry mean offsets; scaling them sank whole
        // regions by hundreds of metres.
        const functionAnchor = 'fn landBands_d(seed: i32, unitDir: vec3<f32>) -> LandBands {{';
        const anchors = ['let relief = foothillsH + bigHillsH + mountainsH;', 'out.b0 = b0;'];
        if (!source.includes(functionAnchor) || !anchors.every(a => source.includes(a))) throw new Error('Cannot locate dune hooks');
        source = source.replace(functionAnchor, dunesTrial + '\\n' + functionAnchor);
        source = source.replace(anchors[0], anchors[0] + '\\n        let dunes = duneField_d(unitDir, seed, regional, relief, region.coord);');
        source = source.replace(anchors[1], 'out.b2 = out.b2 + dunes.h;\\n        out.b3 = dMul(out.b3, dunes.calm);\\n        ' + anchors[1]);
    }}
    return source;
}}
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("variant", type=Path, nargs="?", help="Optional WGSL range replacement function")
    parser.add_argument("--foothills", type=Path, help="Optional WGSL foothill replacement")
    parser.add_argument("--band", type=float, nargs=2, help="Foothill mask start and full values")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--compare", action="store_true", help="Enable independent terrainRework URL selections")
    parser.add_argument("--compare-variant", type=Path, help="Override the valley WGSL used by --compare")
    parser.add_argument("--coast-variant", type=Path, help="Override the coastal WGSL used by --compare")
    parser.add_argument("--cove-variant", type=Path, help="Override the cove WGSL used by --compare")
    parser.add_argument("--canyon-variant", type=Path, help="Override the canyon WGSL used by --compare")
    parser.add_argument("--dunes-variant", type=Path, help="Override the dune WGSL used by --compare")
    args = parser.parse_args()
    modules = {}
    if (args.compare_variant or args.coast_variant or args.cove_variant or args.canyon_variant
            or args.dunes_variant) and not args.compare:
        parser.error("--compare-variant and coastal variants require --compare")
    if args.compare and (args.variant or args.foothills or args.band):
        parser.error("--compare cannot be combined with shader replacements")
    if args.compare:
        if args.compare_variant:
            source = (ROOT / MODULE).read_text(encoding="utf-8")
            valley = args.compare_variant.read_text(encoding="utf-8")
            modules["/" + MODULE.as_posix()] = comparison_module(source, valley).encode("utf-8")
        coast_module = Path("templates/terrain-shaders/base/lakeLandBase.wgsl.js")
        coast = args.coast_variant.read_text(encoding="utf-8") if args.coast_variant else None
        coves = args.cove_variant.read_text(encoding="utf-8") if args.cove_variant else None
        canyon_path = args.canyon_variant or ROOT / "tools/perf/terrainRework/canyon-trial.wgsl"
        canyon = canyon_path.read_text(encoding="utf-8")
        dunes_path = args.dunes_variant or ROOT / "tools/perf/terrainRework/dunes-trial.wgsl"
        dunes = dunes_path.read_text(encoding="utf-8")
        modules["/" + coast_module.as_posix()] = comparison_coast_module(
            (ROOT / coast_module).read_text(encoding="utf-8"), coast, coves, canyon, dunes).encode("utf-8")
    if args.variant:
        variant = args.variant.read_text(encoding="utf-8")
        modules["/" + MODULE.as_posix()] = replace_range((ROOT / MODULE).read_text(encoding="utf-8"), variant).encode("utf-8")
    if args.band and not args.foothills:
        parser.error("--band requires --foothills")
    if args.foothills:
        foothills = args.foothills.read_text(encoding="utf-8")
        p = Path('templates/terrain-shaders/features/featureFoothills.wgsl.js')
        modules["/" + p.as_posix()] = foothill_module(foothills, args.band).encode("utf-8")

    class Handler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def end_headers(self):
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            super().end_headers()

        def do_GET(self):
            request = urlsplit(self.path)
            if request.path in modules:
                data = modules[request.path]
                self.send_response(200)
                self.send_header("Content-Type", "application/javascript; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            site = parse_qs(request.query).get("terrainPreviewSite", [""])[0]
            if request.path == "/wizard_game/standalone.html" and (site in SITES or args.compare):
                html = (ROOT / "wizard_game/standalone.html").read_text(encoding="utf-8")
                script = ""
                if site in SITES:
                    position, target = SITES[site]
                # Wait for the game to initialize, then put the free camera at
                # the review pose. Reapply briefly while startup completes;
                # afterwards the normal camera controls belong to the user.
                    script = f"""<script>
                    const waitForTerrainPreview = setInterval(() => {{
                        if (!window.gameEngine?.waterService?._sampler ||
                            !window.gameEngine?.renderer?.quadtreeTileManager || !window.qtDiag?.regional) return;
                        const loading = document.getElementById('loading-screen');
                        if (loading && getComputedStyle(loading).visibility !== 'hidden') return;
                        clearInterval(waitForTerrainPreview);
                        let [p, t] = [{position}, {target}];
                        let viewUp = {json.dumps(dict(zip(["x", "y", "z"], SITE_UP[site]))) if site in SITE_UP else "{x:0,y:1,z:0}"}, viewFov = {SITE_FOV.get(site, 'window.qtDiag.regional.camera().fov')};
                        try {{
                            const saved = JSON.parse(sessionStorage.getItem('terrainReworkCamera') || 'null');
                            sessionStorage.removeItem('terrainReworkCamera');
                            const valid = v => v && ['x','y','z'].every(k => Number.isFinite(v[k]));
                            if (saved && valid(saved.position) && valid(saved.target) && valid(saved.up) && Number.isFinite(saved.fov)) {{
                                p = [saved.position.x,saved.position.y,saved.position.z];
                                t = [saved.target.x,saved.target.y,saved.target.z];
                                viewUp = saved.up; viewFov = saved.fov;
                            }}
                        }} catch (_) {{ sessionStorage.removeItem('terrainReworkCamera'); }}
                        const xyz = a => ({{x:a[0], y:a[1], z:a[2]}});
                        // Put the sun above the review site so the terrain is
                        // visible regardless of the starting time of day.
                        const g = window.gameEngine, s = g.starSystem, body = s?.currentBody;
                        if (body) {{
                            const o = g.planetConfig.origin ?? {{x:0,y:0,z:0}};
                            const rel = [p[0]-o.x, p[1]-o.y, p[2]-o.z];
                            const len = Math.hypot(...rel), up = rel.map(v => v / len);
                            s.paused = true; s.useGameTimeRotation = false;
                            let best = Infinity, rotation = 0;
                            for (let i = 0; i < 720; i++) {{
                                body.currentRotation = i * Math.PI * 2 / 720;
                                const d = body.getStarDirection(s.primaryStar).direction;
                                const score = Math.abs(d.x*up[0] + d.y*up[1] + d.z*up[2] - {SITE_SUN.get(site, 0.75)});
                                if (score < best) {{ best = score; rotation = body.currentRotation; }}
                            }}
                            body.currentRotation = rotation;
                        }}
                        const apply = () => window.qtDiag.regional.useCamera({{
                            position:xyz(p), target:xyz(t), up:viewUp, fov:viewFov
                        }});
                        apply();
                        const hold = setInterval(apply, 250);
                        setTimeout(() => clearInterval(hold), 3000);
                    }}, 500);
                </script>"""
                if args.compare:
                    script += """<script>
                    (() => {
                        const params = new URLSearchParams(location.search);
                        if (!params.has('terrainRework')) return;
                        const selected = new Set(params.get('terrainRework').split(',').filter(Boolean));
                        const panel = document.createElement('div');
                        Object.assign(panel.style, {position:'fixed', top:'12px', right:'12px', zIndex:'10000',
                            background:'rgba(8,20,30,.92)', color:'white', padding:'12px', border:'1px solid #6af',
                            borderRadius:'8px', font:'14px sans-serif'});
                        const title = document.createElement('div'); title.textContent = 'Terrain comparison';
                        title.style.marginBottom = '8px'; panel.appendChild(title);
                        for (const [name, text] of [['mountains','New mountain range'], ['foothills','New foothills'],
                            ['valleys','Mountain valleys'], ['rolling','Rolling hills'], ['coast','Coastal hills'], ['coves','Coves'], ['canyon','Canyon trial'], ['dunes','Sand sea (dunes) trial']]) {
                            const label = document.createElement('label'); label.style.display = 'block';
                            const input = document.createElement('input'); input.type = 'checkbox';
                            input.checked = selected.has(name);
                            input.addEventListener('change', () => {
                                if (input.checked) selected.add(name); else selected.delete(name);
                                const camera = window.qtDiag?.regional?.camera?.();
                                if (camera) sessionStorage.setItem('terrainReworkCamera', JSON.stringify(camera));
                                const url = new URL(location.href);
                                url.searchParams.set('terrainRework', ['mountains','foothills','valleys','rolling','coast','coves','canyon','dunes'].filter(x => selected.has(x)).join(','));
                                location.assign(url.href);
                            });
                            label.append(input, document.createTextNode(' ' + text)); panel.appendChild(label);
                        }
                        for (const [name, text, enabled] of [
                            ['tectonicRelief', 'Tectonic belts and uplands', gen => gen.tectonicRelief.enabled],
                            ['calderas', 'Caldera volcanoes', gen => gen.calderas.enabled],
                            ['fjords', 'Fjords', gen => gen.fjords],
                            ['fells', 'Fells', gen => gen.inlandLandforms.fells],
                            ['mesas', 'Mesa trial', gen => gen.inlandLandforms.mesas],
                            ['cuestas', 'Cuesta trial', gen => gen.inlandLandforms.cuestas],
                        ]) {
                            const label = document.createElement('label');
                            label.style.display = 'block';
                            const input = document.createElement('input');
                            input.type = 'checkbox';
                            input.checked = params.get(name) === '1';
                            const ready = setInterval(() => {
                                const gen = window.gameEngine?.terrainGenerator;
                                if (!gen) return;
                                clearInterval(ready);
                                input.checked = enabled(gen);
                            }, 250);
                            input.addEventListener('change', () => {
                                const camera = window.qtDiag?.regional?.camera?.();
                                if (camera) sessionStorage.setItem('terrainReworkCamera', JSON.stringify(camera));
                                const url = new URL(location.href);
                                url.searchParams.set(name, input.checked ? '1' : '0');
                                location.assign(url.href);
                            });
                            label.append(input, document.createTextNode(' ' + text));
                            panel.appendChild(label);
                        }
                        const note = document.createElement('div');
                        note.textContent = 'Changes reload at the same view.';
                        note.style.marginTop = '8px'; note.style.fontSize = '11px'; panel.appendChild(note);
                        document.body.appendChild(panel);
                    })();
                    </script>"""
                body = html.replace("</body>", script + "</body>", 1).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            super().do_GET()

    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(
        ("127.0.0.1", args.port), functools.partial(Handler, directory=str(ROOT))
    ) as server:
        if args.variant:
            digest = hashlib.sha256(variant.encode("utf-8")).hexdigest()
            print(f"Range variant SHA-256: {digest}", flush=True)
        if args.foothills:
            print(f"Foothill variant SHA-256: {hashlib.sha256(foothills.encode('utf-8')).hexdigest()}, band: {args.band}", flush=True)
        query = "lakeCells=1&terrainPreviewSite=1"
        if args.variant:
            query += "&terrainRework="
        if args.compare:
            query = "terrainPreviewSite=24"
        print(f"Preview: http://127.0.0.1:{args.port}/wizard_game/standalone.html?{query}", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
