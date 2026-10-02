import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Store } from './store';
import { LiveSearch } from './live-search';
import { crmEnabled } from './catalog';

export function workerAuthorized(header: string | null, secret = process.env.CRON_SECRET) {
  if (!secret || secret.length < 32 || !header) return false;
  const actual = Buffer.from(header), expected = Buffer.from('Bearer ' + secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Each tick is bounded. Browser polls and the worker share LiveSearch's durable claims and delivery transaction.
export async function searchTick(store:Store,poll=(userId:string,searchId:string)=>new LiveSearch(store).poll(userId,searchId), limit = 10) {
  if(!crmEnabled()) return 0;
  const rows=await store.db.all<{id:string;user_id:string}>("SELECT s.id,s.user_id FROM searches s JOIN users u ON u.id=s.user_id LEFT JOIN provider_runs r ON r.search_id=s.id WHERE s.status='awaiting_provider' AND u.active=1 ORDER BY r.updated_at NULLS FIRST,s.created_at LIMIT 10");
  let handled=0;
  for(const row of rows){
    if (handled >= limit) break;
    const token=randomUUID();
    const claimed=await store.db.run(`INSERT INTO crm_worker_leases(search_id,token,expires_at) VALUES(?,?,?) ON CONFLICT(search_id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at WHERE crm_worker_leases.expires_at<?`,row.id,token,Date.now()+180000,Date.now());
    if(!claimed) continue;
    try{await poll(row.user_id,row.id);handled++;}catch(e){console.warn('Search worker poll failed',row.id,e instanceof Error?e.message:'unknown');}
    finally{await store.db.run('DELETE FROM crm_worker_leases WHERE search_id=? AND token=?',row.id,token);}
  }
  return handled;
}
