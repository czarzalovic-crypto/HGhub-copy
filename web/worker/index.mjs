const ORIGINS = ['https://huangguoai.com', 'https://huangguoai.ai'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
const enc = encodeURIComponent;
const json = (data, status = 200, headers = {}) => Response.json(data, {status, headers: {'Cache-Control':'no-store', ...headers}});
const cookie = (name, value, age = 86400) => `${name}=${enc(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
function cookies(request) {
  return Object.fromEntries((request.headers.get('Cookie') || '').split(';').map(s => {
    const i = s.indexOf('='); if(i < 0) return ['', ''];
    try { return [s.slice(0,i).trim(), decodeURIComponent(s.slice(i+1))]; } catch { return ['', '']; }
  }));
}
export function safeTarget(raw) {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  if(url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
    !host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':') || host.endsWith('.') ||
    /(^|\.)(localhost|local|internal|test|invalid|example|home\.arpa)$/.test(host) ||
    host.endsWith('.chatgpt.site')) throw new Error('不允许访问该媒体地址');
  return url;
}
export async function remote(raw, init = {}, fetcher = fetch) {
  let url = safeTarget(raw);
  for(let hop=0; hop<6; hop++) {
    const response = await fetcher(url.href, {...init, redirect:'manual', signal:AbortSignal.timeout(25000)});
    if(response.status >= 300 && response.status < 400 && response.status !== 304) {
      const location = response.headers.get('Location');
      await response.body?.cancel();
      if(!location) throw new Error('上游重定向无效');
      const next = safeTarget(new URL(location,url).href);
      if((init.method || 'GET') !== 'GET' && next.origin !== url.origin) throw new Error('拒绝跨站转发账号或请求数据');
      url = next; continue;
    }
    if(!response.ok && response.status !== 206) throw new Error(`上游请求失败 (HTTP ${response.status})`);
    return {response, url:url.href};
  }
  throw new Error('上游重定向次数过多');
}
function context(request) {
  const c = cookies(request);
  const base = ORIGINS.includes(c['hg-line']) ? c['hg-line'] : ORIGINS[0];
  return {base, token: c[`hg-auth-${ORIGINS.indexOf(base)}`] || ''};
}
async function edge(ctx, method, path, body, fetcher = fetch) {
  const headers = {'Content-Type':'application/json', Accept:'application/json', Referer:ctx.base+'/', 'User-Agent':UA};
  if(ctx.token) headers.Authorization = `Bearer ${ctx.token}`;
  const envelope = {method,path,body:body == null ? '' : btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(body)))),content_type:body == null ? '' : 'application/json'};
  const {response} = await remote(ctx.base+'/api/edge/request', {method:'POST', headers, body:JSON.stringify(envelope)},fetcher);
  const value = await response.json();
  if(value?.status !== 1) throw new Error(value?.msg || '接口返回失败');
  return value.data;
}
const num = (v, def=1, max=2147483647) => Math.min(max,Math.max(1,Math.floor(Number(v)||def)));
const normalizePlay = data => {
  if(data && typeof data === 'object') {
    data.video_url ||= data.streams?.main || '';
    data.video_url_hevc ||= data.streams?.hevc || '';
  }
  return data;
};
export async function rpc(request, fetcher = fetch) {
  const origin = request.headers.get('Origin');
  if(origin && origin !== new URL(request.url).origin) return json({error:'拒绝跨站请求'},403);
  if(request.method !== 'POST') return json({error:'仅支持 POST'},405);
  if(!request.headers.get('Content-Type')?.startsWith('application/json')) return json({error:'需要 JSON 请求'},415);
  const raw = await request.text();
  if(raw.length > 16384) return json({error:'请求过大'},413);
  const {cmd,args:a={}} = JSON.parse(raw);
  const ctx = context(request);
  const get = path => edge(ctx,'GET',path,null,fetcher);
  const post = (path,body=null) => edge(ctx,'POST',path,body,fetcher);
  const auth = (method,path,body=null) => {
    if(!ctx.token) throw new Error('请先登录');
    return edge(ctx,method,path,body,fetcher);
  };
  const page = num(a.page), size = num(a.size,20,100), id = num(a.id), ep = num(a.ep);
  let data;
  const headers = new Headers();
  switch(cmd) {
    case 'app_boot': {
      let user=null;
      if(ctx.token) {try{user=await get('/api/account/me');}catch{headers.append('Set-Cookie',cookie(`hg-auth-${ORIGINS.indexOf(ctx.base)}`,'',0));}}
      data={user,logged_in:!!user,base:ctx.base,strict_security:true,cli_relaxed:false};break;
    }
    case 'security_set': data=true; break;
    case 'line_state': data={base:ctx.base,default:ORIGINS[0],fixed:ORIGINS.map((url,i)=>({name:`固定线路 ${i+1}`,url}))}; break;
    case 'line_set':
      if(!ORIGINS.includes(a.url)) throw new Error('请选择固定线路');
      headers.append('Set-Cookie',cookie('hg-line',a.url));for(let i=0;i<ORIGINS.length;i++)headers.append('Set-Cookie',cookie(`hg-auth-${i}`,'',0));data=a.url;break;
    case 'line_mirrors': data={source:'',items:ORIGINS.map(url=>({url,host:new URL(url).host}))}; break;
    case 'line_probe':
      if(!Array.isArray(a.urls) || a.urls.length>4) throw new Error('线路数量无效');
      data=await Promise.all(a.urls.map(async url=>{
        if(!ORIGINS.includes(url)) return {url,ok:false,ms:0,error:'仅支持固定线路'};
        const start=Date.now();try{await edge({base:url,token:''},'GET','/api/videos?page=1&size=1',null,fetcher);return{url,ok:true,status:200,ms:Date.now()-start};}
        catch{return{url,ok:false,ms:Date.now()-start,error:'线路暂不可用'};}
      }));break;
    case 'api_login': case 'api_register': {
      if(typeof a.username!=='string' || typeof a.password!=='string' || !a.username || !a.password) throw new Error('请输入用户名和密码');
      const body={username:a.username,password:a.password};
      if(cmd==='api_register') {body.confirm_password=a.password;if(a.email)body.email=a.email;}
      const result=await post(cmd==='api_login'?'/api/account/loginByPassword':'/api/account/registerByPassword',body);
      if(!result.token || typeof result.token!=='string' || result.token.length>3500) throw new Error('登录响应无效');
      headers.append('Set-Cookie',cookie(`hg-auth-${ORIGINS.indexOf(ctx.base)}`,result.token));
      data={user:result.user};break;
    }
    case 'api_logout':
      try{await post('/api/account/logout');}catch{/* Always clear local session. */}
      headers.append('Set-Cookie',cookie(`hg-auth-${ORIGINS.indexOf(ctx.base)}`,'',0));data={ok:true};break;
    case 'api_me':data=await get('/api/account/me');break;
    case 'api_feed':data=await get(`/api/videos?page=${page}&size=${size}`);break;
    case 'api_category':data=await get(`/api/videos/category/${enc(String(a.cate))}?page=${page}&size=${size}`);break;
    case 'api_rank':data=await get(`/api/ranks/${['hot','recommend','potential'].includes(a.kind)?a.kind:'hot'}`);break;
    case 'api_search':data=await get(`/api/search?q=${enc(String(a.q||'').slice(0,200))}&page=${page}&size=${size}`);break;
    case 'api_posts':data=await get(`/api/posts?page=${page}&size=${size}`);break;
    case 'api_post':data=await get(`/api/posts/${id}`);break;
    case 'api_video':data=await get(`/api/videos/${id}`);break;
    case 'api_play': {
      let primary, failure;
      try{primary=normalizePlay(await post(`/api/videos/${id}/episodes/${ep}/playback`,{}));if(primary?.video_url){data=primary;break;}}catch(e){failure=e;}
      try{const legacy=normalizePlay(await get(`/api/videos/${id}/play?ep=${ep}&page_texts=0`));data=legacy?.video_url||!primary?legacy:primary;}
      catch{if(!primary)throw failure||new Error('播放地址获取失败');data=primary;}break;
    }
    case 'api_comments':data=await get(`/api/videos/${id}/comments?ep=${ep}&page=${page}&size=${size}`);break;
    case 'api_post_comments':data=await get(`/api/posts/${id}/comments?page=${page}&size=${size}`);break;
    case 'api_comment_send': {
      const body={text:String(a.text||'').slice(0,3000)};
      if(Number(a.replyId)>0)body.reply_id=num(a.replyId);
      data=await auth('POST',`/api/videos/${id}/comments${body.reply_id?'':`?ep=${ep}`}`,body);break;
    }
    case 'api_like':data=await auth(a.on?'POST':'DELETE',`/api/videos/${id}/like?ep=${ep}`);break;
    case 'api_collect':data=await auth(a.on?'POST':'DELETE',`/api/videos/${id}/collect`);break;
    case 'api_follow':data=await auth(a.on?'POST':'DELETE',`/api/users/${num(a.uid)}/follow`);break;
    case 'api_post_like':data=await auth(a.on?'POST':'DELETE',`/api/posts/${id}/like`);break;
    case 'api_post_collect':data=await auth(a.on?'POST':'DELETE',`/api/posts/${id}/collect`);break;
    case 'cache_clear':data=null;break;
    case 'net_diag': {
      const start=Date.now();try{await get('/api/videos?page=1&size=1');data={web:true,connected:true,elapsed_ms:Date.now()-start};}catch{data={web:true,connected:false,elapsed_ms:Date.now()-start};}break;
    }
    case 'check_update':data={current:'1.2.1',latest:'1.2.1',has_update:false,url:'',name:'网页版自动更新'};break;
    default:return json({error:'未知操作'},404);
  }
  headers.set('Cache-Control','no-store');
  return Response.json({data}, {headers});
}
function kind(bytes) {
  if(bytes[0]===255&&bytes[1]===216)return'image/jpeg';
  if(bytes[0]===137&&bytes[1]===80)return'image/png';
  const tag=new TextDecoder().decode(bytes.slice(0,12));
  if(tag.startsWith('GIF8'))return'image/gif';
  if(tag.startsWith('RIFF')&&tag.endsWith('WEBP'))return'image/webp';
  return null;
}
export async function decryptImage(bytes) {
  if(kind(bytes))return bytes;
  if(!bytes.length || bytes.length%16)throw new Error('封面格式无效');
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode('f5d965df75336270'),'AES-CBC',false,['encrypt','decrypt']);
  // Append an encrypted padding block so WebCrypto can also decode unpadded legacy images.
  const tail=new Uint8Array(await crypto.subtle.encrypt({name:'AES-CBC',iv:bytes.slice(-16)},key,new Uint8Array(16).fill(16))).slice(0,16);
  const padded=new Uint8Array(bytes.length+16);padded.set(bytes);padded.set(tail,bytes.length);
  let plain=new Uint8Array(await crypto.subtle.decrypt({name:'AES-CBC',iv:new TextEncoder().encode('97b60394abc2fbe1')},key,padded));
  const pad=plain[plain.length-1];
  if(pad>0&&pad<=16&&plain.slice(-pad).every(v=>v===pad))plain=plain.slice(0,plain.length-pad);
  if(!kind(plain))throw new Error('封面格式无效');
  return plain;
}
export function rewritePlaylist(base,text) {
  if(!text.replace(/^\uFEFF/,'').startsWith('#EXTM3U'))throw new Error('响应不是播放列表');
  const wrap=(target)=>{
    const url=safeTarget(new URL(target,base).href).href;
    return `/api/media/${/\.m3u8(?:[?#]|$)/i.test(url)?'hls':'seg'}?u=${enc(url)}`;
  };
  return text.replace(/^\uFEFF/,'').split(/\r?\n/).map(line=>{
    if(line.startsWith('#EXT-X-CONTENT-STEERING:'))return '';
    if(line.startsWith('#EXT-X-DATERANGE:')) {
      const [tag,...rest]=line.split(':');
      const attrs=rest.join(':').match(/(?:[^,"]|"[^"]*")+/g)||[];
      return tag+':'+attrs.filter(a=>!/(?:URI|X-ASSET-LIST)\s*=/.test(a.split('=')[0]+'=')).join(',');
    }
    if(line.startsWith('#'))return line.replace(/URI="([^"]+)"/g,(_,uri)=>`URI="${wrap(uri)}"`);
    return line.trim()?wrap(line.trim()):'';
  }).join('\n');
}
export async function media(request,fetcher=fetch) {
  if(!['GET','HEAD'].includes(request.method))return json({error:'仅支持 GET'},405);
  const url=new URL(request.url), type=url.pathname.split('/').pop();
  if(!['img','hls','seg'].includes(type))return json({error:'未知媒体类型'},404);
  const target=url.searchParams.get('u');if(!target || target.length>8192)throw new Error('媒体地址无效');
  const {base}=context(request);
  const headers={'User-Agent':UA,Referer:base+'/'};
  if(type==='seg' && request.headers.get('Range'))headers.Range=request.headers.get('Range');
  const {response,url:finalURL}=await remote(target,{headers},fetcher);
  const outHeaders=new Headers({'X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store'});
  if(type==='img') {
    const limit=12*1024*1024;
    if(Number(response.headers.get('Content-Length'))>limit)throw new Error('封面文件过大');
    const buf=new Uint8Array(await response.arrayBuffer());if(buf.length>limit)throw new Error('封面文件过大');
    const plain=await decryptImage(buf);outHeaders.set('Content-Type',kind(plain));
    return new Response(request.method==='HEAD'?null:plain,{headers:outHeaders});
  }
  const ctype=response.headers.get('Content-Type')||'';
  if(type==='hls' || /mpegurl/i.test(ctype) || /\.m3u8(?:[?#]|$)/i.test(finalURL)) {
    const text=await response.text();if(text.length>2*1024*1024)throw new Error('播放列表过大');
    outHeaders.set('Content-Type','application/vnd.apple.mpegurl');
    return new Response(request.method==='HEAD'?null:rewritePlaylist(finalURL,text),{headers:outHeaders});
  }
  // Stream media rather than buffering whole videos in the Worker.
  outHeaders.set('Content-Type',/^(video|audio)\//.test(ctype)?ctype:'application/octet-stream');
  for(const name of ['Content-Length','Content-Range','Accept-Ranges'])if(response.headers.has(name))outHeaders.set(name,response.headers.get(name));
  return new Response(request.method==='HEAD'?null:response.body,{status:response.status,headers:outHeaders});
}
const CSP="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'self' https://chatgpt.com";
export function createHandler(assets={}) {
 return {async fetch(request,env,ctx) {
  try {
    const path=new URL(request.url).pathname;
    if(path==='/api/health')return json({ok:true,version:'1.2.1',web:true});
    if(path==='/api/rpc')return await rpc(request);
    if(path.startsWith('/api/media/'))return await media(request);
    if(path.startsWith('/api/'))return json({error:'不存在的接口'},404);
    if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405});
    const asset=assets[path]||assets['/index.html'];
    if(!asset)return new Response('Not found',{status:404});
    const body=Uint8Array.from(atob(asset.body),c=>c.charCodeAt(0));
    return new Response(request.method==='HEAD'?null:body,{headers:{'Content-Type':asset.type,'Content-Security-Policy':CSP,'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cache-Control':path.startsWith('/assets/')?'public, max-age=31536000, immutable':'no-cache'}});
  } catch(error) {
    const msg=error instanceof Error?error.message:'请求失败';
    // Do not echo upstream response bodies, URLs or credential values.
    return json({error:/^(请|请输入|请选择|拒绝|上游请求失败|线路|封面|播放|响应不是|接口返回失败|登录响应无效|不允许|媒体地址|仅支持)/.test(msg)?msg.slice(0,120):'请求暂时失败，请稍后重试或切换线路'},502);
  }
 }};
}
export default createHandler();
