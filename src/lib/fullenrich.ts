import { z } from 'zod';
import type { Candidate, SearchInput } from './contracts';

const text = z.string().nullish();
const location = z.object({ country: text, country_code: text, city: text }).nullish();
const company = z.object({ name: text, domain: text, website: text, headcount: z.number().nullish(), headcount_range: text,
  industry: z.object({ main_industry: text }).nullish() }).nullish();
export const personSchema = z.object({ id: z.string(), full_name: text, first_name: text, last_name: text, location,
  social_profiles: z.object({ professional_network: z.object({ url: text }).nullish() }).nullish(),
  employment: z.object({ current: z.object({ title: text, company }).nullish() }).nullish() });
export type Person = z.infer<typeof personSchema>;
const emailSchema = z.object({ email: z.string(), status: z.string() });
const resultSchema = z.object({ id: z.string(), status: z.enum(['CREATED','IN_PROGRESS','CANCELED','CREDITS_INSUFFICIENT','FINISHED','RATE_LIMIT','UNKNOWN']),
  data: z.array(z.object({ custom: z.object({ person_id: z.string() }).nullish(),
    contact_info: z.object({ most_probable_work_email: emailSchema.nullish(), work_emails: z.array(emailSchema).nullish() }).nullish()
  })).default([]) });
export class FullEnrichError extends Error {
  constructor(message: string, public uncertain = false) { super(message); }
}
export function providerInfo() {
  return { name: 'FullEnrich' as const, configured: !!process.env.FULLENRICH_API_KEY?.trim(), maxCount: 10 };
}
const countryNames = { السعودية:'Saudi Arabia', الإمارات:'United Arab Emirates', الجزائر:'Algeria', مصر:'Egypt' };
const industryNames: Record<SearchInput['sector'], string[]> = {
  'التقنية والبرمجيات':['Software Development','IT Services and IT Consulting'], 'العقارات':['Real Estate'],
  'الصحة والعيادات':['Hospitals and Health Care','Medical Practices'], 'التجارة الإلكترونية':['Online and Mail Order Retail','Internet Marketplace Platforms'],
  'التعليم والتدريب':['Education','Professional Training and Coaching'], 'السياحة والضيافة':['Hospitality','Travel Arrangements'],
  'الخدمات المهنية':['Professional Services'], 'الصناعة':['Manufacturing'],
};
const cityNames: Record<string,string> = { 'الرياض':'Riyadh','جدة':'Jeddah','دبي':'Dubai','أبوظبي':'Abu Dhabi','أبو ظبي':'Abu Dhabi','القاهرة':'Cairo','الإسكندرية':'Alexandria','الجزائر':'Algiers','الجزائر العاصمة':'Algiers','وهران':'Oran' };
const filter = (value:string) => ({ value, exact_match:false, exclude:false });
export function searchBody(input:SearchInput) {
  // A single location expression keeps city + country together (items in one filter are OR).
  const city=cityNames[input.city] || input.city;
  if (/[\u0600-\u06ff]/.test(city) || /[\u0600-\u06ff]/.test(input.title)) throw new FullEnrichError('اكتب المدينة والمسمى الوظيفي بالإنجليزية لهذه التجربة، أو اتركهما فارغين.');
  return { limit:input.count, offset:0,
    current_company_industries:industryNames[input.sector].map(filter),
    person_locations:[filter(city?`${city}, ${countryNames[input.country]}`:countryNames[input.country])],
    ...(input.title?{current_position_titles:[filter(input.title)]}:{}),
    ...(input.size!=='all'?{current_company_headcounts:[{min:Number(input.size.split('-')[0]),max:Number(input.size.split('-')[1]),exclude:false}]}:{}),
  };
}
export function safeWebsite(value:string|null|undefined) {
  try { const u=new URL(value || ''); return ['https:','http:'].includes(u.protocol)?u.href:''; } catch {return '';}
}
export class FullEnrichClient {
  constructor(private key=process.env.FULLENRICH_API_KEY?.trim() || '', private transport:typeof fetch=fetch) {}
  private async request(path:string, body?:unknown):Promise<unknown> {
    if (!this.key) throw new FullEnrichError('أضف FULLENRICH_API_KEY إلى ملف .env.local ثم أعد تشغيل المنصة.');
    let response:Response;
    try { response=await this.transport('https://app.fullenrich.com/api/v2/'+path,{
      method:body===undefined?'GET':'POST', headers:{Authorization:'Bearer '+this.key,'Content-Type':'application/json'},
      ...(body===undefined?{}:{body:JSON.stringify(body)}), signal:AbortSignal.timeout(20000), redirect:'error', cache:'no-store',
    }); } catch { throw new FullEnrichError('انقطع الاتصال بـ FullEnrich. راجع سجل الطلب في حساب المزود قبل إنشاء بحث جديد.',body!==undefined); }
    if (!response.ok) {
      const message=response.status===401?'مفتاح FullEnrich غير صالح.':response.status===403?'حساب FullEnrich لا يملك صلاحية هذه الخدمة. تحقق من إتاحة Search API.':response.status===402?'رصيد FullEnrich غير كافٍ.':response.status===429?'بلغت حد الطلبات لدى FullEnrich. انتظر قبل المتابعة.':`تعذّر طلب FullEnrich (HTTP ${response.status}).`;
      throw new FullEnrichError(message,body!==undefined && (response.status>=500 || response.status===408));
    }
    try {return await response.json();} catch {throw new FullEnrichError('استجابة FullEnrich غير قابلة للقراءة.',body!==undefined);}
  }
  async verify(){z.object({workspace_id:z.string().min(1)}).parse(await this.request('account/keys/verify'));return {ok:true};}
  async search(input:SearchInput) {
    const raw=await this.request('people/search',searchBody(input));
    const parsed=z.object({people:z.array(personSchema).max(100)}).safeParse(raw);
    if(!parsed.success) throw new FullEnrichError('تغيّرت صيغة نتائج FullEnrich. يلزم مراجعة الربط.',true);
    const seen=new Set<string>();
    return parsed.data.people.slice(0,input.count).filter(p=>{
      if(seen.has(p.id)) return false;seen.add(p.id);
      const expectedCode={السعودية:'SA',الإمارات:'AE',الجزائر:'DZ',مصر:'EG'}[input.country];
      const normalized=(v:string)=>v.trim().toLowerCase();
      if(p.location?.country_code? p.location.country_code.toUpperCase()!==expectedCode : normalized(p.location?.country || '')!==normalized(countryNames[input.country]))return false;
      if(input.city && normalized(p.location?.city || '')!==normalized(cityNames[input.city] || input.city))return false;
      return !!(p.social_profiles?.professional_network?.url || (p.first_name && p.last_name && p.employment?.current?.company?.domain));
    });
  }
  async enrich(people:Person[],name:string) {
    const raw=await this.request('contact/enrich/bulk',{name,data:people.map(p=>({
      first_name:p.first_name || undefined,last_name:p.last_name || undefined,
      domain:p.employment?.current?.company?.domain || undefined,company_name:p.employment?.current?.company?.name || undefined,
      linkedin_url:p.social_profiles?.professional_network?.url || undefined,
      enrich_fields:['contact.work_emails'],custom:{person_id:p.id},
    }))});
    const parsed=z.object({enrichment_id:z.string().uuid()}).safeParse(raw);
    if(!parsed.success) throw new FullEnrichError('لم يصل رقم طلب FullEnrich. راجع حساب المزود قبل إنشاء طلب آخر.',true);
    return parsed.data.enrichment_id;
  }
  async result(id:string,people:Person[]):Promise<{status:string;candidates:Candidate[]}> {
    const parsed=resultSchema.safeParse(await this.request('contact/enrich/bulk/'+encodeURIComponent(id)));
    if(!parsed.success || parsed.data.id!==id) throw new FullEnrichError('تعذّر مطابقة نتيجة FullEnrich مع الطلب المحفوظ.');
    const candidates:Candidate[]=[];
    if(parsed.data.status==='FINISHED') for(const item of parsed.data.data){
      const p=people.find(p=>p.id===item.custom?.person_id);if(!p)continue;
      const info=item.contact_info;
      const email=[info?.most_probable_work_email,...(info?.work_emails||[])].find(e=>e?.status==='DELIVERABLE' && z.email().safeParse(e.email).success);
      if(!email)continue;
      const c=p.employment?.current?.company;
      candidates.push({name:p.full_name||[p.first_name,p.last_name].filter(Boolean).join(' '),email:email.email,
        company:c?.name||'',title:p.employment?.current?.title||'',sector:c?.industry?.main_industry||'',
        country:p.location?.country||'',city:p.location?.city||'',website:safeWebsite(c?.website),
        size:c?.headcount_range||(c?.headcount==null?'':String(c.headcount)),source:'FullEnrich',email_status:'DELIVERABLE'});
    }
    return {status:parsed.data.status,candidates};
  }
}
