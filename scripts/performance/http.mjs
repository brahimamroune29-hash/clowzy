import {writeFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
const origin=process.argv[2],output=process.argv[3];
if(!['http://127.0.0.1:3131','http://127.0.0.1:3132'].includes(origin)) throw Error('Only isolated benchmark servers are permitted');
const days=Array.from({length:8},(_,i)=>new Date(Date.UTC(2026,8,18+i)).toISOString());
const results={measuredAt:new Date().toISOString(),origin,node:process.version,warmups:5,samples:20,note:'Sequential warm HTTP requests; application body after decompression; no concurrent load or page-render timing.'};
for(const role of ['member','admin']) {
  const email=role==='admin'?'owner@wasl.example':'member@wasl.example';
  const login=await fetch(origin+'/api/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email,password:'benchmark-only-password'})});
  if(!login.ok) throw Error('Synthetic login failed: '+login.status);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const times=[];let text='',data;
  for(let i=0;i<25;i++) {
    const start=performance.now();
    const response=await fetch(origin+'/api/bootstrap?view=overview&days='+encodeURIComponent(JSON.stringify(days)),{headers:{Cookie:cookie}});
    text=await response.text();data=JSON.parse(text);
    if(!response.ok||data.user.role!==role) throw Error('Unexpected bootstrap response');
    if(i>=5)times.push(performance.now()-start);
  }
  const sorted=[...times].sort((a,b)=>a-b);
  results[role]={medianMs:sorted[10],p95Ms:sorted[18],minMs:sorted[0],maxMs:sorted[19],jsonBytes:Buffer.byteLength(text),gzipBytes:gzipSync(text).length,timingsMs:times,shape:{contacts:data.contacts.length,searches:data.searches.length,ledger:data.ledger.length,exports:data.exports.length,members:data.admin?.users.length,invitations:data.admin?.invitations.length}};
}
writeFileSync(output,JSON.stringify(results,null,2));
console.log(JSON.stringify(results,(key,value)=>key==='timingsMs'?undefined:value));
