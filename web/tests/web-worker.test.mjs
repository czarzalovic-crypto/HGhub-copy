import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv} from 'node:crypto';
import {safeTarget,remote,rpc,rewritePlaylist,media,decryptImage,createHandler} from '../worker/index.mjs';
const req=(cmd,args={},cookie='')=>new Request('https://app.example.com/api/rpc',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://app.example.com',Cookie:cookie},body:JSON.stringify({cmd,args})});
const ok=data=>Response.json({status:1,data});
test('rejects local addresses, alternate schemes and URL credentials',()=>{
 for(const url of ['https://127.0.0.1/a','https://2130706433/a','https://[::1]/a','http://cdn.example.com/a','https://foo.local/a','https://a:b@cdn.example.com/a','https://foo.chatgpt.site/a'])assert.throws(()=>safeTarget(url));
 assert.equal(safeTarget('https://cdn.example.com/a').hostname,'cdn.example.com');
});
test('revalidates redirects before fetching',async()=>{
 let count=0;
 await assert.rejects(remote('https://cdn.example.com/a',{},async()=>{count++;return new Response(null,{status:302,headers:{Location:'https://127.0.0.1/a'}})}));
 assert.equal(count,1);
});
test('never forwards account payload across origins',async()=>{
 await assert.rejects(remote('https://cdn.example.com/a',{method:'POST'},async()=>new Response(null,{status:307,headers:{Location:'https://other.example.com/a'}})),/跨站/);
});
test('rewrites master playlists, keys and relative media',()=>{
 const text='#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/index.m3u8"\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\nchild.m3u8\nseg.ts\n';
 const out=rewritePlaylist('https://cdn.example.com/path/master.m3u8',text);
 assert.match(out,/\/api\/media\/hls\?u=/);assert.match(out,/\/api\/media\/seg\?u=/);
 assert.ok(out.includes(encodeURIComponent('https://cdn.example.com/path/seg.ts')));
 assert.throws(()=>rewritePlaylist('https://cdn.example.com/list.m3u8','#EXTM3U\nhttps://127.0.0.1/a'));
});
test('drops derived HLS URLs from content steering and date range',()=>{
 const out=rewritePlaylist('https://cdn.example.com/a.m3u8','#EXTM3U\n#EXT-X-CONTENT-STEERING:SERVER-URI="https://evil.example.net/a"\n#EXT-X-DATERANGE:ID="a",X-ASSET-URI="https://evil.example.net/a",START-DATE="2026-11-11T00:00:00Z"');
 assert.ok(!out.includes('evil'));assert.ok(out.includes('START-DATE'));
});
test('rejects cross-origin JSON writes',async()=>{
 const r=req('api_login',{username:'u',password:'secret'});r.headers.set('Origin','https://evil.example.net');
 assert.equal((await rpc(r)).status,403);
});
test('maps search and clamps pagination',async()=>{
 let path;
 const r=await rpc(req('api_search',{q:'你好 &',page:-1,size:500}),async(_url,init)=>{path=JSON.parse(init.body).path;return ok({items:[]})});
 assert.equal(r.status,200);assert.ok(path.includes('page=1&size=100'));assert.ok(path.includes(encodeURIComponent('你好 &')));
});
test('keeps login tokens in HttpOnly cookies and out of JSON',async()=>{
 const r=await rpc(req('api_login',{username:'u',password:'p'}),async()=>ok({token:'private-token',user:{username:'u'}}));
 const c=r.headers.get('Set-Cookie');assert.match(c,/HttpOnly/);assert.match(c,/Secure/);assert.match(c,/SameSite=Strict/);
 assert.ok(!(await r.text()).includes('private-token'));
});
test('isolates sessions between requests',async()=>{
 const seen=[];const fetcher=async(_url,init)=>{seen.push(init.headers.Authorization||null);return ok({id:1})};
 await rpc(req('api_me',{},'hg-auth-0=one'),fetcher);await rpc(req('api_me'),fetcher);
 assert.deepEqual(seen,['Bearer one',null]);
});
test('normalizes new playback streams',async()=>{
 const r=await rpc(req('api_play',{id:5,ep:2}),async()=>ok({streams:{main:'https://cdn.example.com/a.m3u8'}}));
 assert.equal((await r.json()).data.video_url,'https://cdn.example.com/a.m3u8');
});
test('media forwards ranges and streams responses',async()=>{
 let range;
 const r=await media(new Request('https://app.example.com/api/media/seg?u='+encodeURIComponent('https://cdn.example.com/a.mp4'),{headers:{Range:'bytes=0-3'}}),async(_u,init)=>{range=init.headers.Range;return new Response(new Uint8Array([1,2,3,4]),{status:206,headers:{'Content-Type':'video/mp4','Content-Range':'bytes 0-3/100'}})});
 assert.equal(range,'bytes=0-3');assert.equal(r.status,206);assert.equal(r.headers.get('Content-Range'),'bytes 0-3/100');assert.equal((await r.arrayBuffer()).byteLength,4);
});
test('decodes padded and unpadded encrypted covers',async()=>{
 for(const padding of [true,false]){
  const input=Buffer.alloc(32,30);input.set([255,216,255,224]);
  const c=createCipheriv('aes-128-cbc','f5d965df75336270','97b60394abc2fbe1');c.setAutoPadding(padding);
  const encoded=Buffer.concat([c.update(input),c.final()]);
  assert.deepEqual(Buffer.from(await decryptImage(encoded)),input);
 }
});
test('serves app routes with CSP and no executable upstream HTML',async()=>{
 const handler=createHandler({'/index.html':{body:btoa('<html>HGhub</html>'),type:'text/html'}});
 const r=await handler.fetch(new Request('https://app.example.com/search'));
 assert.match(await r.text(),/HGhub/);assert.ok(r.headers.get('Content-Security-Policy').includes("object-src 'none'"));
});
