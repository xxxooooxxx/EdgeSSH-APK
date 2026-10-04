import { cookiePrefix } from './mount.ts';

/** 只为可信路径模式补常用浏览器 API；不伪装成能运行任意网站的透明反向代理。 */
export function pathRuntime(base: string, port: number): string {
  return `(() => {
const base=${JSON.stringify(base)}, prefix=${JSON.stringify(cookiePrefix(base))}, port=${port};
const map=value=>{
  const url=new URL(String(value),document.baseURI);
  const local=url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&Number(url.port||80)===port;
  if(!local&&url.origin!==location.origin)return String(value);
  if(url.pathname===base||url.pathname.startsWith(base+'/'))return url.href;
  return location.origin+base+url.pathname+url.search+url.hash;
};
const originalFetch=window.fetch;
window.fetch=function(input,init){return originalFetch.call(this,input instanceof Request?new Request(map(input.url),input):map(input),init);};
const open=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(method,url,...rest){return open.call(this,method,map(url),...rest);};
if(window.EventSource){const Native=window.EventSource;window.EventSource=class extends Native{constructor(url,options){super(map(url),options);}};}
for(const name of ['pushState','replaceState']){const original=history[name];history[name]=function(data,unused,url){return original.call(this,data,unused,url==null?url:map(url));};}
const cookie=Object.getOwnPropertyDescriptor(Document.prototype,'cookie');
if(cookie&&cookie.get&&cookie.set)Object.defineProperty(document,'cookie',{
  get(){return cookie.get.call(document).split(';').map(v=>v.trim()).filter(v=>v.startsWith(prefix)).map(v=>v.slice(prefix.length)).join('; ');},
  set(value){
    const parts=String(value).split(';'), first=parts.shift(), split=first.indexOf('=');
    if(split<1)return;
    let path=location.pathname.slice(base.length).replace(/[^/]*$/,'')||'/';
    const attrs=parts.filter(part=>{const v=part.trim();if(/^path=/i.test(v)){path=v.slice(5);return false;}return !/^(domain=|secure$)/i.test(v);});
    if(!path.startsWith('/'))path='/';
    cookie.set.call(document,prefix+first.trim()+'; '+attrs.join('; ')+'; Path='+base+path+'; Secure');
  }
});
})();`;
}
