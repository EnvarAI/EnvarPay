import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { CommerceError } from './types.js';

export function publicAddress(value:string):boolean {
  let address=ipaddr.parse(value);
  if(address.kind()==='ipv6'&&(address as ipaddr.IPv6).isIPv4MappedAddress())address=(address as ipaddr.IPv6).toIPv4Address();
  return address.range()==='unicast';
}

/** Resolve every address, reject private destinations, then connect to a pinned address with original TLS SNI. */
export function hostedSellerFetch(allowLoopback=false):typeof fetch {
  return async(input,init)=>{
    const req=new Request(input,init),url=new URL(req.url),hostname=url.hostname.replace(/^\[|\]$/g,'');
    const loopback=allowLoopback&&['127.0.0.1','localhost','::1'].includes(hostname);
    if(url.username||url.password||url.hash||url.search||(!['https:'].includes(url.protocol)&&!(loopback&&url.protocol==='http:')))throw new CommerceError('hosted_endpoint','Use an approved HTTPS seller endpoint');
    const addresses=isIP(hostname)?[{address:hostname,family:isIP(hostname)}]:await lookup(hostname,{all:true,verbatim:true});
    if(!addresses.length||addresses.some(a=>loopback?!['127.0.0.1','::1'].includes(a.address):!publicAddress(a.address)))throw new CommerceError('hosted_private_endpoint','Seller addresses must be public');
    const body=req.method==='GET'?undefined:Buffer.from(await req.arrayBuffer());
    if(body&&body.length>1024*1024)throw new CommerceError('request_too_large','Seller request exceeds 1 MiB');
    const headers=Object.fromEntries(req.headers);headers.host=url.host;
    if(body)headers['content-length']=String(body.length);
    return new Promise<Response>((resolve,reject)=>{
      const send=url.protocol==='https:'?httpsRequest:httpRequest;
      const call=send({hostname:addresses[0]!.address,family:addresses[0]!.family,port:url.port||undefined,servername:hostname,path:url.pathname,method:req.method,headers,signal:AbortSignal.any([req.signal,AbortSignal.timeout(30000)])},response=>{
        const chunks:Buffer[]=[];let length=0;
        response.on('data',(chunk:Buffer)=>{length+=chunk.length;if(length>4*1024*1024){call.destroy(new CommerceError('response_too_large','Seller response exceeds 4 MiB'));return;}chunks.push(chunk);});
        response.once('error',reject);
        response.once('end',()=>{
          const resultHeaders=new Headers();for(const [key,value] of Object.entries(response.headers))if(value!==undefined)resultHeaders.set(key,Array.isArray(value)?value.join(','):value);
          const status=response.statusCode??502;
          resolve(new Response([204,205,304].includes(status)?null:Buffer.concat(chunks),{status,headers:resultHeaders}));
        });
      });
      call.once('error',reject);call.end(body);
    });
  };
}
