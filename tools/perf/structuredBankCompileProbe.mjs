/* global process */
import fs from 'node:fs';
import {setupLab} from '../../../terrain-lab/labsetup.mjs';
const started=performance.now(),{device}=await setupLab(process.argv[2]??'.');
await device.queue.onSubmittedWorkDone();
const result={setupAndFenceMs:performance.now()-started,root:process.argv[2]??'.',
    note:'First-use generator setup; compiler/driver caches uncontrolled. No feature or tile generation.'};
fs.writeFileSync(process.env.COMPILE_OUTPUT,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
process.exit(0);
