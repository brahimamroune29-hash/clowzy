import {z} from 'zod';
import {bestEmail,emailsIn,freeMail} from './site-email';

export const hunterEnabled=()=>process.env.HUNTER_ENABLED==='true'&&!!process.env.HUNTER_API_KEY?.trim();
export type HunterLookup={email:string;outcome:'found'|'empty'|'rejected'|'unavailable'|'unconfigured';status?:number};
const response=z.object({data:z.object({domain:z.string().nullable(),emails:z.array(z.object({value:z.string(),type:z.string(),verification:z.object({status:z.string().nullable()}).nullish()})).max(100)})});
// Discovery only. The explicit pilot verifies each selected address with Icypeas; discovery is not proof of validity.
export class HunterClient {
  constructor(private key=process.env.HUNTER_API_KEY?.trim()||'',private transport:typeof fetch=fetch){}
  async find(domain:string):Promise<HunterLookup>{
    if(!this.key)return {email:'',outcome:'unconfigured'};
    if(!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,63}$/i.test(domain)||freeMail.test(domain))return {email:'',outcome:'rejected'};
    const url=new URL('https://api.hunter.io/v2/domain-search');
    url.searchParams.set('domain',domain);url.searchParams.set('type','generic');url.searchParams.set('limit','10');
    try{
      // The key is in a header, never a URL, exception message, browser bundle or report.
      const r=await this.transport(url,{headers:{'X-API-KEY':this.key},signal:AbortSignal.timeout(8000),redirect:'error',cache:'no-store'});
      if(!r.ok)return {email:'',outcome:'unavailable',status:r.status};
      const parsed=response.safeParse(await r.json());
      if(!parsed.success)return {email:'',outcome:'unavailable'};
      const data=parsed.data.data;
      if(!data.emails.length)return {email:'',outcome:'empty'};
      if(data.domain?.toLowerCase()!==domain.toLowerCase())return {email:'',outcome:'rejected'};
      const eligible=data.emails.filter(e=>e.type==='generic'&&e.verification?.status!=='invalid'&&z.email().safeParse(e.value).success&&emailsIn(e.value,domain).length>0);
      const email=bestEmail(eligible.map(e=>e.value.toLowerCase()));
      return {email,outcome:email?'found':'rejected'};
    }catch{return {email:'',outcome:'unavailable'};}
  }
}
