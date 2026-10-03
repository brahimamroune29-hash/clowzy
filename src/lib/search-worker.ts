import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Store } from './store';
import { LiveSearch } from './live-search';
import { crmEnabled } from './catalog';

export function workerAuthorized(header: string | null, secret = process.env.CRON_SECRET) {
  if (!secret || secret.length < 32 || !header) return false;
  const actual = Buffer.from(header), expected = Buffer.from('Bearer ' + secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ponytail: three concurrent steps per tick; a dedicated worker when measured queue latency exceeds this capacity.
// Browser polls and the worker share LiveSearch's durable claims, provider rate slots and delivery transaction.
export async function searchTick(store:Store,poll=(userId:string,searchId:string)=>new LiveSearch(store).poll(userId,searchId), limit = 3) {
  if(!crmEnabled()) return 0;
  const rows=await store.db.all<{id:string;user_id:string}>(`SELECT s.id,s.user_id FROM searches s JOIN users u ON u.id=s.user_id LEFT JOIN provider_runs r ON r.search_id=s.id
    WHERE s.status='awaiting_provider' AND u.active=1 AND NOT EXISTS(SELECT 1 FROM crm_worker_leases l WHERE l.search_id=s.id AND l.expires_at>?)
    ORDER BY r.updated_at NULLS FIRST,s.created_at LIMIT ?`,Date.now(),Math.max(0,Math.min(3,Math.trunc(limit))));
  const attempts=await Promise.all(rows.map(async row=>{
    const token=randomUUID();
    try{
      const claimed=await store.db.run(`INSERT INTO crm_worker_leases(search_id,token,expires_at) VALUES(?,?,?) ON CONFLICT(search_id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at WHERE crm_worker_leases.expires_at<?`,row.id,token,Date.now()+180000,Date.now());
      if(!claimed) return 0;
      await poll(row.user_id,row.id);
      await store.db.run('DELETE FROM crm_worker_leases WHERE search_id=? AND token=?',row.id,token);
      return 1;
    }catch(e){
      // Keep the short lease on failures: one broken job cannot monopolize every tick.
      console.warn('Search worker poll failed',row.id,e instanceof Error?e.message:'unknown');return 0;
    }
  }));
  return attempts.reduce<number>((sum,n)=>sum+n,0);
}
