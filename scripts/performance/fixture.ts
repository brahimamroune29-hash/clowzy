import { randomUUID } from 'node:crypto';
import { Store } from '../../src/lib/store';
import { demoCatalog } from '../../src/lib/demo-provider';

// Synthetic data only. Never run against the user's preview database.
export function seedPerformanceFixture(store: Store) {
  if (store.db.prepare('SELECT 1 FROM users LIMIT 1').get()) throw new Error('Fixture requires an empty database');
  const created='2026-09-24T12:00:00.000Z';
  const owner=store.addUser('مالك الاختبار','owner@wasl.example','benchmark-only-password','admin');
  const heavy=store.addUser('مشترك الاختبار الكبير','member@wasl.example','benchmark-only-password','member',20000);
  const encoded=(store.db.prepare('SELECT password_hash FROM users WHERE id=?').get(heavy.id) as {password_hash:string}).password_hash;
  const insertUser=store.db.prepare('INSERT INTO users(id,name,email,password_hash,role,active,balance,created_at) VALUES(?,?,?,?,?,?,?,?)');
  const insertSearch=store.db.prepare('INSERT INTO searches(id,user_id,request_id,filters,title,requested,delivered,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)');
  const insertContact=store.db.prepare('INSERT INTO contacts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const insertLedger=store.db.prepare('INSERT INTO ledger VALUES(?,?,?,?,?,?,?,?)');
  const insertExport=store.db.prepare('INSERT INTO exports VALUES(?,?,?,?)');
  const insertInvite=store.db.prepare('INSERT INTO invitations VALUES(?,?,?,?,?,?,?,?)');
  const insertAudit=store.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?)');
  const memberIds=[heavy.id];
  let contactCount=0,searchCount=0,exportCount=0;
  store.transaction(()=>{
    store.db.prepare('UPDATE users SET created_at=?').run(created);
    for(let m=0;m<1000;m++) {
      const uid=m===0?heavy.id:randomUUID();
      if(m>0) {
        memberIds.push(uid);
        insertUser.run(uid,'مشترك اختبار '+m,`bench-${m}@example.com`,encoded,'member',m%5===0?0:1,20000,created);
        insertLedger.run(randomUUID(),uid,20000,'grant','رصيد اختبار','initial:'+uid,20000,created);
      }
      const count=m===0?10000:90+(m<=90?1:0);
      let searchId='';
      for(let c=0;c<count;c++) {
        const time=new Date(Date.parse(created)-(c%30)*86400000).toISOString();
        if(c%50===0) {
          searchId=randomUUID(); const requested=Math.min(50,count-c);
          const filters={sector:'التقنية والبرمجيات',country:'السعودية',city:'',title:'',size:'all',count:requested,confirmed:true,requestId:randomUUID()};
          insertSearch.run(searchId,uid,filters.requestId,JSON.stringify(filters),'بحث اختبار '+m+' / '+c,requested,requested,'completed',time);
          searchCount++;
        }
        const cid=randomUUID(),d=demoCatalog[c%demoCatalog.length];
        insertContact.run(cid,uid,searchId,`جهة اختبار ${m}-${c}`,`bench-${m}-${c}@example.com`,d.company,d.title,d.sector,d.country,d.city,d.website,d.size,d.source,d.email_status,time);
        insertLedger.run(randomUUID(),uid,-1,'debit','تسليم اختبار','delivery:'+cid,20000-c-1,time);
        contactCount++;
      }
      store.db.prepare('UPDATE users SET balance=? WHERE id=?').run(20000-count,uid);
      for(let e=0;e<(m===0?150:1);e++) {insertExport.run(randomUUID(),uid,10,created);exportCount++;}
      insertInvite.run(randomUUID(),'fixture-token-'+m,'دعوة اختبار '+m,`invite-${m}@example.com`,100,'2026-09-26T12:00:00.000Z',null,created);
      for(let a=0;a<2;a++) insertAudit.run(randomUUID(),owner.id,'إجراء اختبار','بيانات وهمية '+m,created);
    }
  });
  return {ownerId:owner.id,heavyId:heavy.id,otherMemberId:memberIds[1],members:1000,contacts:contactCount,searches:searchCount,exports:exportCount,heavyContacts:10000,heavySearches:200,heavyExports:150,activeMembers:801,created};
}
