import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
const b=await build({entryPoints:['src/panel/components/ClientRecordCard.tsx'],bundle:true,platform:'node',format:'cjs',write:false,external:['react','react/jsx-runtime'],plugins:[{name:'test-boundaries',setup(build){
 build.onResolve({filter:/(?:^|\/)supabase$/},()=>({path:'db',namespace:'test'}));
 build.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export const supabase = {from(){throw Error("Unexpected database call")}}',loader:'js'}));
 build.onLoad({filter:/ClientRecordCard\.tsx$/},async args=>({contents:await fs.readFile(args.path,'utf8')+'\nexport { buildContactPatch };',loader:'tsx'}));
}}]});
const m={exports:{}};new Function('require','module','exports',b.outputFiles[0].text)(createRequire(import.meta.url),m,m.exports);
const {buildContactPatch}=m.exports;
const parserBundle=await build({entryPoints:['src/lib/claude-parser.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {parseClaudeResponse}=await import(`data:text/javascript;base64,${Buffer.from(parserBundle.outputFiles[0].text).toString('base64')}`);
const customer={id:'test',country:'Nicaragua',language:'Spanish',destination_port:'Corinto',budget_usd:10000,customer_stage:'negotiating',name:'Test'};
const parse=record=>parseClaudeResponse(`[Client Record]\n${record}\n[WhatsApp Reply]\nSí, negro.\n[Full Translation & Strategy]\n是的，黑色。`).clientRecord;
test('No change and absent fields produce no clearing or spurious stage update',()=>{
 assert.deepEqual(buildContactPatch(parse('No change'),customer),{});
 assert.deepEqual(buildContactPatch(parse('Country: No change\nLanguage: Unchanged\nDestination Port: 不变'),customer),{});
 assert.deepEqual(buildContactPatch(parse('Country: Unknown\nBudget: Unknown'),customer),{});
 assert.deepEqual(buildContactPatch(parse('Destination Port: Corinto'),customer),{});
});
test('only actually changed fields become patches; omission preserves established facts',()=>{
 assert.deepEqual(buildContactPatch(parse('Destination Port: La Guaira'),customer),{destination_port:'La Guaira'});
 assert.deepEqual(buildContactPatch(parse('Budget: 12000 USD'),customer),{budget_usd:12000});
});
