import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, type Store } from './store';
import { crmEnabled, reuseEnabled } from './catalog';
import { searchSchema } from './schemas';
export const stages = ['new','contacted','replied','interested','not_fit'] as const;
const name = z.string().trim().min(1).max(80), id = z.string().uuid();
const savedFilters = searchSchema.omit({confirmed:true,requestId:true});
export type CrmState = {
  lists:{id:string;name:string}[]; audiences:{id:string;name:string;filters:z.infer<typeof savedFilters>}[];
  meta:{contact_id:string;stage:string;tags:string[];notes:string;lists:string[]}[];
  exclusions:{value:string}[]; notifications:{id:string;search_id:string;message:string;read_at:string|null}[];
  deletions:{id:string;email:string;status:string;created_at:string}[];
  wallet:{total:number;reserved:number;available:number};
};
export function requireCrm() { if (!crmEnabled()) throw new AppError('إدارة العملاء غير مفعلة بعد.',503); }
export async function crmState(store:Store,userId:string):Promise<CrmState> {
  requireCrm(); const user=await store.user(userId), reserved=await store.reserved(userId);
  const [lists,audiences,meta,exclusions,notifications,deletions]=await Promise.all([
    store.db.all<CrmState['lists'][number]>('SELECT id,name FROM crm_lists WHERE user_id=? ORDER BY name',userId),
    store.db.all<CrmState['audiences'][number]>('SELECT id,name,filters FROM saved_audiences WHERE user_id=? ORDER BY name',userId),
    store.db.all<CrmState['meta'][number]>(`SELECT m.contact_id,m.stage,m.tags,m.notes,COALESCE((SELECT jsonb_agg(l.list_id) FROM crm_memberships l WHERE l.user_id=m.user_id AND l.contact_id=m.contact_id),'[]'::jsonb) lists FROM crm_meta m WHERE m.user_id=?`,userId),
    store.db.all<{value:string}>('SELECT value FROM crm_exclusions WHERE user_id=? ORDER BY value',userId),
    store.db.all<CrmState['notifications'][number]>('SELECT id,search_id,message,read_at FROM crm_notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50',userId),
    store.db.all<CrmState['deletions'][number]>('SELECT id,email,status,created_at FROM crm_deletions WHERE user_id=? ORDER BY created_at DESC LIMIT 100',userId)
  ]);
  return {lists,audiences,meta,exclusions,notifications,deletions,wallet:{total:user.balance,reserved,available:Math.max(0,user.balance-reserved)}};
}
export async function crmAction(store:Store,userId:string,action:string,raw:unknown) {
  requireCrm(); await store.user(userId);
  return store.transaction(async()=>{
    await store.user(userId,true); // Serialize bounded lists/audiences and edits for this member.
    if(action==='audience') {
      const b=z.object({name,filters:savedFilters}).parse(raw);
      if((await store.db.get<{n:number}>('SELECT count(*)::int n FROM saved_audiences WHERE user_id=?',userId))!.n>=100) throw new AppError('الحد الأقصى 100 جمهور محفوظ.');
      await store.db.run('INSERT INTO saved_audiences(id,user_id,name,filters,created_at) VALUES(?,?,?,?::jsonb,?)',randomUUID(),userId,b.name,JSON.stringify(b.filters),new Date().toISOString());
    } else if(action==='list') {
      const b=z.object({name}).parse(raw);
      if((await store.db.get<{n:number}>('SELECT count(*)::int n FROM crm_lists WHERE user_id=?',userId))!.n>=100) throw new AppError('الحد الأقصى 100 قائمة.');
      await store.db.run('INSERT INTO crm_lists(id,user_id,name) VALUES(?,?,?)',randomUUID(),userId,b.name);
    } else if(action==='remove') {
      const b=z.object({id,kind:z.enum(['list','audience'])}).parse(raw);
      await store.db.run(`DELETE FROM ${b.kind==='list'?'crm_lists':'saved_audiences'} WHERE id=? AND user_id=?`,b.id,userId);
    } else if(action==='contact') {
      const b=z.object({contactId:id,stage:z.enum(stages),tags:z.array(z.string().trim().min(1).max(40)).max(20),notes:z.string().trim().max(4000),lists:z.array(id).max(100)}).parse(raw);
      if(!await store.db.get('SELECT 1 FROM contacts WHERE id=? AND user_id=?',b.contactId,userId)) throw new AppError('العميل غير موجود في حسابك.',403);
      for(const list of new Set(b.lists)) if(!await store.db.get('SELECT 1 FROM crm_lists WHERE id=? AND user_id=?',list,userId)) throw new AppError('القائمة غير موجودة في حسابك.',403);
      await store.db.run(`INSERT INTO crm_meta(contact_id,user_id,stage,tags,notes) VALUES(?,?,?,?::jsonb,?) ON CONFLICT(contact_id) DO UPDATE SET stage=excluded.stage,tags=excluded.tags,notes=excluded.notes`,b.contactId,userId,b.stage,JSON.stringify([...new Set(b.tags)]),b.notes);
      await store.db.run('DELETE FROM crm_memberships WHERE contact_id=? AND user_id=?',b.contactId,userId);
      for(const list of new Set(b.lists)) await store.db.run('INSERT INTO crm_memberships(user_id,list_id,contact_id) VALUES(?,?,?)',userId,list,b.contactId);
    } else if(action==='exclude') {
      const b=z.object({value:z.string().trim().toLowerCase().max(254).regex(/^(?:[^\s@]+@)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/),remove:z.boolean().default(false)}).parse(raw);
      if(b.remove) await store.db.run('DELETE FROM crm_exclusions WHERE user_id=? AND value=?',userId,b.value);
      else await store.db.run('INSERT INTO crm_exclusions(user_id,value,created_at) VALUES(?,?,?) ON CONFLICT DO NOTHING',userId,b.value,new Date().toISOString());
    } else if(action==='read') {
      const b=z.object({id}).parse(raw); await store.db.run('UPDATE crm_notifications SET read_at=? WHERE id=? AND user_id=?',new Date().toISOString(),b.id,userId);
    } else if(action==='delete-request') {
      const b=z.object({contactId:id}).parse(raw), c=await store.db.get<{email:string}>('SELECT email FROM contacts WHERE id=? AND user_id=?',b.contactId,userId);
      if(!c) throw new AppError('العميل غير موجود في حسابك.',403);
      await store.db.run("INSERT INTO crm_deletions(id,user_id,email,status,created_at) VALUES(?,?,?,'pending',?) ON CONFLICT(user_id,email) WHERE status='pending' DO NOTHING",randomUUID(),userId,c.email,new Date().toISOString());
    } else throw new AppError('العملية غير موجودة.',404);
    return {ok:true};
  });
}
export async function crmOperations(store:Store,userId:string) {
  requireCrm(); await store.admin(userId);
  const counts=await store.db.get<{fetched:number;submitted:number;catalog:number;reused:number;delivered:number}>(`SELECT (SELECT COALESCE(sum(fetched),0)::int FROM provider_runs) fetched,(SELECT COALESCE(sum(submitted+people_checked),0)::int FROM provider_runs) submitted,(SELECT count(*)::int FROM lead_catalog) catalog,(SELECT count(*)::int FROM crm_deliveries WHERE origin='catalog') reused,(SELECT COALESCE(-sum(amount),0)::int FROM ledger WHERE kind='debit') delivered`);
  const rate=(key:string)=>{const value=Number(process.env[key]);return process.env[key]&&Number.isFinite(value)&&value>=0?value:null;};
  const fetchRate=rate('CRM_FETCH_COST_USD'),submitRate=rate('CRM_SUBMIT_COST_USD'),creditRate=rate('CRM_CREDIT_VALUE_USD');
  const estimatedCost=fetchRate!==null&&submitRate!==null?counts!.fetched*fetchRate+counts!.submitted*submitRate:null;
  // Credits include grants; this is a rate-based scenario, never booked revenue or actual profit.
  const modeledValue=creditRate!==null?counts!.delivered*creditRate:null;
  return {counts,reuseEnabled:reuseEnabled(),estimatedCost,modeledValue,modeledMargin:estimatedCost!==null&&modeledValue!==null?modeledValue-estimatedCost:null,
    deletions:await store.db.all<{id:string;email:string;status:string;created_at:string}>("SELECT id,email,status,created_at FROM crm_deletions WHERE status='pending' ORDER BY created_at LIMIT 100")};
}
export async function approveDeletion(store:Store,userId:string,raw:unknown) {
  requireCrm(); await store.admin(userId); const b=z.object({id}).parse(raw);
  await store.transaction(async()=>{
    const row=await store.db.get<{email:string}>("SELECT email FROM crm_deletions WHERE id=? AND status='pending' FOR UPDATE",b.id);
    if(!row) throw new AppError('طلب الحذف غير موجود أو عولج سابقًا.',404);
    await store.db.get('SELECT clowzy.suppress_contact(?,?)',userId,row.email);
    await store.db.run("UPDATE crm_deletions SET status='approved',email='' WHERE email=?",row.email);
    await store.db.run('INSERT INTO audit(id,actor_id,action,detail,created_at) VALUES(?,?,?,?,?)',randomUUID(),userId,'حذف بيانات عميل','طلب '+b.id,new Date().toISOString());
  }); return {ok:true};
}
