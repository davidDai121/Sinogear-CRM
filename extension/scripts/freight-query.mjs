// Read-only query; writes an immutable local record for every result, including failure.
import {build} from 'esbuild';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
const here=dirname(fileURLToPath(import.meta.url));
const [origin,destination,vehicle,propulsion='unknown',quantity='1',container='40HC',output]=process.argv.slice(2);
if(!origin||!destination||!vehicle){console.error('Usage: node extension/scripts/freight-query.mjs ORIGIN DESTINATION VEHICLE [fuel|bev|phev|unknown] [QUANTITY] [40HC|40GP|20GP] [OUTPUT_DIRECTORY]');process.exit(2);}
const bundled=await build({entryPoints:[resolve(here,'../src/lib/freight-query.ts')],bundle:true,platform:'node',format:'esm',write:false});
const {queryFreight}=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const result=await queryFreight({origin,destination,vehicle,propulsion,quantity:Number(quantity),container});
const folder=output?resolve(output):resolve(here,'../../分析导出/运费记录');await mkdir(folder,{recursive:true});
const record={id:randomUUID(),...result};const path=resolve(folder,record.id+'.json');
await writeFile(path,JSON.stringify(record,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({path,...record},null,2));
