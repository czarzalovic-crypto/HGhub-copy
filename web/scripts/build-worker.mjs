import {readFile,writeFile,mkdir,readdir,copyFile} from 'node:fs/promises';
import {join,extname} from 'node:path';
const assets={};
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon','.webp':'image/webp'};
async function collect(dir,prefix='') {
 for(const item of await readdir(dir,{withFileTypes:true})) {
  const key=prefix+'/'+item.name, path=join(dir,item.name);
  if(item.isDirectory())await collect(path,key);
  else assets[key]={type:mime[extname(item.name)]||'application/octet-stream',body:(await readFile(path)).toString('base64')};
 }
}
await collect('dist/client');
await mkdir('dist/server',{recursive:true});
await mkdir('dist/.openai',{recursive:true});
let worker=await readFile('worker/index.mjs','utf8');
worker=worker.replace('export default createHandler();',`export default createHandler(${JSON.stringify(assets)});`);
await writeFile('dist/server/index.js',worker);
await copyFile('.openai/hosting.json','dist/.openai/hosting.json');
console.log('Worker and embedded browser assets built.');
