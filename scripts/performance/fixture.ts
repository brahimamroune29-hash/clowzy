import { Store } from '../../src/lib/store';

// Synthetic data only, built set-based in SQL. Never run against a database with real accounts.
// 1000 members: one heavy member (10000 contacts, 200 searches, 150 exports), members 1-90 with 91 contacts,
// the rest with 90; every 5th member (except the heavy one) is disabled. 100000 contacts in total.
export async function seedPerformanceFixture(store: Store) {
  if (await store.db.get('SELECT 1 FROM users LIMIT 1')) throw new Error('Fixture requires an empty database');
  const created = '2026-09-24T12:00:00.000Z';
  const owner = await store.addUser('مالك الاختبار', 'owner@wasl.example', 'benchmark-only-password', 'admin');
  const heavy = await store.addUser('مشترك الاختبار الكبير', 'member@wasl.example', 'benchmark-only-password', 'member', 20000);
  await store.transaction(async () => {
    const run = (sql: string, ...params: unknown[]) => store.db.run(sql, ...params);
    await run('UPDATE users SET created_at=?', created);
    await run('CREATE TEMP TABLE fixture_members(m integer, uid text, n integer) ON COMMIT DROP'); // DDL takes no bind parameters
    await run(`INSERT INTO fixture_members SELECT 0, ?::text, 10000
      UNION ALL SELECT m, 'member-' || m, CASE WHEN m <= 90 THEN 91 ELSE 90 END FROM generate_series(1, 999) m`, heavy.id);
    await run(`INSERT INTO users(id,name,email,password_hash,role,active,balance,created_at)
      SELECT uid, 'مشترك اختبار ' || m, 'bench-' || m || '@example.com', (SELECT password_hash FROM users WHERE id=?), 'member',
        CASE WHEN m % 5 = 0 THEN 0 ELSE 1 END, 20000 - n, ? FROM fixture_members WHERE m > 0`, heavy.id, created);
    await run('UPDATE users SET balance=10000 WHERE id=?', heavy.id);
    await run(`INSERT INTO ledger(id,user_id,amount,kind,reason,reference,balance_after,created_at)
      SELECT 'grant-' || m, uid, 20000, 'grant', 'رصيد اختبار', 'initial:' || uid, 20000, ? FROM fixture_members WHERE m > 0`, created);
    await run(`INSERT INTO searches(id,user_id,request_id,filters,title,requested,delivered,status,created_at)
      SELECT 's-' || m || '-' || k, uid, 'r-' || m || '-' || k,
        '{"sector":"التقنية والبرمجيات","country":"السعودية","city":"","title":"","size":"all","count":50,"confirmed":true,"requestId":"fixture"}',
        'بحث اختبار ' || m || ' / ' || k * 50, least(50, n - k * 50), least(50, n - k * 50), 'completed',
        to_char((?::timestamptz - make_interval(days => (k * 50) % 30)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      FROM fixture_members, generate_series(0, (n - 1) / 50) k`, created);
    await run(`INSERT INTO contacts(id,user_id,search_id,name,email,company,title,sector,country,city,website,size,source,email_status,created_at)
      SELECT 'c-' || m || '-' || c, uid, 's-' || m || '-' || c / 50, 'جهة اختبار ' || m || '-' || c, 'bench-' || m || '-' || c || '@example.com',
        'شركة اختبار', 'المدير التنفيذي', 'التقنية والبرمجيات', 'السعودية', 'الرياض', 'https://example.com', '11-50', 'كتالوج تجريبي محلي', 'demo',
        to_char((?::timestamptz - make_interval(days => c % 30)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      FROM fixture_members, generate_series(0, n - 1) c`, created);
    await run(`INSERT INTO ledger(id,user_id,amount,kind,reason,reference,balance_after,created_at)
      SELECT 'd-' || id, user_id, -1, 'debit', 'تسليم اختبار', 'delivery:' || id, 0, created_at FROM contacts`);
    await run(`INSERT INTO exports(id,user_id,row_count,created_at)
      SELECT 'e-' || m || '-' || e, uid, 10, ? FROM fixture_members, generate_series(1, CASE WHEN m = 0 THEN 150 ELSE 1 END) e`, created);
    await run(`INSERT INTO invitations(id,token_hash,name,email,credits,expires_at,used_at,created_at)
      SELECT 'i-' || m, 'fixture-token-' || m, 'دعوة اختبار ' || m, 'invite-' || m || '@example.com', 100, '2026-09-26T12:00:00.000Z', NULL, ?
      FROM fixture_members`, created);
    await run(`INSERT INTO audit(id,actor_id,action,detail,created_at)
      SELECT 'a-' || m || '-' || a, ?, 'إجراء اختبار', 'بيانات وهمية ' || m, ? FROM fixture_members, generate_series(1, 2) a`, owner.id, created);
  });
  return { ownerId: owner.id, heavyId: heavy.id, otherMemberId: 'member-1', members: 1000, contacts: 100000, searches: 2198, exports: 1149,
    heavyContacts: 10000, heavySearches: 200, heavyExports: 150, activeMembers: 801, created };
}
