import {rpc,media} from '../worker/index.mjs';
const request=(cmd,args={})=>new Request('https://app.example.com/api/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cmd,args})});
const call=async(cmd,args)=>{const r=await rpc(request(cmd,args));if(!r.ok)throw Error(cmd+' failed');return (await r.json()).data};
const data=await call('api_feed',{page:1,size:1});const item=data.items[0];
console.log('feed: OK, items='+data.items.length);
const detail=await call('api_video',{id:item.id});console.log('detail: OK');
const cover=await media(new Request('https://app.example.com/api/media/img?u='+encodeURIComponent(item.cover)));
console.log('cover:',cover.status,cover.headers.get('Content-Type'),'bytes='+(await cover.arrayBuffer()).byteLength);
const search=await call('api_search',{q:'短剧',page:1,size:1});console.log('search: OK');
const info=await call('api_play',{id:item.id,ep:detail.episodes?.[0]?.ep_num||1});
if(!info.video_url)throw new Error('Missing playback URL');
const playlist=await media(new Request('https://app.example.com/api/media/hls?u='+encodeURIComponent(info.video_url)));
let text=await playlist.text();console.log('playlist:',playlist.status,'valid='+text.startsWith('#EXTM3U'));
let next=text.split('\n').find(x=>x&&!x.startsWith('#'));
if(next){
 let response=await media(new Request(new URL(next,'https://app.example.com')));
 if(response.headers.get('Content-Type')?.includes('mpegurl')){
  text=await response.text();next=text.split('\n').find(x=>x&&!x.startsWith('#'));
  response=await media(new Request(new URL(next,'https://app.example.com')));
 }
 const reader=response.body.getReader();const first=await reader.read();await reader.cancel();
 console.log('segment:',response.status,'first_chunk_bytes='+first.value?.byteLength);
}
