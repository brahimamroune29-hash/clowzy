import type { Search, SearchInput } from './contracts';
import { AppError, Store } from './store';
import { FullEnrichClient, FullEnrichError, type Person, searchBody } from './fullenrich';

type Run={search_id:string;phase:string;people:string;enrichment_id:string|null;message:string;updated_at:number};
// Durable submission markers prevent refreshes, timeouts, or restarts from replaying paid POSTs.
// This local trial advances enrichment by explicit polling, without a background worker/webhook.
export class LiveSearch {
  constructor(private store:Store,private client=new FullEnrichClient()) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS fullenrich_runs (
      search_id TEXT PRIMARY KEY REFERENCES searches(id), phase TEXT NOT NULL, people TEXT NOT NULL DEFAULT '[]',
      enrichment_id TEXT, message TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL
    )`);
  }
  private run(id:string){return this.store.db.prepare('SELECT * FROM fullenrich_runs WHERE search_id=?').get(id) as Run|undefined;}
  private view(userId:string,id:string):Search {
    const search=this.store.getSearch(userId,id),run=this.run(id);
    return {...search,message:run?.message || (search.status==='awaiting_provider'?'جارٍ البحث والتحقق من الإيميلات لدى FullEnrich.':'')};
  }
  private stop(id:string,message:string,uncertain=false){
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.store.db.prepare('UPDATE fullenrich_runs SET phase=?,message=?,updated_at=? WHERE search_id=?').run(uncertain?'unknown':'failed',message,Date.now(),id);
      this.store.db.prepare('UPDATE searches SET status=? WHERE id=?').run(uncertain?'unknown':'failed',id);
      this.store.db.prepare('DELETE FROM reservations WHERE search_id=?').run(id);
      this.store.db.exec('COMMIT');
    }catch(e){this.store.db.exec('ROLLBACK');throw e;}
  }
  private async finish(userId:string,id:string,candidates:Awaited<ReturnType<FullEnrichClient['result']>>['candidates']){
    if(this.store.getSearch(userId,id).status!=='awaiting_provider')return this.view(userId,id);
    // Claim synchronously before yielding; the existing delivery transaction owns dedupe + debit.
    this.store.db.prepare("UPDATE searches SET status='queued' WHERE id=? AND status='awaiting_provider'").run(id);
    const claim=this.store.claimJob(id);
    if(claim)await this.store.executeJob(claim,{name:'FullEnrich',search:()=>candidates},false);
    this.store.db.prepare("UPDATE fullenrich_runs SET phase='finished',message='',updated_at=? WHERE search_id=?").run(Date.now(),id);
    return this.view(userId,id);
  }
  async start(userId:string,input:SearchInput):Promise<Search>{
    if(input.count>10)throw new AppError('حد تجربة FullEnrich هو 10 أشخاص لكل بحث.');
    searchBody(input); // Validate filters before reserving credits or contacting the provider.
    const search=this.store.enqueueSearch(userId,input);
    if(this.run(search.id) || search.status!=='queued')return this.poll(userId,search.id);
    this.store.db.exec('BEGIN IMMEDIATE');
    try{
      this.store.db.prepare("INSERT INTO fullenrich_runs(search_id,phase,updated_at) VALUES(?,'searching',?)").run(search.id,Date.now());
      this.store.db.prepare("UPDATE searches SET status='awaiting_provider' WHERE id=?").run(search.id);
      this.store.db.exec('COMMIT');
    }catch(e){this.store.db.exec('ROLLBACK');throw e;}
    try{
      const people=await this.client.search(input);
      if(!people.length)return await this.finish(userId,search.id,[]);
      this.store.db.prepare("UPDATE fullenrich_runs SET phase='submitting',people=?,updated_at=? WHERE search_id=?").run(JSON.stringify(people),Date.now(),search.id);
      const enrichmentId=await this.client.enrich(people,'clowzy-'+search.id);
      this.store.db.prepare("UPDATE fullenrich_runs SET phase='waiting',enrichment_id=?,updated_at=? WHERE search_id=?").run(enrichmentId,Date.now(),search.id);
      return this.view(userId,search.id);
    }catch(e){
      const error=e instanceof FullEnrichError?e:new FullEnrichError('تعذّر حفظ نتيجة الطلب. راجع سجل FullEnrich قبل بحث جديد.',true);
      this.stop(search.id,error.message,error.uncertain);
      return this.view(userId,search.id);
    }
  }
  async poll(userId:string,id:string):Promise<Search>{
    const search=this.store.getSearch(userId,id),run=this.run(id);
    if(!run || search.status!=='awaiting_provider')return this.view(userId,id);
    if(['searching','submitting'].includes(run.phase)){
      if(Date.now()-run.updated_at>90000)this.stop(id,'توقفت متابعة إرسال الطلب. راجع FullEnrich قبل بحث جديد؛ قد يكون الطلب احتُسب هناك.',true);
      return this.view(userId,id);
    }
    if(!run.enrichment_id || Date.now()-run.updated_at<5000)return this.view(userId,id);
    // Read-only provider polling may safely resume after browser/server interruption.
    const locked=this.store.db.prepare('UPDATE fullenrich_runs SET updated_at=? WHERE search_id=? AND updated_at=?').run(Date.now(),id,run.updated_at);
    if(!locked.changes)return this.view(userId,id);
    try{
      const result=await this.client.result(run.enrichment_id,JSON.parse(run.people) as Person[]);
      if(result.status==='FINISHED')return await this.finish(userId,id,result.candidates);
      if(['CANCELED','CREDITS_INSUFFICIENT'].includes(result.status)){
        this.stop(id,result.status==='CREDITS_INSUFFICIENT'?'رصيد FullEnrich غير كافٍ لإكمال الطلب.':'أُلغي الطلب لدى FullEnrich.');
      }else this.store.db.prepare('UPDATE fullenrich_runs SET message=? WHERE search_id=?').run('FullEnrich يعالج الطلب. يمكنك العودة إلى سجل البحث ومتابعته لاحقًا.',id);
    }catch(e){
      this.store.db.prepare('UPDATE fullenrich_runs SET message=? WHERE search_id=?').run(e instanceof FullEnrichError?e.message:'تعذّر تحديث الحالة. أعد المتابعة لاحقًا؛ لن نعيد إرسال الطلب.',id);
    }
    return this.view(userId,id);
  }
}
