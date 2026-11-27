# Prints grassCanopyCorrection's body for a per-channel fit (teacherFit2.py output).
# python3 tools/perf/grass/teacherFitWgsl.py FIT.json
import json
import sys

fit = json.load(open(sys.argv[1]))['rgb']
names = ['1', 'ls', 'ls * ls', 'hot', 'hot * ls', 'sunUp', 'sunUp * ls', 'ld', 'ld * ld']
terms = []
for i, name in enumerate(names):
    v = ', '.join(f'{fit[c][i]:.5f}' for c in range(3))
    terms.append(f'vec3<f32>({v})' + ('' if name == '1' else f' * ({name})'))
print('    let k = ' + '\n        + '.join(terms) + ';')
