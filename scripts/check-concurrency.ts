// Checks what the in-process test database cannot: truly overlapping transactions on a real Postgres (e.g. Supabase).
// Usage: DATABASE_URL=... npx tsx scripts/check-concurrency.ts
// It creates throwaway rows (emails ending in @check.invalid) and removes them. Setup rows are written directly, never
// through paths that add append-only history (ledger, audit), so the app role alone can clean up.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Db, pgDriver } from '../src/lib/db';
import { Store } from '../src/lib/store';
import { audienceOf } from '../src/lib/audience';

const url = process.env.DATABASE_URL;
if (!url) { console.error('Set DATABASE_URL (the app role connection).'); process.exit(1); }
const store = new Store(new Db(pgDriver(url))), db = store.db, tag = '@check.invalid';
const hash = (s: string) => createHash('sha256').update(s).digest('hex'), now = () => new Date().toISOString(), inAnHour = () => new Date(Date.now() + 3600000).toISOString();
const input = (count: number) => audienceOf(JSON.stringify({ sector: 'العقارات', countries: ['SA'], city: '', title: '', size: 'all', count, confirmed: true, requestId: randomUUID() }));
async function member(balance: number) {
  const id = randomUUID();
  await db.run('INSERT INTO users(id,name,email,password_hash,role,balance,created_at) VALUES(?,?,?,?,?,?,?)', id, 'check', `check-${id}${tag}`, 'x:y', 'member', balance, now());
  return id;
}
let failures = 0;
const openInvitations:string[]=[];
const check = (name: string, ok: boolean, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };
const fulfilled = (r: PromiseSettledResult<unknown>[]) => r.filter(x => x.status === 'fulfilled').length;
const reasons = (r: PromiseSettledResult<unknown>[]) => r.flatMap(x => x.status === 'rejected' ? [String((x.reason as Error)?.message)] : []);

async function main() {
  try {
    for (let round = 1; round <= 5; round++) {
      const u = await member(10), r = await Promise.allSettled([store.enqueueSearch(u, input(6)), store.enqueueSearch(u, input(6))]);
      check(`two 6-credit reservations on 10 credits, one accepted (round ${round})`, fulfilled(r) === 1 && await store.reserved(u) === 6, reasons(r).join(' | '));
    }
    for (let round = 1; round <= 5; round++) {
      const token = randomBytes(24).toString('hex');
      await db.run('INSERT INTO invitations(id,token_hash,name,email,credits,expires_at,created_at) VALUES(?,?,?,?,?,?,?)', randomUUID(), hash(token), 'check', `invite-${randomUUID()}${tag}`, 0, inAnHour(), now());
      const r = await Promise.allSettled([store.acceptInvite(token, 'check-password-123'), store.acceptInvite(token, 'check-password-123')]);
      check(`one invitation opened twice at once, used once (round ${round})`, fulfilled(r) === 1, reasons(r).join(' | '));
    }
    for(let round=1;round<=5;round++){
      const token=randomBytes(24).toString('hex'),id=randomUUID();openInvitations.push(id);
      await db.run('INSERT INTO invitations(id,token_hash,name,email,credits,expires_at,created_at) VALUES(?,?,?,?,?,?,?)',id,hash(token),'check','',0,inAnHour(),now());
      const r=await Promise.allSettled([store.acceptInvite(token,'check-password-123',`first-${id}${tag}`,true),store.acceptInvite(token,'check-password-123',`second-${id}${tag}`,true)]);
      check(`name-only invitation with two different chosen emails, one accepted (round ${round})`,fulfilled(r)===1&&reasons(r).every(m=>m.includes('الدعوة غير صالحة')),reasons(r).join(' | '));
    }
    for(let round=1;round<=5;round++){
      const tokens=[randomBytes(24).toString('hex'),randomBytes(24).toString('hex')],ids=[randomUUID(),randomUUID()],email=`same-${randomUUID()}${tag}`;openInvitations.push(...ids);
      for(const [i,id] of ids.entries())await db.run('INSERT INTO invitations(id,token_hash,name,email,credits,expires_at,created_at) VALUES(?,?,?,?,?,?,?)',id,hash(tokens[i]),'check','',0,inAnHour(),now());
      const r=await Promise.allSettled([store.acceptInvite(tokens[0],'check-password-123',email,true),store.acceptInvite(tokens[1],'check-password-123',email.toUpperCase(),true)]);
      const unused=await db.get<{n:number}>('SELECT count(*)::int n FROM invitations WHERE (id=? OR id=?) AND used_at IS NULL AND email=?',ids[0],ids[1],'');
      check(`different links choose the same email, one account and unused link retained (round ${round})`,fulfilled(r)===1&&unused?.n===1&&reasons(r).every(m=>m.includes('الحساب موجود بالفعل')),reasons(r).join(' | '));
    }
    for (let round = 1; round <= 5; round++) {
      const users = [await member(0), await member(0)], tokens = [randomBytes(24).toString('hex'), randomBytes(24).toString('hex')];
      for (const [i, u] of users.entries()) {
        await db.run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)', hash(randomUUID()), u, '2000-01-01T00:00:00.000Z'); // expired rows for the cleanup to meet
        await db.run('INSERT INTO reset_tokens(token_hash,user_id,expires_at) VALUES(?,?,?)', hash(tokens[i]), u, inAnHour());
      }
      const r = await Promise.allSettled([store.resetPassword(tokens[0], 'new-password-123'), store.resetPassword(tokens[1], 'new-password-123'), store.resetPassword(tokens[0], 'new-password-456')]);
      check(`two resets plus a repeated link, no deadlock (round ${round})`, fulfilled(r) === 2 && reasons(r).every(m => m.includes('غير صالح')), reasons(r).join(' | '));
    }
  } finally {
    const ids = (await db.all<{ id: string }>('SELECT id FROM users WHERE email LIKE ?', '%' + tag)).map(u => u.id);
    for (const id of ids) for (const t of ['reservations', 'sessions', 'reset_tokens', 'searches']) await db.run(`DELETE FROM ${t} WHERE user_id=?`, id);
    await db.run('DELETE FROM invitations WHERE email LIKE ?', '%' + tag);
    for(const id of openInvitations)await db.run('DELETE FROM invitations WHERE id=?',id);
    for (const id of ids) await db.run('DELETE FROM users WHERE id=?', id);
    console.log(`cleanup: removed ${ids.length} check accounts`);
    await store.close();
  }
  process.exitCode = failures ? 1 : 0;
}
void main();
