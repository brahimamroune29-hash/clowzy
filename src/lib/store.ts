import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { countryLabel } from './places';
import { registrationEmail, resolvedSchema, weekBoundariesSchema } from './schemas';
import { TERMS_VERSION, type AdminUser, type AuditEvent, type Candidate, type Contact, type ExportEvent, type Invitation, type Ledger, type Resolved, type Search, type Snapshot, type User } from './contracts';
import { Db, pgDriver } from './db';
import { weekBoundaries } from './overview';
import { crmEnabled } from './catalog';
import { recordCoverage } from './coverage';
import { companyKeys } from './icypeas';

export class AppError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
const now = () => new Date().toISOString();
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const passwordHash = (password: string) => {
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + scryptSync(password, salt, 64).toString('hex');
};
const checkPassword = (password: string, encoded: string) => {
  const [salt, stored] = encoded.split(':');
  if (!salt || !stored) return false;
  const actual = scryptSync(password, salt, 64), expected = Buffer.from(stored, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};
// The owner's way back in without email: 20 characters from 32 (100 bits, no 0/O/1/I), shown once as XXXX-XXXX-XXXX-XXXX-XXXX
// and kept as a hash. Typed in any case, with or without the dashes.
const codeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const recoveryCode = () => [...randomBytes(20)].map(b => codeAlphabet[b & 31]).join('').match(/.{4}/g)!.join('-');
const codeHash = (code: string) => hash(code.toUpperCase().replace(/[^A-Z0-9]/g, ''));
// Compared when the email is unknown, so a login takes as long whether or not the account exists.
let dummyHash: string | undefined;
// Provider work (people fetched) per member per 24 h: members pay per delivered email, the provider per person fetched.
// ponytail: counted by each search's start time, and a running search may pass it by one page (two can run at once).
// People and companies fetched per member per day (0.02 provider credit each, so at most 50 credits): owner's 1,000 of 2026-09-30,
// The member's daily provider-work cap: people fetched across a day. 2500 (raised 2026-10-01) lets one search for
// 50 try its 25x people and then 25x companies. The owner raises it from the host env (DAILY_PEOPLE) when a thin
// market needs more depth per day — a higher cap spends more provider credit, so it stays the owner's call.
// Unset, zero, negative or non-numeric keeps the 2500 default: a bad value never disables the cap by accident.
export const dailyPeople = () => { const n = Math.floor(Number(process.env.DAILY_PEOPLE)); return n > 0 ? n : 2500; };
// Least past requests in a niche+country before marketRate judges it: a verdict on one or two searches is noise.
const MARKET_MIN_HISTORY = 40;
export const dailyLimit = 'بلغت حد البحث اليومي لحسابك. يمكنك البحث مجددًا بعد 24 ساعة من أول بحث اليوم، أو تواصل مع مالك المنصة.';
const userFields = 'id,name,email,role,active,balance,created_at,terms_accepted_at';
const normalizeEmail = (value: string) => value.trim().toLowerCase();
const count = (row: { n: number } | undefined) => row?.n ?? 0;
const placesTitle = (codes: string[]) => codes.length > 3 ? codes.slice(0, 3).map(countryLabel).join('، ') + ' +' + (codes.length - 3) : codes.map(countryLabel).join('، ');

// Money rule: every change to a member's balance runs in a transaction that first locks that member's row
// (user(id, true) / FOR UPDATE), so concurrent requests from any server instance apply one after another.
export class Store {
  constructor(public db: Db) {}
  close() { return this.db.end(); }
  transaction<T>(fn: () => Promise<T>) { return this.db.transaction(fn); }
  async user(id: string, lock = false): Promise<User> {
    const user = await this.db.get<User>('SELECT ' + userFields + ' FROM users WHERE id=?' + (lock ? ' FOR UPDATE' : ''), id);
    if (!user || !user.active) throw new AppError('الحساب غير متاح أو تم تعطيله.', 401);
    return user;
  }
  async admin(id: string) {
    const user = await this.user(id);
    if (user.role !== 'admin') throw new AppError('هذه العملية متاحة لمالك المنصة فقط.', 403);
    return user;
  }
  addUser(name: string, email: string, password: string, role: 'admin' | 'member' = 'member', credits = 0) {
    return this.transaction(async () => {
      const id = randomUUID();
      await this.db.run('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)', id, name, normalizeEmail(email), passwordHash(password), role, now());
      if (credits) await this.credit(id, credits, 'grant', 'رصيد البداية', 'initial:' + id);
      return this.user(id);
    });
  }
  // Caller holds a transaction (and the member's row lock when the balance may go down).
  private async credit(userId: string, amount: number, kind: string, reason: string, reference: string) {
    if (await this.db.get('SELECT 1 FROM ledger WHERE reference=?', reference)) return;
    const row = await this.db.get<{ balance: number }>('UPDATE users SET balance=balance+? WHERE id=? AND balance+? >= 0 RETURNING balance', amount, userId, amount);
    if (!row) throw new AppError('الرصيد المتاح لا يكفي لهذه العملية.');
    await this.db.run('INSERT INTO ledger(id,user_id,amount,kind,reason,reference,balance_after,created_at) VALUES(?,?,?,?,?,?,?,?)', randomUUID(), userId, amount, kind, reason, reference, row.balance, now());
  }
  private async audit(actor: string, action: string, detail: string) {
    await this.db.run('INSERT INTO audit(id,actor_id,action,detail,created_at) VALUES(?,?,?,?,?)', randomUUID(), actor, action, detail, now());
  }
  async login(email: string, password: string) {
    return this.transaction(async () => {
      const row = await this.db.get<{ id: string; password_hash: string }>('SELECT id,password_hash FROM users WHERE email=? FOR UPDATE', normalizeEmail(email));
      if (!checkPassword(password, row?.password_hash ?? (dummyHash ??= passwordHash(randomBytes(16).toString('hex')))) || !row) throw new AppError('البريد الإلكتروني أو كلمة المرور غير صحيحة.', 401);
      return this.createSession((await this.user(row.id)).id);
    });
  }
  async createSession(id: string) {
    await this.user(id);
    const token = randomBytes(32).toString('hex');
    // Housekeeping that never waits: rows other transactions hold are skipped, so logins and resets cannot deadlock.
    await this.db.run('DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE expires_at < ? LIMIT 500 FOR UPDATE SKIP LOCKED)', now());
    await this.db.run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)', hash(token), id, new Date(Date.now() + 7 * 86400000).toISOString());
    return token;
  }
  // One round trip per API request: the session and its user together.
  async session(token?: string): Promise<User> {
    if (!token) throw new AppError('سجّل الدخول للمتابعة.', 401);
    const user = await this.db.get<User>(`SELECT ${userFields.split(',').map(f => 'u.' + f).join(',')} FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.expires_at>?`, hash(token), now());
    if (!user) throw new AppError('انتهت جلستك. سجّل الدخول مجددًا.', 401);
    if (!user.active) throw new AppError('الحساب غير متاح أو تم تعطيله.', 401);
    return user;
  }
  async logout(token: string) { await this.db.run('DELETE FROM sessions WHERE token_hash=?', hash(token)); }
  async snapshot(id: string): Promise<Snapshot> {
    const user = await this.user(id);
    const [contacts, searches, ledger, exports] = await Promise.all([
      this.db.all<Contact>('SELECT * FROM contacts WHERE user_id=? ORDER BY created_at DESC,id', id),
      this.db.all<Search>('SELECT s.*,r.message,r.people_checked+r.submitted AS checked FROM searches s LEFT JOIN provider_runs r ON r.search_id=s.id WHERE s.user_id=? ORDER BY s.created_at DESC', id),
      this.db.all<Ledger>('SELECT id,amount,kind,reason,created_at,balance_after FROM ledger WHERE user_id=? ORDER BY created_at DESC,seq DESC LIMIT 200', id),
      this.db.all<ExportEvent>('SELECT id,row_count,created_at FROM exports WHERE user_id=? ORDER BY created_at DESC LIMIT 100', id),
    ]);
    const snapshot: Snapshot = { user, contacts, searches, ledger, exports };
    if (user.role === 'admin') {
      const [users, invitations, audit, used] = await Promise.all([
        this.db.all<AdminUser>(`SELECT ${userFields.split(',').map(f => 'u.' + f).join(',')},
          (SELECT count(*) FROM contacts WHERE user_id=u.id) AS leads,
          (SELECT count(*) FROM searches WHERE user_id=u.id) AS searches,
          (SELECT count(*) FROM exports WHERE user_id=u.id) AS exports
          FROM users u WHERE role='member' ORDER BY created_at DESC`),
        this.db.all<Invitation>('SELECT id,name,email,credits,expires_at,used_at,created_at FROM invitations ORDER BY created_at DESC'),
        this.db.all<AuditEvent>("SELECT id,action,detail,created_at FROM audit WHERE action<>'search-coverage' ORDER BY created_at DESC LIMIT 80"),
        this.db.get<{ n: number }>("SELECT COALESCE(-sum(amount),0) AS n FROM ledger WHERE kind='debit'"),
      ]);
      snapshot.admin = {
        users, invitations, audit,
        totals: {
          delivered: users.reduce((a, u) => a + u.leads, 0),
          searches: users.reduce((a, u) => a + u.searches, 0),
          exports: users.reduce((a, u) => a + u.exports, 0),
          used: count(used),
        },
      };
    }
    return snapshot;
  }
  overview(id: string, days = weekBoundaries()): Promise<Snapshot> {
    const boundaries = weekBoundariesSchema.parse(days).map(day => new Date(day).toISOString());
    // Totals and recent rows come from one read snapshot; balances are never cached.
    return this.transaction(async () => {
      await this.db.run('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const user = await this.user(id);
      const counts = (await this.db.get<{ contacts: number; searches: number; exports: number }>(`SELECT
        (SELECT count(*) FROM contacts WHERE user_id=?) AS contacts,
        (SELECT count(*) FROM searches WHERE user_id=?) AS searches,
        (SELECT count(*) FROM exports WHERE user_id=?) AS exports`, id, id, id))!;
      const weekly = [];
      for (let i = 0; i < 7; i++) {
        const start = boundaries[i], end = boundaries[i + 1];
        weekly.push({ start, end, count: count(await this.db.get<{ n: number }>('SELECT count(*) AS n FROM contacts WHERE user_id=? AND created_at>=? AND created_at<?', id, start, end)) });
      }
      const result: Snapshot = {
        user, summary: { ...counts, weekly }, contacts: [], ledger: [], exports: [],
        searches: await this.db.all<Search>('SELECT * FROM searches WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 4', id),
      };
      if (user.role === 'admin') {
        const memberCounts = (await this.db.get<{ members: number; activeMembers: number }>(`SELECT count(*) AS members,
          COALESCE(sum(CASE WHEN active=1 THEN 1 ELSE 0 END),0) AS "activeMembers" FROM users WHERE role='member'`))!;
        const totals = (await this.db.get<{ delivered: number; searches: number; exports: number; used: number }>(`SELECT
          (SELECT count(*) FROM contacts c JOIN users u ON u.id=c.user_id WHERE u.role='member') AS delivered,
          (SELECT count(*) FROM searches s JOIN users u ON u.id=s.user_id WHERE u.role='member') AS searches,
          (SELECT count(*) FROM exports e JOIN users u ON u.id=e.user_id WHERE u.role='member') AS exports,
          (SELECT COALESCE(-sum(amount),0) FROM ledger WHERE kind='debit') AS used`))!;
        result.admin = {
          users: await this.db.all<AdminUser>(`SELECT ${userFields.split(',').map(f => 'u.' + f).join(',')},
            (SELECT count(*) FROM contacts WHERE user_id=u.id) AS leads,
            (SELECT count(*) FROM searches WHERE user_id=u.id) AS searches,
            (SELECT count(*) FROM exports WHERE user_id=u.id) AS exports
            FROM (SELECT * FROM users WHERE role='member' ORDER BY created_at DESC,id DESC LIMIT 5) u
            ORDER BY u.created_at DESC,u.id DESC`),
          invitations: [],
          audit: await this.db.all<AuditEvent>("SELECT id,action,detail,created_at FROM audit WHERE action<>'search-coverage' ORDER BY created_at DESC,id DESC LIMIT 4"),
          recovery: !!await this.db.get('SELECT 1 FROM users WHERE id=? AND recovery_hash IS NOT NULL', id), // the settings page (an overview view)
          totals: { ...totals, ...memberCounts },
        };
      }
      return result;
    });
  }
  // Requests per key (e.g. 'auth:<ip>') in the current minute, counted in the database so every server instance shares it.
  // ponytail: fixed one-minute windows (up to 2x max across a minute boundary); a sliding window if that ever matters.
  // Fixed windows (window_start: epoch ms) of any length: a minute for logins, a day for the assistant. Rows live two days.
  async hit(key: string, max: number, windowMs = 60000, message = 'طلبات كثيرة. انتظر دقيقة وحاول مجددًا.') {
    const now = Date.now();
    await this.db.run('DELETE FROM rate_hits WHERE window_start < ?', now - 2 * 86400000);
    const row = await this.db.get<{ count: number }>(`INSERT INTO rate_hits(key,window_start,count) VALUES(?,?,1)
      ON CONFLICT(key,window_start) DO UPDATE SET count=rate_hits.count+1 RETURNING count`, key, now - now % windowMs);
    if (row!.count > max) throw new AppError(message, 429);
  }
  async aiBudget(userId: string) {
    // One allowance covers assistant messages and uncached custom filters, across all server instances.
    await this.hit('assist:' + userId, 12);
    await this.hit('assist-day:' + userId, 150, 86400000, 'وصلت حد المساعد اليومي. حاول غدًا.');
  }
  async dailyFetched(userId: string) {
    return count(await this.db.get<{ n: number }>('SELECT COALESCE(sum(r.fetched),0)::int n FROM provider_runs r JOIN searches s ON s.id=r.search_id WHERE s.user_id=? AND s.created_at>?',
      userId, new Date(Date.now() - 86400000).toISOString()));
  }
  // How much of what was asked for actually arrived in this niche+country, across every member's finished
  // searches ('completed'/'partial' only — a technical failure is not the market's fault). The pre-search
  // warning uses it to tell a dead market (salons in Lebanon) from a merely thin one. Null when there is too
  // little past work to judge, so a new market is never branded dead on one unlucky search.
  async marketRate(sector: string, countries: string[]) {
    if (!sector || !countries.length) return null;
    const row = await this.db.get<{ delivered: number; requested: number }>(
      `SELECT COALESCE(sum(delivered),0)::int delivered, COALESCE(sum(requested),0)::int requested FROM searches
       WHERE status IN ('completed','partial') AND filters::jsonb->>'sector' = ?
         AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(filters::jsonb->'countries') fc
                     WHERE fc IN (SELECT jsonb_array_elements_text(?::jsonb)))`,
      sector, JSON.stringify(countries));
    if (!row || row.requested < MARKET_MIN_HISTORY) return null;
    return { rate: row.delivered / row.requested, requested: row.requested };
  }
  // A search that failed, or may have been paid at the provider, shows in the owner's activity log: member, search, reason.
  async alert(userId: string, searchId: string, detail: string) {
    const row = await this.db.get<{ name: string; title: string; created_at: string }>('SELECT u.name,s.title,s.created_at FROM searches s JOIN users u ON u.id=s.user_id WHERE s.id=?', searchId);
    await this.audit(userId, 'تنبيه: بحث لم يكتمل', [row?.name, row?.title, row?.created_at.slice(0, 16).replace('T', ' '), detail].filter(Boolean).join(' · '));
  }
  async aiCached(kind: string, input: string) {
    return (await this.db.get<{ output: string }>('SELECT output FROM ai_cache WHERE kind=? AND input=?', kind, input))?.output;
  }
  async saveAiCache(kind: string, input: string, output: string) {
    await this.db.run('INSERT INTO ai_cache(kind,input,output,created_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING', kind, input, output, now());
  }
  async reserved(id: string) {
    // What open searches can still charge: requested minus already delivered (and charged), not the whole request.
    return count(await this.db.get<{ n: number }>('SELECT COALESCE(sum(GREATEST(s.requested-s.delivered,0)),0)::int AS n FROM reservations r JOIN searches s ON s.id=r.search_id WHERE r.user_id=?', id));
  }
  async checkSearchCapacity(id: string, requested: number) {
    const user = await this.user(id);
    if (user.balance < 1) throw new AppError('رصيدك صفر. تواصل مع مالك المنصة لإضافة رصيد قبل البحث.');
    if (user.balance - await this.reserved(id) < requested) throw new AppError('الرصيد المتاح بعد حجز عمليات البحث لا يكفي.');
    if (await this.dailyFetched(id) >= dailyPeople()) throw new AppError(dailyLimit, 429);
    // ponytail: one active search per member prevents competing cursor writes; per-audience leases if parallel searches are needed.
    if (count(await this.db.get<{ n: number }>("SELECT count(*) n FROM searches WHERE user_id=? AND status IN ('queued','awaiting_provider')", id)) >= 1) throw new AppError('لديك بحث قيد التنفيذ. انتظر اكتماله.', 429);
    if (count(await this.db.get<{ n: number }>('SELECT count(*) n FROM reservations')) >= 1000) throw new AppError('قائمة البحث ممتلئة مؤقتًا. حاول لاحقًا.', 503);
  }
  enqueueSearch(id: string, raw: Resolved): Promise<Search> {
    const input = resolvedSchema.parse(raw);
    return this.transaction(async () => {
      await this.user(id, true);
      const old = await this.db.get<Search>('SELECT * FROM searches WHERE user_id=? AND request_id=?', id, input.requestId);
      if (old) {
        if (old.filters !== JSON.stringify(input)) throw new AppError('معرّف الطلب مستخدم لبحث مختلف.', 409);
        return old;
      }
      await this.checkSearchCapacity(id, input.count);
      const sid = randomUUID();
      await this.db.run('INSERT INTO searches(id,user_id,request_id,filters,title,requested,status,created_at) VALUES(?,?,?,?,?,?,?,?)',
        sid, id, input.requestId, JSON.stringify(input), (input.mode === 'companies' ? 'شركات · ' : '') + input.sector + ' · ' + (input.city || placesTitle(input.countries)), input.count, 'queued', now());
      await this.db.run('INSERT INTO reservations(search_id,user_id,amount) VALUES(?,?,?)', sid, id, input.count);
      return this.getSearch(id, sid);
    });
  }
  async getSearch(id: string, searchId: string): Promise<Search> {
    await this.user(id);
    const row = await this.db.get<Search>('SELECT * FROM searches WHERE user_id=? AND id=?', id, searchId);
    if (!row) throw new AppError('البحث غير موجود في حسابك.', 404);
    return row;
  }
  // Inserts new contacts for this search and debits 1 credit each, up to the requested count; duplicates for this
  // member are counted, never charged. Returns the search's delivered total. Caller holds the member's row lock.
  private async deliverInto(search: Search, candidates: Candidate[], origin: 'provider' | 'catalog') {
    if (crmEnabled()) await this.db.run('LOCK TABLE catalog_suppressions IN SHARE MODE');
    const current = count(await this.db.get<{ n: number }>('SELECT delivered AS n FROM searches WHERE id=?', search.id));
    const sector = (JSON.parse(search.filters) as Resolved).sector, seen = new Set<string>();
    // One email per company in a search, from every source (the saved catalog too). Checked after the duplicate check, so an
    // address the member already has never takes a new one's place (Kudu 3 times and Al Tazaj twice in one search, 2026-10-05).
    const taken = await this.takenCompanies(search.id);
    let delivered = 0, duplicates = 0, sameCompany = 0;
    for (const candidate of candidates.slice(0, 1000)) {
      const email = normalizeEmail(candidate.email || '');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) continue;
      if (crmEnabled() && await this.db.get("SELECT 1 FROM catalog_suppressions WHERE email=? UNION ALL SELECT 1 FROM crm_exclusions WHERE user_id=? AND (value=? OR value=split_part(?::text,'@',2)) LIMIT 1",email,search.user_id,email,email)) continue;
      if (seen.has(email) || await this.db.get('SELECT 1 FROM contacts WHERE user_id=? AND email=?', search.user_id, email)) { duplicates++; continue; }
      seen.add(email);
      const keys = companyKeys(candidate);
      if (keys.some(k => taken.has(k))) { sameCompany++; continue; }
      if (current + delivered >= search.requested) break;
      keys.forEach(k => taken.add(k));
      const cid = randomUUID(), c: Candidate = { ...candidate, email };
      await this.db.run('INSERT INTO contacts(id,user_id,search_id,kind,name,email,company,title,sector,country,city,website,size,source,email_status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        cid, search.user_id, search.id, c.kind ?? 'person', c.name, c.email, c.company, c.title, c.sector, c.country, c.city, c.website, c.size, c.source, c.email_status, now());
      await this.credit(search.user_id, -1, 'debit', 'بريد جديد من ' + sector, 'delivery:' + cid);
      if (crmEnabled()) await this.db.run('INSERT INTO crm_deliveries(contact_id,origin,created_at) VALUES(?,?,?)',cid,origin,now());
      delivered++;
    }
    await this.db.run('UPDATE searches SET delivered=delivered+?,duplicates=duplicates+? WHERE id=?', delivered, duplicates, search.id);
    if (sameCompany) await recordCoverage(this, search.user_id, search.id, 'delivery', { sameCompany }); // found (and paid at the provider), not charged
    return current + delivered;
  }
  // The companies a search already has an email for (companyKeys): one email per company in a search.
  async takenCompanies(searchId: string) {
    return new Set((await this.db.all<Candidate>('SELECT website,email,company FROM contacts WHERE search_id=?', searchId)).flatMap(companyKeys));
  }
  // Provider flow (live-search.ts): deliver one batch into a search that is still waiting on the provider.
  // Returns the search's delivered total, or null when the search is no longer waiting (closed, cancelled).
  deliverBatch(userId: string, searchId: string, candidates: Candidate[], origin: 'provider' | 'catalog' = 'provider'): Promise<number | null> {
    return this.transaction(async () => {
      await this.user(userId, true);
      const search = await this.db.get<Search>("SELECT * FROM searches WHERE id=? AND user_id=? AND status='awaiting_provider'", searchId, userId);
      return search ? this.deliverInto(search, candidates, origin) : null;
    });
  }
  async notifySearch(searchId: string, message = '') {
    if (crmEnabled()) await this.db.run("INSERT INTO crm_notifications(id,user_id,search_id,message,created_at) SELECT ?,user_id,id,title || ' · ' || CASE WHEN ?::text='' THEN delivered::text || '/' || requested::text ELSE ?::text END,? FROM searches WHERE id=? ON CONFLICT(search_id) DO NOTHING",randomUUID(),message,message,now(),searchId);
  }
  finishSearch(searchId: string) {
    return this.transaction(async () => {
      const changed = await this.db.run("UPDATE searches SET status=CASE WHEN delivered>=requested THEN 'completed' ELSE 'partial' END WHERE id=? AND status='awaiting_provider'", searchId);
      await this.db.run('DELETE FROM reservations WHERE search_id=?', searchId);
      if (changed) await this.notifySearch(searchId);
    });
  }
  // True only for the one request that claims this person for the member: not already a contact, and not already
  // sent to the provider (the insert is the atomic claim), so no one is paid for twice, even by overlapping searches.
  async claimPerson(userId: string, key: string, name: string, company: string, companyDomain = '') {
    if (await this.db.get(`SELECT 1 FROM contacts WHERE user_id=? AND ((lower(name)=lower(?::text) AND lower(company)=lower(?::text))
      OR (?<>'' AND kind='company' AND split_part(regexp_replace(lower(website),'^(https{0,1}://){0,1}(www[0-9]*\\.){0,1}|[/#].*$','','g'),chr(63),1)=?))`, userId, name.trim(), company.trim(), companyDomain, companyDomain)) return false;
    return await this.db.run('INSERT INTO provider_seen(user_id,person_key) VALUES(?,?) ON CONFLICT DO NOTHING', userId, key) === 1;
  }
  unmarkSeen(userId: string, keys: string[]) {
    return this.transaction(async () => { for (const key of keys) await this.db.run('DELETE FROM provider_seen WHERE user_id=? AND person_key=?', userId, key); });
  }
  // Where this member stopped in the provider's result list for the same filters, so repeat searches go deeper.
  async cursor(userId: string, queryKey: string) {
    return (await this.db.get<{ stage: number; token: string | null; leftovers: string }>('SELECT stage,token,leftovers FROM provider_cursors WHERE user_id=? AND query_key=?', userId, queryKey)) ?? { stage: 0, token: null, leftovers: '[]' };
  }
  async saveCursor(userId: string, queryKey: string, stage: number, token: string | null, leftovers: string) {
    await this.db.run(`INSERT INTO provider_cursors(user_id,query_key,stage,token,leftovers) VALUES(?,?,?,?,?)
      ON CONFLICT(user_id,query_key) DO UPDATE SET stage=excluded.stage,token=excluded.token,leftovers=excluded.leftovers`, userId, queryKey, stage, token, leftovers);
  }
  async contactsForExport(userId: string, ids?: string[], searchId?: string, record = true) {
    await this.user(userId);
    let contacts = await this.db.all<Contact>('SELECT * FROM contacts WHERE user_id=? ORDER BY created_at DESC', userId);
    if (searchId) contacts = contacts.filter(c => c.search_id === searchId);
    if (ids) {
      const chosen = new Set(ids);
      contacts = contacts.filter(c => chosen.has(c.id));
      if (contacts.length !== chosen.size) throw new AppError('بعض النتائج غير موجودة في حسابك.', 403);
    }
    if (!contacts.length) throw new AppError('لا توجد نتائج لتنزيلها.');
    if (record) await this.db.run('INSERT INTO exports(id,user_id,row_count,created_at) VALUES(?,?,?,?)', randomUUID(), userId, contacts.length, now());
    return contacts;
  }
  async invite(adminId: string, name: string, email: string | undefined, credits: number) {
    await this.admin(adminId);
    if (email && await this.db.get('SELECT 1 FROM users WHERE email=?', normalizeEmail(email))) throw new AppError('يوجد حساب بهذا البريد بالفعل.');
    const token = randomBytes(24).toString('hex'), id = randomUUID();
    await this.db.run('INSERT INTO invitations(id,token_hash,name,email,credits,expires_at,used_at,created_at) VALUES(?,?,?,?,?,?,NULL,?)',
      id, hash(token), name, email ? normalizeEmail(email) : '', credits, new Date(Date.now() + 2 * 86400000).toISOString(), now());
    await this.audit(adminId, 'دعوة مشترك', name);
    return { token, id };
  }
  async invitation(token: string) {
    const row = await this.db.get<Invitation & { token_hash: string }>('SELECT * FROM invitations WHERE token_hash=?', hash(token));
    if (!row || row.used_at || row.expires_at <= now()) throw new AppError('الدعوة غير صالحة أو انتهت مدتها.', 410);
    return { id: row.id, name: row.name, email: row.email, credits: row.credits };
  }
  acceptInvite(token: string, password: string, email?: string, agreed = false) {
    return this.transaction(async () => {
      const invitation = await this.invitation(token);
      const chosen = registrationEmail.safeParse(email ?? invitation.email);
      if (!chosen.success) throw new AppError('اكتب بريدًا إلكترونيًا صالحًا لإكمال التسجيل.');
      if (invitation.email && chosen.data !== invitation.email) throw new AppError('هذه الدعوة مخصصة للبريد المعروض فقط.');
      // The conditional update is the claim: a second, concurrent accept of the same link finds it used.
      if (!await this.db.run('UPDATE invitations SET used_at=?,email=? WHERE id=? AND used_at IS NULL AND expires_at>?', now(), chosen.data, invitation.id, now())) throw new AppError('الدعوة غير صالحة أو انتهت مدتها.', 410);
      if (await this.db.get('SELECT 1 FROM users WHERE email=?', chosen.data)) throw new AppError('الحساب موجود بالفعل. سجّل الدخول.');
      const user = await this.addUser(invitation.name, chosen.data, password, 'member', invitation.credits);
      if (agreed) await this.acceptTerms(user.id);
      return this.createSession(user.id);
    }).catch((error:unknown)=>{
      // Two different links may choose the same email concurrently. Roll back the unused link and its credits.
      const databaseError=error as {code?:string;constraint_name?:string;constraint?:string};
      if(databaseError?.code==='23505'&&/users_email/.test(databaseError.constraint_name||databaseError.constraint||''))throw new AppError('الحساب موجود بالفعل. سجّل الدخول.');
      throw error;
    });
  }
  async adjustCredits(adminId: string, userId: string, mode: 'add' | 'set', amount: number, reason: string, requestId: string) {
    await this.admin(adminId);
    return this.transaction(async () => {
      const target = await this.db.get<{ balance: number }>("SELECT balance FROM users WHERE id=? AND role='member' FOR UPDATE", userId);
      if (!target) throw new AppError('المشترك غير موجود.', 404);
      if (await this.db.get('SELECT 1 FROM ledger WHERE reference=?', 'adjust:' + requestId)) return;
      if (mode === 'set' && amount < await this.reserved(userId)) throw new AppError('ألغِ عمليات البحث الجارية أولًا قبل تعيين رصيد أقل من المحجوز.');
      const delta = mode === 'set' ? amount - target.balance : amount;
      await this.credit(userId, delta, delta >= 0 ? 'grant' : 'adjustment', reason, 'adjust:' + requestId);
      await this.audit(adminId, 'تعديل الرصيد', 'تعديل بمقدار ' + delta + ' كريدت · ' + reason);
    });
  }
  async setActive(adminId: string, userId: string, active: boolean) {
    await this.admin(adminId);
    await this.transaction(async () => {
      const target = await this.db.get<{ name: string }>("SELECT name FROM users WHERE id=? AND role='member' FOR UPDATE", userId);
      if (!target) throw new AppError('المشترك غير موجود.', 404);
      await this.db.run('UPDATE users SET active=? WHERE id=?', active ? 1 : 0, userId);
      if (!active) {
        await this.db.run('DELETE FROM sessions WHERE user_id=?', userId);
        await this.db.run("UPDATE searches SET status='cancelled' WHERE user_id=? AND status IN ('queued','awaiting_provider')", userId);
        await this.db.run('DELETE FROM reservations WHERE user_id=?', userId);
      }
      await this.audit(adminId, active ? 'تفعيل الحساب' : 'تعطيل الحساب', target.name);
    });
  }
  // The first acceptance of the current terms is kept; terms that changed since (TERMS_VERSION) are accepted anew.
  async acceptTerms(id: string) {
    await this.user(id);
    await this.db.run('UPDATE users SET terms_accepted_at=? WHERE id=? AND (terms_accepted_at IS NULL OR terms_accepted_at < ?)', now(), id, TERMS_VERSION);
  }
  async updateProfile(id: string, name: string) {
    await this.user(id);
    await this.db.run('UPDATE users SET name=? WHERE id=?', name, id);
  }
  private async checkCurrent(id: string, password: string) {
    const row = (await this.db.get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=?', id))!;
    if (!checkPassword(password, row.password_hash)) throw new AppError('كلمة المرور الحالية غير صحيحة.');
  }
  async changePassword(id: string, oldPassword: string, newPassword: string) {
    return this.transaction(async () => {
      await this.user(id, true);
      await this.checkCurrent(id, oldPassword);
      await this.db.run('UPDATE users SET password_hash=? WHERE id=?', passwordHash(newPassword), id);
      await this.db.run('DELETE FROM sessions WHERE user_id=?', id);
      await this.revokeResets(id);
      return this.createSession(id);
    });
  }
  private async resetToken(userId: string, ttlMs: number) {
    const token = randomBytes(24).toString('hex');
    await this.db.run('INSERT INTO reset_tokens(token_hash,user_id,expires_at,used_at) VALUES(?,?,?,NULL)', hash(token), userId, new Date(Date.now() + ttlMs).toISOString());
    return token;
  }
  // Only the newest reset link works: a new link, a used one or a password change cancels the others.
  private revokeResets(userId: string) { return this.db.run('UPDATE reset_tokens SET used_at=? WHERE user_id=? AND used_at IS NULL', now(), userId); }
  async createReset(adminId: string, userId: string) {
    await this.admin(adminId);
    return this.transaction(async () => {
      const target = await this.user(userId, true);
      // Members only: a hijacked owner session must not mint a reset link for the owner's own account.
      if (target.role !== 'member') throw new AppError('المشترك غير موجود.', 404);
      await this.revokeResets(userId);
      const token = await this.resetToken(userId, 3600000);
      await this.audit(adminId, 'رابط استعادة الوصول', target.name);
      return token;
    });
  }
  // Server-side setup only (scripts/create-owner.ts): the owner picks a password through a 24h one-time link.
  createOwner(name: string, email: string) {
    return this.transaction(async () => {
      if (await this.db.get('SELECT 1 FROM users WHERE email=?', normalizeEmail(email))) throw new AppError('يوجد حساب بهذا البريد بالفعل.');
      const owner = await this.addUser(name, email, randomBytes(32).toString('hex'), 'admin');
      await this.audit(owner.id, 'إنشاء حساب المالك', name);
      return this.resetToken(owner.id, 86400000);
    });
  }
  // A new code, after the current password: the old code stops working.
  async createRecoveryCode(adminId: string, password: string) {
    return this.transaction(async () => {
      await this.user(adminId, true);
      const owner = await this.admin(adminId);
      await this.checkCurrent(adminId, password);
      const code = recoveryCode();
      await this.db.run('UPDATE users SET recovery_hash=? WHERE id=?', codeHash(code), adminId);
      await this.audit(adminId, 'رمز استرجاع جديد', owner.name);
      return code;
    });
  }
  // Email + code -> a new password, every other session and reset link ended, and a new code shown once in place of the spent one.
  recover(email: string, code: string, password: string) {
    return this.transaction(async () => {
      const next = recoveryCode();
      // The conditional update is the claim: a code works once, even when sent twice at the same moment.
      const row = await this.db.get<{ id: string; name: string }>("UPDATE users SET recovery_hash=?,password_hash=? WHERE email=? AND recovery_hash=? AND role='admin' AND active=1 RETURNING id,name",
        codeHash(next), passwordHash(password), normalizeEmail(email), codeHash(code));
      if (!row) throw new AppError('البريد أو رمز الاسترجاع غير صحيح.', 401);
      await this.db.run('DELETE FROM sessions WHERE user_id=?', row.id);
      await this.revokeResets(row.id);
      await this.audit(row.id, 'استرجاع كلمة المرور برمز الاسترجاع', row.name);
      return { token: await this.createSession(row.id), code: next };
    });
  }
  // Handing the platform to its owner (scripts/owner-handover.ts): a one-time 24h link through which the new owner picks the
  // sign-in email and password. admin/reset never mints links for the owner, so only this script and create-owner do.
  async ownerHandover() {
    const owner = await this.db.get<{ id: string }>("SELECT id FROM users WHERE role='admin' AND active=1 ORDER BY created_at LIMIT 1");
    if (!owner) throw new AppError('المشترك غير موجود.', 404);
    await this.revokeResets(owner.id);
    return this.resetToken(owner.id, 86400000);
  }
  claimOwner(token: string, email: string, password: string) {
    return this.transaction(async () => {
      // Marking the link used is the claim; a refusal below rolls it back, so the link stays usable.
      const row = await this.db.get<{ user_id: string }>(`UPDATE reset_tokens t SET used_at=? FROM users u WHERE t.token_hash=? AND t.used_at IS NULL AND t.expires_at>?
        AND u.id=t.user_id AND u.role='admin' AND u.active=1 RETURNING t.user_id`, now(), hash(token), now());
      if (!row) throw new AppError('رابط الاستعادة غير صالح أو انتهت مدته.', 410);
      const address = normalizeEmail(email);
      if (await this.db.get('SELECT 1 FROM users WHERE email=? AND id<>?', address, row.user_id)) throw new AppError('يوجد حساب بهذا البريد بالفعل.');
      await this.db.run('UPDATE users SET email=?,password_hash=?,recovery_hash=NULL WHERE id=?', address, passwordHash(password), row.user_id);
      await this.db.run('DELETE FROM sessions WHERE user_id=?', row.user_id);
      await this.revokeResets(row.user_id);
      await this.audit(row.user_id, 'تسليم حساب المالك', address);
      return this.createSession(row.user_id);
    });
  }
  resetPassword(token: string, password: string) {
    return this.transaction(async () => {
      // Lock the account before reset tokens, like password changes and reset creation, to avoid lock-order deadlocks.
      const target = await this.db.get<{ user_id: string }>('SELECT user_id FROM reset_tokens WHERE token_hash=?', hash(token));
      if (!target) throw new AppError('رابط الاستعادة غير صالح أو انتهت مدته.', 410);
      await this.user(target.user_id, true);
      // Marking the token used is the claim: a link works once, even when opened twice at the same moment.
      const row = await this.db.get<{ user_id: string }>('UPDATE reset_tokens SET used_at=? WHERE token_hash=? AND used_at IS NULL AND expires_at>? RETURNING user_id', now(), hash(token), now());
      if (!row) throw new AppError('رابط الاستعادة غير صالح أو انتهت مدته.', 410);
      await this.user(row.user_id);
      await this.db.run('UPDATE users SET password_hash=? WHERE id=?', passwordHash(password), row.user_id);
      await this.db.run('DELETE FROM sessions WHERE user_id=?', row.user_id);
      await this.revokeResets(row.user_id);
      return this.createSession(row.user_id);
    });
  }
}
const globalStore = globalThis as unknown as { waslStore?: Store };
export function getStore() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new AppError('قاعدة البيانات غير مهيأة على الخادم. تواصل مع مالك المنصة.', 503);
  return globalStore.waslStore ??= new Store(new Db(pgDriver(url)));
}
