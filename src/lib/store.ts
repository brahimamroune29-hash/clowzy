import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { searchSchema } from './contracts';
import type { AdminUser, AuditEvent, Candidate, Contact, ExportEvent, Invitation, Ledger, LeadProvider, Search, SearchInput, Snapshot, User } from './contracts';
import { demoProvider } from './demo-provider';
import { weekBoundaries, weekBoundariesSchema } from './overview';

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
const userFields = 'id,name,email,role,active,balance,created_at';
const normalizeEmail = (value: string) => value.trim().toLowerCase();

export class Store {
  db: DatabaseSync;
  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','member')), active INTEGER NOT NULL DEFAULT 1,
        balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0), created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invitations (
        id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL,
        credits INTEGER NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS searches (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), request_id TEXT NOT NULL,
        filters TEXT NOT NULL, title TEXT NOT NULL, requested INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT 0,
        duplicates INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(user_id, request_id)
      );
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), search_id TEXT NOT NULL REFERENCES searches(id),
        name TEXT NOT NULL, email TEXT NOT NULL, company TEXT NOT NULL, title TEXT NOT NULL, sector TEXT NOT NULL,
        country TEXT NOT NULL, city TEXT NOT NULL, website TEXT NOT NULL, size TEXT NOT NULL,
        source TEXT NOT NULL, email_status TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(user_id,email)
      );
      CREATE TABLE IF NOT EXISTS ledger (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), amount INTEGER NOT NULL,
        kind TEXT NOT NULL, reason TEXT NOT NULL, reference TEXT UNIQUE NOT NULL, balance_after INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS exports (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), row_count INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit (
        id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES users(id), action TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reset_tokens (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL, used_at TEXT
      );
      CREATE TABLE IF NOT EXISTS search_jobs (
        search_id TEXT PRIMARY KEY REFERENCES searches(id), attempts INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL, lease_token TEXT, lease_until INTEGER, last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS reservations (
        search_id TEXT PRIMARY KEY REFERENCES searches(id), user_id TEXT NOT NULL REFERENCES users(id),
        amount INTEGER NOT NULL CHECK(amount > 0)
      );
      CREATE TABLE IF NOT EXISTS worker_heartbeats (id TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_available ON search_jobs(available_at,lease_until);
      CREATE INDEX IF NOT EXISTS reservations_owner ON reservations(user_id);
      CREATE INDEX IF NOT EXISTS search_status ON searches(status,created_at);
      CREATE INDEX IF NOT EXISTS contacts_page ON contacts(user_id,created_at DESC,id);
      CREATE INDEX IF NOT EXISTS contacts_search ON contacts(user_id,search_id);
      CREATE INDEX IF NOT EXISTS exports_owner ON exports(user_id,created_at DESC);
      CREATE INDEX IF NOT EXISTS sessions_owner ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS users_role ON users(role,created_at DESC);
      CREATE INDEX IF NOT EXISTS contacts_owner ON contacts(user_id);
      CREATE INDEX IF NOT EXISTS searches_owner ON searches(user_id,created_at);
      CREATE INDEX IF NOT EXISTS ledger_owner ON ledger(user_id,created_at);
    `);
  }
  close() { this.db.close(); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  user(id: string): User {
    const user = this.db.prepare('SELECT ' + userFields + ' FROM users WHERE id=?').get(id) as User | undefined;
    if (!user || !user.active) throw new AppError('الحساب غير متاح أو تم تعطيله.', 401);
    return user;
  }
  admin(id: string) {
    const user = this.user(id);
    if (user.role !== 'admin') throw new AppError('هذه العملية متاحة لمالك المنصة فقط.', 403);
    return user;
  }
  addUser(name: string, email: string, password: string, role: 'admin' | 'member' = 'member', credits = 0) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(id, name, normalizeEmail(email), passwordHash(password), role, now());
    if (credits) this.credit(id, credits, 'grant', 'رصيد البداية', 'initial:' + id);
    return this.user(id);
  }
  private credit(userId: string, amount: number, kind: string, reason: string, reference: string) {
    if (this.db.prepare('SELECT 1 FROM ledger WHERE reference=?').get(reference)) return;
    const result = this.db.prepare('UPDATE users SET balance=balance+? WHERE id=? AND balance+? >= 0').run(amount, userId, amount);
    if (!result.changes) throw new AppError('الرصيد المتاح لا يكفي لهذه العملية.');
    const balance = (this.db.prepare('SELECT balance FROM users WHERE id=?').get(userId) as { balance: number }).balance;
    this.db.prepare('INSERT INTO ledger VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), userId, amount, kind, reason, reference, balance, now());
  }
  private audit(actor: string, action: string, detail: string) {
    this.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?)').run(randomUUID(), actor, action, detail, now());
  }
  login(email: string, password: string) {
    const row = this.db.prepare('SELECT id,password_hash FROM users WHERE email=?').get(normalizeEmail(email)) as { id: string; password_hash: string } | undefined;
    if (!row || !checkPassword(password, row.password_hash)) throw new AppError('البريد الإلكتروني أو كلمة المرور غير صحيحة.', 401);
    return this.createSession(this.user(row.id).id);
  }
  createSession(id: string) {
    this.user(id);
    const token = randomBytes(32).toString('hex');
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
    this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(token), id, new Date(Date.now() + 7 * 86400000).toISOString());
    return token;
  }
  session(token?: string) {
    if (!token) throw new AppError('سجّل الدخول للمتابعة.', 401);
    const row = this.db.prepare('SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?').get(hash(token), now()) as { user_id: string } | undefined;
    if (!row) throw new AppError('انتهت جلستك. سجّل الدخول مجددًا.', 401);
    return this.user(row.user_id);
  }
  logout(token: string) { this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token)); }
  snapshot(id: string): Snapshot {
    const user = this.user(id);
    const snapshot: Snapshot = {
      user,
      contacts: this.db.prepare('SELECT * FROM contacts WHERE user_id=? ORDER BY created_at DESC,id').all(id) as Contact[],
      searches: this.db.prepare('SELECT * FROM searches WHERE user_id=? ORDER BY created_at DESC').all(id) as Search[],
      ledger: this.db.prepare('SELECT id,amount,kind,reason,created_at,balance_after FROM ledger WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 200').all(id) as Ledger[],
      exports: this.db.prepare('SELECT id,row_count,created_at FROM exports WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(id) as ExportEvent[],
    };
    if (user.role === 'admin') {
      const users = this.db.prepare(`SELECT ${userFields.split(',').map(f => 'u.' + f).join(',')},
        (SELECT count(*) FROM contacts WHERE user_id=u.id) AS leads,
        (SELECT count(*) FROM searches WHERE user_id=u.id) AS searches,
        (SELECT count(*) FROM exports WHERE user_id=u.id) AS exports
        FROM users u WHERE role='member' ORDER BY created_at DESC`).all() as AdminUser[];
      snapshot.admin = {
        users,
        invitations: this.db.prepare('SELECT id,name,email,credits,expires_at,used_at,created_at FROM invitations ORDER BY created_at DESC').all() as Invitation[],
        audit: this.db.prepare('SELECT id,action,detail,created_at FROM audit ORDER BY created_at DESC LIMIT 80').all() as AuditEvent[],
        totals: {
          delivered: users.reduce((a, u) => a + u.leads, 0),
          searches: users.reduce((a, u) => a + u.searches, 0),
          exports: users.reduce((a, u) => a + u.exports, 0),
          used: (this.db.prepare("SELECT COALESCE(-sum(amount),0) AS n FROM ledger WHERE kind='debit'").get() as {n: number}).n,
        },
      };
    }
    return snapshot;
  }
  overview(id: string, days = weekBoundaries()): Snapshot {
    const boundaries = weekBoundariesSchema.parse(days).map(day=>new Date(day).toISOString());
    // Keep totals and recent rows from the same read snapshot; do not cache balances.
    this.db.exec('BEGIN');
    try {
      const user = this.user(id);
      const counts = this.db.prepare(`SELECT
        (SELECT count(*) FROM contacts WHERE user_id=?) AS contacts,
        (SELECT count(*) FROM searches WHERE user_id=?) AS searches,
        (SELECT count(*) FROM exports WHERE user_id=?) AS exports`).get(id,id,id) as {contacts:number;searches:number;exports:number};
      const daily = this.db.prepare('SELECT count(*) AS n FROM contacts WHERE user_id=? AND created_at>=? AND created_at<?');
      const summary = {...counts, weekly: boundaries.slice(0,7).map((start,index)=>({
        start, end:boundaries[index+1], count:(daily.get(id,start,boundaries[index+1]) as {n:number}).n,
      }))};
      const result: Snapshot = {
        user, summary, contacts:[], ledger:[], exports:[],
        searches:this.db.prepare('SELECT * FROM searches WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 4').all(id) as Search[],
      };
      if(user.role==='admin') {
        const memberCounts=this.db.prepare(`SELECT count(*) AS members, COALESCE(sum(CASE WHEN active=1 THEN 1 ELSE 0 END),0) AS activeMembers
          FROM users WHERE role='member'`).get() as {members:number;activeMembers:number};
        const totals=this.db.prepare(`SELECT
          (SELECT count(*) FROM contacts c JOIN users u ON u.id=c.user_id WHERE u.role='member') AS delivered,
          (SELECT count(*) FROM searches s JOIN users u ON u.id=s.user_id WHERE u.role='member') AS searches,
          (SELECT count(*) FROM exports e JOIN users u ON u.id=e.user_id WHERE u.role='member') AS exports,
          (SELECT COALESCE(-sum(amount),0) FROM ledger WHERE kind='debit') AS used`).get() as {delivered:number;searches:number;exports:number;used:number};
        result.admin={
          users:this.db.prepare(`SELECT ${userFields.split(',').map(f=>'u.'+f).join(',')},
            (SELECT count(*) FROM contacts WHERE user_id=u.id) AS leads,
            (SELECT count(*) FROM searches WHERE user_id=u.id) AS searches,
            (SELECT count(*) FROM exports WHERE user_id=u.id) AS exports
            FROM (SELECT * FROM users WHERE role='member' ORDER BY created_at DESC,id DESC LIMIT 5) u
            ORDER BY u.created_at DESC,u.id DESC`).all() as AdminUser[],
          invitations:[],
          audit:this.db.prepare('SELECT id,action,detail,created_at FROM audit ORDER BY created_at DESC,id DESC LIMIT 4').all() as AuditEvent[],
          totals:{...totals,...memberCounts},
        };
      }
      this.db.exec('COMMIT');
      return result;
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  reserved(id: string): number {
    return (this.db.prepare('SELECT COALESCE(sum(amount),0) AS n FROM reservations WHERE user_id=?').get(id) as {n:number}).n;
  }
  enqueueSearch(id: string, raw: SearchInput): Search {
    const input = searchSchema.parse(raw);
    return this.transaction(() => {
      const user = this.user(id);
      const old = this.db.prepare('SELECT * FROM searches WHERE user_id=? AND request_id=?').get(id, input.requestId) as Search | undefined;
      if (old) {
        if (old.filters !== JSON.stringify(input)) throw new AppError('معرّف الطلب مستخدم لبحث مختلف.', 409);
        return old;
      }
      if (user.balance - this.reserved(id) < input.count) throw new AppError('الرصيد المتاح بعد حجز عمليات البحث لا يكفي.');
      const pending = (this.db.prepare("SELECT count(*) n FROM searches WHERE user_id=? AND status IN ('queued','running','awaiting_provider')").get(id) as {n:number}).n;
      if (pending >= 2) throw new AppError('لديك عمليتا بحث قيد التنفيذ. انتظر اكتمالهما.', 429);
      if ((this.db.prepare('SELECT count(*) n FROM reservations').get() as {n:number}).n >= 1000) throw new AppError('قائمة البحث ممتلئة مؤقتًا. حاول لاحقًا.', 503);
      const sid = randomUUID();
      this.db.prepare('INSERT INTO searches(id,user_id,request_id,filters,title,requested,status,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(sid, id, input.requestId, JSON.stringify(input), input.sector + ' · ' + (input.city || input.country), input.count, 'queued', now());
      this.db.prepare('INSERT INTO reservations VALUES(?,?,?)').run(sid,id,input.count);
      this.db.prepare('INSERT INTO search_jobs(search_id,available_at) VALUES(?,?)').run(sid,Date.now());
      return this.getSearch(id,sid);
    });
  }
  getSearch(id: string, searchId: string): Search {
    this.user(id);
    const row = this.db.prepare('SELECT * FROM searches WHERE user_id=? AND id=?').get(id,searchId) as Search | undefined;
    if (!row) throw new AppError('البحث غير موجود في حسابك.',404);
    return row;
  }
  cancelSearch(id: string, searchId: string) {
    return this.transaction(() => {
      const row = this.getSearch(id,searchId);
      if (!['queued','running'].includes(row.status)) return row;
      this.db.prepare("UPDATE searches SET status='cancelled' WHERE id=?").run(searchId);
      this.db.prepare('DELETE FROM reservations WHERE search_id=?').run(searchId);
      this.db.prepare('UPDATE search_jobs SET lease_token=NULL,lease_until=NULL WHERE search_id=?').run(searchId);
      return this.getSearch(id,searchId);
    });
  }
  claimJob(searchId?: string): {search: Search; token: string} | null {
    return this.transaction(() => {
      // An expired lease is retryable. A fencing token prevents a late worker from committing.
      const expired = this.db.prepare(`SELECT s.id FROM searches s JOIN search_jobs j ON j.search_id=s.id
        WHERE s.status IN ('queued','running') AND j.attempts>=3 AND (j.lease_until IS NULL OR j.lease_until<=?)`).all(Date.now()) as {id:string}[];
      for (const r of expired) {
        this.db.prepare("UPDATE searches SET status='failed' WHERE id=?").run(r.id);
        this.db.prepare('DELETE FROM reservations WHERE search_id=?').run(r.id);
      }
      const row = this.db.prepare(`SELECT s.* FROM searches s JOIN search_jobs j ON j.search_id=s.id
        WHERE s.status IN ('queued','running') AND j.available_at<=? AND (j.lease_until IS NULL OR j.lease_until<=?)
        AND j.attempts<3 ${searchId?'AND s.id=?':''} ORDER BY j.available_at,s.created_at,s.id LIMIT 1`)
        .get(...(searchId?[Date.now(),Date.now(),searchId]:[Date.now(),Date.now()])) as Search | undefined;
      if (!row) return null;
      const token = randomUUID();
      this.db.prepare('UPDATE search_jobs SET attempts=attempts+1,lease_token=?,lease_until=? WHERE search_id=?').run(token,Date.now()+60000,row.id);
      this.db.prepare("UPDATE searches SET status='running' WHERE id=?").run(row.id);
      return {search:{...row,status:'running'},token};
    });
  }
  private ownsJob(searchId: string, token: string) {
    return !!this.db.prepare(`SELECT 1 FROM search_jobs j JOIN searches s ON s.id=j.search_id
      WHERE s.id=? AND s.status='running' AND j.lease_token=? AND j.lease_until>?`).get(searchId,token,Date.now());
  }
  async executeJob(claim: {search: Search; token: string}, provider: LeadProvider = demoProvider, retry = true, timeoutMs = 30000) {
    const {search,token} = claim, input: SearchInput = JSON.parse(search.filters);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      this.user(search.user_id);
      const timeout = new Promise<never>((_,reject) => { timer=setTimeout(() => {controller.abort();reject(new Error('provider_timeout'));},timeoutMs); });
      const candidates = await Promise.race([Promise.resolve().then(()=>provider.search(input,controller.signal)),timeout]);
      this.transaction(() => {
        if (!this.ownsJob(search.id,token)) return;
        this.user(search.user_id);
        let delivered=0, duplicates=0;
        const seen=new Set<string>();
        for (const candidate of candidates.slice(0,1000)) {
          const email=normalizeEmail(candidate.email || '');
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length>254) continue;
          if (seen.has(email) || this.db.prepare('SELECT 1 FROM contacts WHERE user_id=? AND email=?').get(search.user_id,email)) {duplicates++;continue;}
          seen.add(email);
          if (delivered>=input.count) break;
          const cid=randomUUID(),c:Candidate={...candidate,email};
          this.db.prepare('INSERT INTO contacts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(cid,search.user_id,search.id,c.name,c.email,c.company,c.title,c.sector,c.country,c.city,c.website,c.size,c.source,c.email_status,now());
          this.credit(search.user_id,-1,'debit','بريد جديد من '+input.sector,'delivery:'+cid);
          delivered++;
        }
        this.db.prepare('UPDATE searches SET delivered=?,duplicates=?,status=? WHERE id=?').run(delivered,duplicates,delivered<input.count?'partial':'completed',search.id);
        this.db.prepare('DELETE FROM reservations WHERE search_id=?').run(search.id);
        this.db.prepare('UPDATE search_jobs SET lease_token=NULL,lease_until=NULL,last_error=NULL WHERE search_id=?').run(search.id);
      });
    } catch {
      this.transaction(() => {
        if (!this.ownsJob(search.id,token)) return;
        const attempts=(this.db.prepare('SELECT attempts FROM search_jobs WHERE search_id=?').get(search.id) as {attempts:number}).attempts;
        const active=(this.db.prepare('SELECT active FROM users WHERE id=?').get(search.user_id) as {active:number}).active;
        const again=retry && attempts<3 && active;
        this.db.prepare('UPDATE searches SET status=? WHERE id=?').run(again?'queued':'failed',search.id);
        this.db.prepare('UPDATE search_jobs SET lease_token=NULL,lease_until=NULL,available_at=?,last_error=? WHERE search_id=?')
          .run(Date.now()+attempts*2000,'تعذّر إكمال المعالجة. لم يتم خصم رصيد.',search.id);
        if (!again) this.db.prepare('DELETE FROM reservations WHERE search_id=?').run(search.id);
      });
      if (!retry) throw new AppError('تعذّر إكمال البحث. لم يُخصم رصيد لنتائج غير مسلّمة.',502);
    } finally { clearTimeout(timer); }
  }
  async search(id: string, input: SearchInput, provider: LeadProvider = demoProvider): Promise<Search> {
    const row=this.enqueueSearch(id,input),claim=this.claimJob(row.id);
    if (claim) await this.executeJob(claim,provider,false);
    return this.getSearch(id,row.id);
  }
  heartbeat(workerId: string) {
    this.db.prepare('INSERT INTO worker_heartbeats VALUES(?,?) ON CONFLICT(id) DO UPDATE SET seen_at=excluded.seen_at').run(workerId,Date.now());
    this.db.prepare('DELETE FROM worker_heartbeats WHERE seen_at<?').run(Date.now()-86400000);
  }
  contactsForExport(userId: string, ids?: string[], searchId?: string) {
    this.user(userId);
    let contacts = this.db.prepare('SELECT * FROM contacts WHERE user_id=? ORDER BY created_at DESC').all(userId) as Contact[];
    if (searchId) contacts = contacts.filter(c => c.search_id === searchId);
    if (ids) {
      const chosen = new Set(ids);
      contacts = contacts.filter(c => chosen.has(c.id));
      if (contacts.length !== chosen.size) throw new AppError('بعض النتائج غير موجودة في حسابك.', 403);
    }
    if (!contacts.length) throw new AppError('لا توجد نتائج لتنزيلها.');
    this.db.prepare('INSERT INTO exports VALUES(?,?,?,?)').run(randomUUID(), userId, contacts.length, now());
    return contacts;
  }
  invite(adminId: string, name: string, email: string, credits: number) {
    this.admin(adminId);
    if (this.db.prepare('SELECT 1 FROM users WHERE email=?').get(normalizeEmail(email))) throw new AppError('يوجد حساب بهذا البريد بالفعل.');
    const token = randomBytes(24).toString('hex'), id = randomUUID();
    this.db.prepare('INSERT INTO invitations VALUES(?,?,?,?,?,?,NULL,?)').run(id, hash(token), name, normalizeEmail(email), credits, new Date(Date.now() + 2 * 86400000).toISOString(), now());
    this.audit(adminId, 'دعوة مشترك', name);
    return { token, id };
  }
  invitation(token: string) {
    const row = this.db.prepare('SELECT * FROM invitations WHERE token_hash=?').get(hash(token)) as (Invitation & {token_hash:string}) | undefined;
    if (!row || row.used_at || row.expires_at <= now()) throw new AppError('الدعوة غير صالحة أو انتهت مدتها.', 410);
    return { id: row.id, name: row.name, email: row.email, credits: row.credits };
  }
  acceptInvite(token: string, password: string) {
    return this.transaction(() => {
      const invitation = this.invitation(token);
      if (this.db.prepare('SELECT 1 FROM users WHERE email=?').get(invitation.email)) throw new AppError('الحساب موجود بالفعل. سجّل الدخول.');
      const user = this.addUser(invitation.name, invitation.email, password, 'member', invitation.credits);
      this.db.prepare('UPDATE invitations SET used_at=? WHERE id=?').run(now(), invitation.id);
      return this.createSession(user.id);
    });
  }
  adjustCredits(adminId: string, userId: string, mode: 'add' | 'set', amount: number, reason: string, requestId: string) {
    this.admin(adminId);
    return this.transaction(() => {
      const target = this.db.prepare("SELECT balance FROM users WHERE id=? AND role='member'").get(userId) as {balance: number} | undefined;
      if (!target) throw new AppError('المشترك غير موجود.', 404);
      if (this.db.prepare('SELECT 1 FROM ledger WHERE reference=?').get('adjust:' + requestId)) return;
      if (mode === 'set' && amount < this.reserved(userId)) throw new AppError('ألغِ عمليات البحث الجارية أولًا قبل تعيين رصيد أقل من المحجوز.');
      const delta = mode === 'set' ? amount - target.balance : amount;
      this.credit(userId, delta, delta >= 0 ? 'grant' : 'adjustment', reason, 'adjust:' + requestId);
      this.audit(adminId, 'تعديل الرصيد', 'تعديل بمقدار ' + delta + ' كريدت · ' + reason);
    });
  }
  setActive(adminId: string, userId: string, active: boolean) {
    this.admin(adminId);
    this.transaction(() => {
      const target = this.db.prepare("SELECT name FROM users WHERE id=? AND role='member'").get(userId) as {name:string} | undefined;
      if (!target) throw new AppError('المشترك غير موجود.', 404);
      this.db.prepare('UPDATE users SET active=? WHERE id=?').run(active ? 1 : 0, userId);
      if (!active) {
        this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
        this.db.prepare("UPDATE searches SET status='cancelled' WHERE user_id=? AND status IN ('queued','running')").run(userId);
        this.db.prepare('DELETE FROM reservations WHERE user_id=?').run(userId);
      }
      this.audit(adminId, active ? 'تفعيل الحساب' : 'تعطيل الحساب', target.name);
    });
  }
  updateProfile(id: string, name: string) {
    this.user(id);
    this.db.prepare('UPDATE users SET name=? WHERE id=?').run(name, id);
  }
  changePassword(id: string, oldPassword: string, newPassword: string) {
    this.user(id);
    const row = this.db.prepare('SELECT password_hash FROM users WHERE id=?').get(id) as {password_hash:string};
    if (!checkPassword(oldPassword, row.password_hash)) throw new AppError('كلمة المرور الحالية غير صحيحة.');
    this.transaction(() => {
      this.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(passwordHash(newPassword), id);
      this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
    });
    return this.createSession(id);
  }
  private resetToken(userId: string, ttlMs: number) {
    const token = randomBytes(24).toString('hex');
    this.db.prepare('INSERT INTO reset_tokens VALUES(?,?,?,NULL)').run(hash(token), userId, new Date(Date.now() + ttlMs).toISOString());
    return token;
  }
  createReset(adminId: string, userId: string) {
    this.admin(adminId); this.user(userId);
    const token = this.resetToken(userId, 3600000);
    this.audit(adminId, 'رابط استعادة الوصول', this.user(userId).name);
    return token;
  }
  // Server-side setup only (scripts/create-owner.ts): the owner picks a password through a 24h one-time link.
  createOwner(name: string, email: string) {
    return this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM users WHERE email=?').get(normalizeEmail(email))) throw new AppError('يوجد حساب بهذا البريد بالفعل.');
      const owner = this.addUser(name, email, randomBytes(32).toString('hex'), 'admin');
      this.audit(owner.id, 'إنشاء حساب المالك', name);
      return this.resetToken(owner.id, 86400000);
    });
  }
  resetPassword(token: string, password: string) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT user_id FROM reset_tokens WHERE token_hash=? AND used_at IS NULL AND expires_at>?').get(hash(token), now()) as {user_id:string} | undefined;
      if (!row) throw new AppError('رابط الاستعادة غير صالح أو انتهت مدته.', 410);
      this.user(row.user_id);
      this.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(passwordHash(password), row.user_id);
      this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(row.user_id);
      this.db.prepare('UPDATE reset_tokens SET used_at=? WHERE token_hash=?').run(now(), hash(token));
      return this.createSession(row.user_id);
    });
  }
}
const globalStore = globalThis as unknown as { waslStore?: Store };
export function getStore() {
  return globalStore.waslStore ??= new Store(process.env.WASL_DB_PATH || join(process.cwd(), '.data', 'wasl.sqlite'));
}
