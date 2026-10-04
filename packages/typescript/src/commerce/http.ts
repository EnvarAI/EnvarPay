import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { CommerceServer } from './server.js';

export function listenCommerce(server:CommerceServer,origin:string,host='127.0.0.1',port=4020){
  const http=createServer(async(req,res)=>{
    try{
      const expectedHost=new URL(origin).host;
      if(req.headers.host!==expectedHost){res.writeHead(421,{'Content-Type':'application/json'});res.end('{"error":"invalid_host"}');return;}
      const headers=new Headers();for(const [key,value] of Object.entries(req.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(','):value);
      const request=new Request(new URL(req.url??'/',origin),{method:req.method,headers,...(req.method!=='GET'&&req.method!=='HEAD'?{body:Readable.toWeb(req) as ReadableStream<Uint8Array>,duplex:'half'}:{})} as RequestInit);
      const response=await server.handle(request);res.writeHead(response.status,Object.fromEntries(response.headers));
      if(response.body)Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);else res.end();
    }catch{if(!res.headersSent)res.writeHead(500,{'Content-Type':'application/json'});res.end('{"error":"request_failed"}');}
  });
  http.requestTimeout=30000;http.headersTimeout=15000;
  http.listen(port,host);
  return http;
}
