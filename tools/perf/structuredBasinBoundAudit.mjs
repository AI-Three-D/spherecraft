// Read-only response to the rejected bowl. No production budgets, terrain,
// candidate levels or basin records are changed by this audit.
import fs from 'node:fs';

// Perlin's grad3 has L1 norm <=2, so a corner dot product is bounded by
// 2*max(abs(f-corner)). Convex fade interpolation is an expectation over
// independent corner coordinates. For each axis, the expected excess over
// 1/2 is q(t)=fade(t)*(1/2-t), t=min(f,1-f) in [0,1/2]. Thus
// |Perlin| <= 1 + 6*max(q). No sampled noise maximum is used here.
// Writing t=s/2 gives q=.625*s^3-1.09375*s^4+.5625*s^5-.09375*s^6.
// Its degree-6 Bernstein coefficients enclose the polynomial everywhere.
// One exact midpoint subdivision tightens their maximum to 5/128.
const coefficients=[0,0,0,1/32,5/96,1/24,0];
const rows=[coefficients];
while(rows.at(-1).length>1) {
    const previous=rows.at(-1);
    rows.push(previous.slice(1).map((v,i)=>(v+previous[i])/2));
}
const left=rows.map(r=>r[0]),right=rows.map(r=>r.at(-1)).reverse();
const qUpper=Math.max(...left,...right),noiseUpper=1+6*qUpper;
if(Math.abs(qUpper-5/128)>1e-14||Math.abs(noiseUpper-79/64)>1e-14) throw new Error('Bernstein certificate mismatch');
const output='tools/perf/structured-terrain-results/basin-preview';
const prior=JSON.parse(fs.readFileSync(`${output}/benchmark.json`));
const candidate=prior.basinPlan.candidates.find(c=>c.cell===prior.basin.cell);
const microCurrentM=24.4,microPossibleM=12.2*noiseUpper;
const report={
    affectsProduction:false,
    selectedCandidate:{naturalCentreM:candidate.naturalCentreM,certifiedLowerM:candidate.lowerM,
        conservativeGapM:candidate.naturalCentreM-candidate.lowerM,
        reliefErosionAllowanceM:-candidate.reliefErosionLowerM,mesoAllowanceM:candidate.mesoAllowanceM,
        finalMicroAllowanceM:microCurrentM,nominalWaterDepthM:prior.basin.depthM,
        rimMarginM:prior.basin.rimM,centreCutM:candidate.centreCutM},
    perlinCertificate:{method:'Convex fade expectation and Bernstein polynomial enclosure',
        coefficients,left,right,qUpper,noiseUpper,noiseUpperFraction:'79/64',
        appliesTo:'The current sphere Perlin gradient table and positive normalized FBM weights'},
    isolatedMicroBudgetOpportunity:{currentM:microCurrentM,possibleM:microPossibleM,
        centreCutIfOnlyThisAllowanceChangedM:candidate.centreCutM-(microCurrentM-microPossibleM)},
    conclusions:[
        'The round/deep bowl is rejected as a lake design; its numerical containment proof is separate.',
        'A tighter global noise proof alone saves only about 9.34 m here. It does not resolve the crater.',
        'Before adopting a smaller full micro budget, check all material envelopes, including nonlinear sand, and run complete final-height/containment validation.',
        'Further work should certify the uncut rim locally and compare candidate excavation, then construct a basin that follows the terrain.',
        'Do not soften guarantees using observed minima, retune the noise/erosion stack, or mask the depth problem with outline noise.',
    ],
};
fs.writeFileSync(`${output}/bound-audit.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify({conservativeGapM:report.selectedCandidate.conservativeGapM,
    provenNoiseUpper:noiseUpper,microPossibleM,
    centreCutAfterMicroOnlyM:report.isolatedMicroBudgetOpportunity.centreCutIfOnlyThisAllowanceChangedM,
    affectsProduction:report.affectsProduction},null,2));
