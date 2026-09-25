import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import asc from 'assemblyscript/asc';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const repo=path.resolve(root,'..');
await fs.rm(path.join(root,'dist'),{recursive:true,force:true});
await fs.cp(path.join(root,'public'),path.join(root,'dist'),{recursive:true});
await fs.mkdir(path.join(root,'dist/wasm'),{recursive:true});
const result=await asc.main([path.join(root,'assembly/classifier.ts'),'--outFile',path.join(root,'dist/wasm/classifier.wasm'),'--optimizeLevel','3','--shrinkLevel','1','--runtime','stub','--initialMemory','1','--maximumMemory','1']);
if(result.error){process.stderr.write(result.stderr.toString());throw result.error;}
await fs.mkdir(path.join(root,'dist/lib'),{recursive:true});
for(const [from,to] of [['sensor/mock_scenarios.js','mock_scenarios.js'],['algorithm/config.js','config.js'],['algorithm/trl_postprocessor.js','trl_postprocessor.js']]){
 await fs.copyFile(path.join(repo,'quickapp/velamotion_coach/src/common',from),path.join(root,'dist/lib',to));
}
await fs.mkdir(path.join(root,'dist/images'),{recursive:true});
for(const name of ['huangshan-desktop.jpg','huangshan-coach.jpg','huangshan-timeline.jpg'])await fs.copyFile(path.join(repo,'docs/images',name),path.join(root,'dist/images',name));
await fs.copyFile(path.join(repo,'LICENSE'),path.join(root,'dist/LICENSE.txt'));
await fs.writeFile(path.join(root,'dist/.nojekyll'),'');
const sourceHash=createHash('sha256');
for(const name of ['config.js','imu_features.js','tiny_classifier.js'])sourceHash.update(await fs.readFile(path.join(repo,'quickapp/velamotion_coach/src/common/algorithm',name)));
const binary=await fs.readFile(path.join(root,'dist/wasm/classifier.wasm'));
await fs.writeFile(path.join(root,'dist/build-info.json'),JSON.stringify({wasmBytes:binary.length,sha256:createHash('sha256').update(binary).digest('hex'),algorithmBaseline:'03f3543',algorithmSourceSha256:sourceHash.digest('hex'),engine:'AssemblyScript 0.28.20',input:'synthetic demo only'},null,2)+'\n');
console.log(`Built static website. WASM: ${binary.length} bytes.`);
