// A distance-time map from a surge.mjs run with rows: true and along: node surgeMap.mjs LOG
// LOG: surge.mjs's output. Rows are time, columns arc length down the river, values cm off the
// baked level: a wave going upstream is a diagonal toward lower s. Then the final state along
// the river: level off baked, solver and baked speed, solver and baked depth, baked level.
import fs from 'fs';
// prints a distance-time map from a surge log: columns s (downstream), rows t, cm off baked
const lines=fs.readFileSync(process.argv[2],'utf8').split('\n').filter(l=>l.startsWith('[{"t"'));
const rows=JSON.parse(lines[0]);
const ss=[...new Set(rows.flatMap(r=>(r.along||[]).map(a=>a.s)))].sort((a,b)=>a-b);
const step=Math.max(1,Math.ceil(ss.length/22)), cols=ss.filter((_,i)=>i%step==0);
console.log('t\\s   '+cols.map(s=>String(s).padStart(5)).join(''));
for(const r of rows){const m=new Map((r.along||[]).map(a=>[a.s,a]));console.log(String(r.t).padEnd(6)+cols.map(s=>String(m.get(s)?.dev??'.').padStart(5)).join('')+`  v${r.speed??''}/${r.baked??''}`);}
console.log('speed last'.padEnd(6)+cols.map(s=>String(new Map((rows.at(-1).along||[]).map(a=>[a.s,a])).get(s)?.v??'.').padStart(5)).join(''));
const last=rows.at(-1).along||[];
console.log('final state along the river: s dev(cm) v/vb(m/s) h/hb(m) W');
for(const a of last) if(a.s%16==0) console.log([a.s,a.dev,a.v+'/'+a.vb,a.h+'/'+a.hb,a.W].join('\t'));
