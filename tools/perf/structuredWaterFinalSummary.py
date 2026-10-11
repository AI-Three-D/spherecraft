import collections
import hashlib
import json
import math
import pathlib
import statistics
import struct

root = pathlib.Path('tools/perf/structured-terrain-results/water-final-attempt')
old = json.loads((root / 'before-game/browser.json').read_text())
new = json.loads((root / 'game/browser.json').read_text())
native = json.loads((root / 'native/report.json').read_text())
metrics = {'notes': [
    'Wet area counts positive conservative depth-mask cells times tangent-plane cell area, not bounding-circle area or a continuous integral.',
    'Before/after semantic views use different features, cameras and biomes because placement changed. Render timing differences do not establish a speedup.',
    'Driver caches and host activity are uncontrolled. Render fence timings include CPU, GPU and submission.',
    'Loader complete can mean timeout fallback. Final captured views separately require full exact residency.',
    'Only the default seed was tested in this attempt. Simulation native cases precede the medium-size population polish; solver equations are unchanged.',
]}
for label, report in [('before', old), ('after', new)]:
    lakes = report['world']['lakes']
    areas = sorted(lake['wetAreaM2'] for lake in lakes)
    neighbours = []
    for a in lakes:
        dot = max(sum(x*y for x,y in zip(a['centre'], b['centre'])) for b in lakes if b['id'] != a['id'])
        neighbours.append(math.acos(max(-1,min(1,dot))) * 131072)
    neighbours.sort()
    metrics[label] = {
        'lakes': len(lakes), 'rivers': len(report['world']['rivers']),
        'waterReadyMs': report['waterReadyMs'], 'loaderCompleteMs': report['initialTerrainMs'],
        'bootStatus': report.get('bootStatus'), 'worldPlacementMs': report['world']['timings']['totalMs'],
        'wetAreaM2': {k: areas[min(len(areas)-1, int(q*len(areas)))] for k,q in
                      [('minimum',0),('p10',.1),('median',.5),('p90',.9),('p99',.99),('maximum',1)]},
        'lakesWithNeighbourWithin1km': sum(d<1000 for d in neighbours),
        'nearestNeighbourM': {'minimum': neighbours[0], 'median': statistics.median(neighbours), 'p90': neighbours[int(len(neighbours)*.9)]},
        'renderViews': [{'label': v['label'], 'readinessMs': v['readinessMs'],
                         'fullRenderFenceMedianMs': statistics.median(v['state']['fullRenderFenceMs']),
                         'exactVisibleRatio': v['state']['coverage']['exactVisibleRatio'],
                         'simulation': v['state'].get('simulation')} for v in report['views']],
        'errors': report['errors'], 'gpuErrors': report['gpuErrors'],
    }
metrics['largestWetAreaRatio'] = metrics['after']['wetAreaM2']['maximum'] / metrics['before']['wetAreaM2']['maximum']
metrics['native'] = {k:v for k,v in native.items() if k not in ['lakes','rivers','timings']}
metrics['tiers'] = dict(collections.Counter(b['tier'] for b in native['lakes']))
if (root/'detail-disabled/report.json').exists():
    disabled = json.loads((root/'detail-disabled/report.json').read_text())
    arrays = [struct.unpack('<16384f',(root/name/'shore-height.f32').read_bytes()) for name in ['native','detail-disabled']]
    delta = [abs(a-b)*5000 for a,b in zip(*arrays)]
    metrics['shoreDetail'] = {'note': 'Same world/atlas and tile, only the two added shoreline noise calls disabled in diagnostic shader creation. Full-stack height delta includes the nonlinear underwater bed cut.',
                              'onMedianMs': statistics.median(native['shoreWarmMs']), 'offMedianMs': statistics.median(disabled['shoreWarmMs']),
                              'onSamplesMs': native['shoreWarmMs'], 'offSamplesMs': disabled['shoreWarmMs'],
                              'maximumHeightDeltaM': max(delta), 'changedPixels': sum(v>1e-4 for v in delta)}
metrics['sourceValidation'] = {'servedFiles': len(new['sources']), 'mismatches': [r['pathname'] for r in new['sources'] if not pathlib.Path(r['pathname'].lstrip('/')).exists() or hashlib.sha256(pathlib.Path(r['pathname'].lstrip('/')).read_bytes()).hexdigest()!=r['sha256']]}
(root/'measurements.json').write_text(json.dumps(metrics,indent=2)+'\n')
print(json.dumps({k:v for k,v in metrics.items() if k in ['largestWetAreaRatio','tiers','shoreDetail','sourceValidation']},indent=2))
