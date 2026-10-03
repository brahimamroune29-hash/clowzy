import type { Resolved, Search } from './contracts';
import { catalogMatches, crmEnabled, rememberCandidates } from './catalog';
import { audienceOf } from './audience';
import { WEB_ROUNDS } from './web-companies';
import {recordCoverage} from './coverage';
import { setTimeout as sleep } from 'node:timers/promises';
import { AppError, DAILY_PEOPLE, dailyLimit, Store } from './store';
import { BATCH, cursorKey, fetchCap, IcypeasClient, IcypeasError, type Lead, leadName, personKey, publishedEnabled, queryOf, siteOf, stageCount, submissionTask, submitCap, webStage } from './icypeas';

type Run = { search_id: string; phase: string; people: string; file: string | null; scanned: number; fetched: number; submitted: number; submitted_at: number | null; message: string; updated_at: number; read_errors: number; mode: 'companies' | null; people_checked: number };
// The audience a run continues with: the stored filters, switched to companies once a people search has fallen back.
const inputOf = (filters: string, run?: Pick<Run, 'mode'>): Resolved => ({ ...audienceOf(filters), ...(run?.mode ? { mode: run.mode } : {}) });
type Slots = { read: number; bulk: number };
const BATCH_DEADLINE = 15 * 60000; // a batch that never fully returns is closed with what came back
const READ_ERRORS = 10; // a batch past its deadline is closed on read errors only after this many in a row
const STALE = 90000; // no request lives this long (maxDuration 60 s): a run untouched for 90 s was interrupted
// One request's share of a search (the function is killed at 60 s): at most 3 paid pages and 20 s collecting people, and
// no paid submit after 25 s (a submit can take ~31 s: a 10.5 s connect timeout, then one 20 s retry). Past that the search
// pauses with its picked people saved, and the next poll resumes it.
const PAGES_PER_CALL = 3, COLLECT_MS = 20000, SUBMIT_MS = 25000;
// Batch sizing assumes an optimistic 30% find rate (measured ~20-23% on GCC samples, outputs/gulf-email-provider-research-2026-09-26.md):
// smaller first batches mean fewer found-but-undelivered emails paid for; later batches top up within the submit cap.
// Native company-domain discovery also needs topping up; no assumption that a public site email is deliverable.
const EXPECTED_FIND_RATE = { people: 0.3, companies: 0.3 };

// Search = batches: take people from this member's cursor for these filters (leftovers, then next pages) -> submit
// for email discovery -> read results -> deliver, repeated until the requested count, the submit cap, or no new people.
// Phases: searching (<-> paused) -> submitting -> waiting -> searching ... -> finished. The people picked for the next batch
// are saved with the run as they are picked. Only one request can move a search out of 'waiting' or 'paused' (conditional
// update), and a delivery commits together with leaving 'waiting', so overlapping polls never deliver or submit twice.
// Durable markers prevent refreshes, timeouts or restarts from replaying paid requests. Batches advance through browser polls or the optional search worker.
export class LiveSearch {
  private begun = Date.now(); // one LiveSearch per HTTP request
  constructor(private store: Store, private client = new IcypeasClient(), private gaps = { read: 2100, bulk: 1100 }, private slots?: Slots) {}
  private async takeSlot(kind: keyof Slots) {
    const gap = this.gaps[kind], now = Date.now();
    if (!gap) return true;
    if (this.slots) { // isolated clocks in provider failure tests
      if (now - this.slots[kind] < gap) return false;
      this.slots[kind] = now; return true;
    }
    return await this.store.db.run(`INSERT INTO provider_slots(kind,available_at) VALUES(?,?)
      ON CONFLICT(kind) DO UPDATE SET available_at=excluded.available_at WHERE provider_slots.available_at<=?`, kind, now + gap, now) === 1;
  }
  private elapsed() { return Date.now() - this.begun; }
  private run(id: string) { return this.store.db.get<Run>('SELECT * FROM provider_runs WHERE search_id=?', id); }
  private async patch(id: string, fields: Partial<Run>) {
    const keys = Object.keys(fields);
    await this.store.db.run(`UPDATE provider_runs SET ${[...keys.map(k => k + '=?'), 'updated_at=?'].join(',')} WHERE search_id=?`, ...keys.map(k => fields[k as keyof Run] ?? null), Date.now(), id);
  }
  private async view(userId: string, id: string): Promise<Search> {
    const search = await this.store.getSearch(userId, id), run = await this.run(id);
    // checked: people sent for email discovery so far (the live progress the results page shows while searching).
    return { ...search, checked: (run?.people_checked ?? 0) + (run?.submitted ?? 0), message: run?.message || (search.status === 'awaiting_provider' ? 'جارٍ البحث والتحقق من الإيميلات.' : '') };
  }
  private stop(userId: string, id: string, message: string, uncertain = false) {
    return this.store.transaction(async () => {
      await this.patch(id, { phase: uncertain ? 'unknown' : 'failed', message });
      // Only the request that closes the search alerts the owner (two tabs may both get here).
      if (await this.store.db.run("UPDATE searches SET status=? WHERE id=? AND status='awaiting_provider'", uncertain ? 'unknown' : 'failed', id)) {
        await this.store.alert(userId, id, message);
        await this.store.notifySearch(id, message);
      }
      await this.store.db.run('DELETE FROM reservations WHERE search_id=?', id);
    });
  }
  // Why a search ended short and what to do next, so an empty result never reads as a silent failure.
  private async shortfall(userId: string, search: Search, run: Run) {
    const input = audienceOf(search.filters), companies = input.mode === 'companies', checked = run.mode ? run.people_checked : run.submitted;
    if (run.mode && run.submitted) return `بحثنا عن بريد ${run.people_checked} من الأشخاص المطابقين، ثم حاولنا استكمال العدد ببريد الشركات عبر ${run.submitted} محاولة فحص، فوصلك ${search.delivered} من ${search.requested}. `
      + 'لنتائج أكثر، وسّع المعايير: احذف حجم الشركة أو المدينة أو المسمى الوظيفي.'; // a fallback that found no company email reads as the people search
    const widen = companies ? 'لنتائج أكثر، وسّع المعايير: احذف حجم الشركة أو المدينة أو أضف دولًا.' : 'لنتائج أكثر، وسّع المعايير: احذف حجم الشركة أو المدينة أو المسمى الوظيفي.';
    if (!checked) return (companies ? 'لم نجد شركات جديدة مطابقة لها نطاق عمل صالح للبحث حاليًا. ' : 'لا يوجد أشخاص جدد مطابقون لهذه المعايير حاليًا. ') + widen;
    const cursor = await this.store.cursor(userId, cursorKey(input));
    const found = search.delivered + search.duplicates, dup = search.duplicates ? `، منها ${search.duplicates} مكرر مستبعد` : '';
    // One company can have domain discovery followed by publication verification: attempts are not unique companies.
    return (companies ? `نفّذنا ${checked} محاولة للعثور على بريد الشركات المطابقة والتحقق منه، فوصلك ${search.delivered} من ${search.requested}. `
      : `بحثنا عن بريد ${checked} من الأشخاص المطابقين، ${found ? `ووجدنا بريدًا موثّقًا لـ ${found} منهم${dup}` : 'ولم نجد بريدًا موثّقًا لأيّ منهم'}. `)
      + (!cursor.stage && !cursor.token && cursor.leftovers === '[]' ? (webStage(input, stageCount(input) - 1) ? 'انتهت جولات البحث المتاحة لهذا الطلب. ' : 'جرّبنا كل المطابقين المتاحين. ') + widen : `أعد البحث بالمعايير نفسها لتجربة ${companies ? 'شركات أخرى' : 'أشخاص آخرين'}، أو وسّعها لنتائج أكثر.`);
  }
  private async finish(userId: string, id: string, message = '') {
    await this.store.finishSearch(id);
    if (!message) {
      const search = await this.store.getSearch(userId, id);
      // Best effort: the search is already closed and released; a failed read only leaves the page's generic text.
      if (search.delivered < search.requested) message = await this.shortfall(userId, search, (await this.run(id))!)
        .catch(e => { console.warn('Shortfall message skipped:', e instanceof Error ? e.message : 'unknown'); return ''; });
    }
    await this.patch(id, { phase: 'finished', message });
    return this.view(userId, id);
  }
  // The natural end of a search (no more people, or the attempts cap). A people search short of its count falls back, once, to
  // the companies' own verified emails for the same filters (owner's rule, 2026-10-01), labelled «إيميل الشركة» for the member.
  private async end(userId: string, id: string, input: Resolved, closeOnly = false) {
    if (!closeOnly && input.mode === 'people') {
      const search = await this.store.getSearch(userId, id);
      if (search.delivered < search.requested && await this.store.db.run(
        "UPDATE provider_runs SET mode='companies',people_checked=submitted,scanned=0,submitted=0,people='[]',updated_at=? WHERE search_id=? AND mode IS NULL", Date.now(), id))
        return this.advance(userId, id, { ...input, mode: 'companies' });
    }
    return this.finish(userId, id);
  }
  // A batch past its deadline is closed with what was delivered, through the same claim as a delivery: if another
  // request is delivering it (or already closed it), that request decides.
  private closeExpired(userId: string, id: string, file: string, message: string) {
    return this.store.transaction(async () => {
      if (!await this.store.db.run("UPDATE provider_runs SET phase='finished',message=?,updated_at=? WHERE search_id=? AND phase='waiting' AND file=?", message, Date.now(), id, file)) return;
      await this.store.alert(userId, id, 'تعذّرت قراءة نتائج دفعة مدفوعة؛ راجع حساب المزوّد.');
      await this.store.finishSearch(id);
    });
  }
  private async page(input: Resolved, token: string | null, stage: number) {
    const fetch = (t: string | null) => input.mode === 'companies' ? this.client.companies(input, t, stage) : this.client.people(input, t, stage);
    try { return await fetch(token); }
    catch (e) { if (token && e instanceof IcypeasError && e.rejected) return fetch(null); throw e; } // only a refused (expired) token restarts the stage
  }
  // People picked but never sent (a clean failure, an abandoned search): released, and put back at the front of the member's list.
  private async release(userId: string, queryKey: string, leads: Lead[]) {
    if (!leads.length) return;
    const keys = new Set(leads.map(personKey));
    await this.store.transaction(async () => {
      await this.store.unmarkSeen(userId, [...keys]);
      const c = await this.store.cursor(userId, queryKey), rest = (JSON.parse(c.leftovers) as Lead[]).filter(l => !keys.has(personKey(l)));
      await this.store.saveCursor(userId, queryKey, c.stage, c.token, JSON.stringify([...leads, ...rest]));
    });
  }
  private async pause(userId: string, id: string, batch: Lead[], input: Resolved) {
    await this.patch(id, { phase: 'paused', people: JSON.stringify(batch), message: input.mode === 'companies' ? 'نواصل البحث عن بريد الشركات المطابقة…' : 'نواصل البحث عن أشخاص مطابقين…' });
    return this.view(userId, id);
  }
  // Called only by the request that owns the 'searching' phase (start, the poll that delivered, or the poll that resumed it).
  private async advance(userId: string, id: string, input: Resolved): Promise<Search> {
    const queryKey = cursorKey(input);
    let batch: Lead[] = [], sent = false; // from the paid submit on, a failure may mean the provider has the batch (and charged for it)
    try {
      const search = await this.store.getSearch(userId, id), run = (await this.run(id))!;
      batch = (JSON.parse(run.people) as Lead[]).filter(l => !l.suppressed); // picked (and claimed) by an earlier request of this search, not sent yet
      if (input.mode === 'companies') batch = batch.map(l => ({ ...l, kind: 'company', email: l.published ? l.email : '' }));
      const want = Math.min(BATCH, submitCap(search.requested) - run.submitted, Math.ceil((search.requested - search.delivered) / EXPECTED_FIND_RATE[input.mode]));
      const cursor = await this.store.cursor(userId, queryKey);
      let pool = (JSON.parse(cursor.leftovers) as Lead[]).filter(l => !l.suppressed), token = cursor.token, stage = cursor.stage, wrapped = false, scanned = run.scanned, fetched = run.fetched, pages = 0;
      while (want > 0 && batch.length < want) {
        if (!pool.length) {
          if (scanned >= fetchCap(search.requested) || wrapped) break;
          if (pages >= PAGES_PER_CALL || this.elapsed() > COLLECT_MS) return this.pause(userId, id, batch, input);
          if (await this.store.dailyFetched(userId) >= DAILY_PEOPLE) { // the member's daily provider work: send who was picked, then stop
            if (batch.length) break;
            return this.finish(userId, id, 'حُسب فقط ما وصل. ' + dailyLimit);
          }
          if (webStage(input, stage)) {
            if (batch.length) break; // verify what we have before paying for another web page
            // Web discovery and classification together have a 42 s ceiling. Start them in a fresh request,
            // persist the result, then pause before any paid email submission if the submit window has passed.
            if (this.elapsed() > 5000) return this.pause(userId, id, batch, input);
            await this.store.hit('web-search:' + id, WEB_ROUNDS, 86400000, 'بلغ البحث حد اكتشاف المواقع. حُفظت النتائج المتاحة.');
            await this.store.hit('web-day:' + userId, 12, 86400000, 'بلغت حد اكتشاف المواقع اليومي. حُفظت النتائج المتاحة.');
          }
          pages++;
          const page = await this.page(input, token, stage);
          scanned += page.returned; fetched += page.returned; pool = page.leads; token = page.token;
          if (!token || (!page.returned && !webStage(input, stage))) { // an empty web round can still have another search engine to try
            token = null; stage = (stage + 1) % stageCount(input); wrapped = stage === 0;
            if (wrapped) scanned = Math.max(scanned, fetchCap(search.requested)); // this search has seen everything: no further pages
          }
        }
        // Claimed at once (an overlapping search by the same member cannot pick the same person), and recorded with the run
        // and the cursor in the same transaction, so an interruption never leaves a person claimed but unrecorded.
        await this.store.transaction(async () => {
          while (pool.length && batch.length < want) {
            if (batch.length && (submissionTask(pool[0]) !== submissionTask(batch[0]) || (batch[0].published && batch.length >= 3))) break;
            let lead = pool.shift()!;
            let claimed = await this.store.claimPerson(userId, personKey(lead), leadName(lead), lead.lastCompanyName || '', lead.kind === 'company' ? siteOf(lead) : '');
            if (!claimed && lead.kind === 'company' && !lead.published && publishedEnabled()) {
              lead = { ...lead, email: '', published: true, publicationPending: true };
              if (batch.length && submissionTask(lead) !== submissionTask(batch[0])) { pool.unshift(lead); break; }
              claimed = await this.store.claimPerson(userId, personKey(lead), leadName(lead), lead.lastCompanyName || '', siteOf(lead));
            }
            if (claimed) batch.push(lead);
          }
          await this.store.saveCursor(userId, queryKey, stage, token, JSON.stringify(pool));
          await this.patch(id, { scanned, fetched, people: JSON.stringify(batch) });
        });
        if (batch.length && (batch[0].published || (pool.length && submissionTask(pool[0]) !== submissionTask(batch[0])))) break;
      }
      if (!batch.length) return this.end(userId, id, input);
      if (batch[0].published) {
        if(this.elapsed()>8000&&batch.some(l=>l.publicationPending))return this.pause(userId,id,batch,input);
        const pending=new Set(batch.filter(l=>l.publicationPending).map(siteOf));
        const prepared=await this.client.published(batch);
        await this.store.transaction(async()=>{
          batch=[];
          for(const lead of prepared)if(!pending.has(siteOf(lead))||await this.store.claimPerson(userId,personKey(lead),leadName(lead),lead.lastCompanyName||'',siteOf(lead)))batch.push(lead);
          await this.patch(id,{people:JSON.stringify(batch)});
          if(pending.size){
            const sites=prepared.filter(l=>pending.has(siteOf(l)));
            await recordCoverage(this.store,userId,id,'site',{companies:pending.size,withEmail:sites.length,queued:batch.filter(l=>pending.has(siteOf(l))).length,addresses:sites.reduce((n,l)=>n+1+(l.alternateEmails?.length||0),0)});
          }
        });
        if (!batch.length) return this.pause(userId, id, [], input);
      }
      while (!await this.takeSlot('bulk')) {
        if (this.elapsed() + this.gaps.bulk > SUBMIT_MS) return this.pause(userId, id, batch, input);
        await this.patch(id, {}); await sleep(this.gaps.bulk);
      }
      if (this.elapsed() > SUBMIT_MS) return this.pause(userId, id, batch, input); // checked once the slot is ours: the submit starts now
      await this.patch(id, { phase: 'submitting', people: JSON.stringify(batch) });
      if ((await this.store.getSearch(userId, id)).status !== 'awaiting_provider' || (await this.run(id))?.phase !== 'submitting') { await this.release(userId, queryKey, batch); return this.view(userId, id); }
      sent = true;
      const file = await this.client.submit(batch, `clowzy-${id}-${run.people_checked + run.submitted}`); // unique across the fallback's reset
      try {
        await this.store.db.run("UPDATE provider_runs SET phase='waiting',file=?,submitted=submitted+?,submitted_at=?,message='',updated_at=? WHERE search_id=?", file, batch.length, Date.now(), Date.now(), id);
      } catch (e) { console.error('Paid Icypeas batch not saved; reconcile by hand:', { search: id, file }); throw e; }
      return this.view(userId, id);
    } catch (e) {
      const error = e instanceof IcypeasError ? e : !sent && e instanceof AppError ? new IcypeasError(e.message, e.status) : sent ? new IcypeasError('تعذّر حفظ نتيجة الطلب. لن نعيد الإرسال تلقائيًا.', 502, true)
        : new IcypeasError('تعذّر إكمال البحث الآن. حاول مجددًا بعد قليل.', 503);
      if (!error.uncertain) await this.release(userId, queryKey, batch); // nothing reached the provider: offered again first
      // With emails delivered, or in the companies fallback (the people part ended normally), the search closes with what came.
      if ((await this.store.getSearch(userId, id)).delivered > 0 || (await this.run(id))?.mode) { await this.store.alert(userId, id, error.message); return this.finish(userId, id, error.message); }
      await this.stop(userId, id, error.message, error.uncertain);
      return this.view(userId, id);
    }
  }
  async recoverStale(userId: string) {
    // With a background worker, leaving the page does not abandon the authorized target. Resume it;
    // capacity checks will keep a second search from interrupting it. Legacy browser-only mode closes abandoned work.
    const stale = await this.store.db.all<{ search_id: string }>(`SELECT r.search_id FROM provider_runs r JOIN searches s ON s.id=r.search_id WHERE s.user_id=? AND s.status='awaiting_provider'
      AND ((r.phase='waiting' AND r.submitted_at<?) OR (r.phase<>'waiting' AND r.updated_at<?))`, userId, Date.now() - BATCH_DEADLINE, Date.now() - STALE);
    for (const { search_id } of stale) { if (this.elapsed() > 10000) break; await this.poll(userId, search_id, !crmEnabled()); }
  }
  async start(userId: string, input: Resolved): Promise<Search> {
    queryOf(input);
    await this.recoverStale(userId);
    // Reservation and claim commit together, under the member's row lock (taken by enqueueSearch): a lost connection
    // leaves neither behind, and a repeated request (same request id, e.g. a double click) waits and then only polls.
    const { search, claimed } = await this.store.transaction(async () => {
      const search = await this.store.enqueueSearch(userId, input);
      if (search.status !== 'queued' || !await this.store.db.run("UPDATE searches SET status='awaiting_provider' WHERE id=? AND status='queued'", search.id)) return { search, claimed: false };
      await this.store.db.run("INSERT INTO provider_runs(search_id,phase,updated_at) VALUES(?,'searching',?)", search.id, Date.now());
      const cached = await catalogMatches(this.store, userId, input, input.count);
      if (cached.length) await this.store.deliverBatch(userId, search.id, cached.map(c => ({ ...c, sector: input.sector })), 'catalog');
      const fresh = await this.store.getSearch(userId, search.id);
      if (fresh.delivered >= fresh.requested) {
        await this.store.finishSearch(search.id);
        await this.patch(search.id, { phase: 'finished' });
        return { search: await this.view(userId, search.id), claimed: false };
      }
      return { search: fresh, claimed: true };
    });
    return claimed ? this.advance(userId, search.id, input) : this.poll(userId, search.id);
  }
  // closeOnly: deliver what came back, then finish instead of paying for another batch (abandoned searches).
  async poll(userId: string, id: string, closeOnly = false): Promise<Search> {
    const search = await this.store.getSearch(userId, id), run = await this.run(id);
    if (!run || search.status !== 'awaiting_provider') return this.view(userId, id);
    const stale = Date.now() - run.updated_at > STALE, input = inputOf(search.filters, run);
    // Paused, or interrupted while picking people: nothing was sent, and the picked people are saved with the run.
    if (run.phase === 'paused' || (run.phase === 'searching' && stale)) {
      if (!await this.store.db.run("UPDATE provider_runs SET phase='searching',updated_at=? WHERE search_id=? AND phase=? AND updated_at=?", Date.now(), id, run.phase, run.updated_at)) return this.view(userId, id);
      if (!closeOnly) return this.advance(userId, id, input);
      await this.store.transaction(async () => { await this.release(userId, cursorKey(input), JSON.parse(run.people) as Lead[]); await this.patch(id, { people: '[]' }); });
      return this.finish(userId, id);
    }
    if (run.phase !== 'waiting') {
      // ponytail: runs left in 'delivering' by the pre-2026-09-30 code (claim committed apart from the delivery); delete once none is open.
      if (stale && run.phase === 'delivering') await this.store.db.run("UPDATE provider_runs SET phase='waiting',updated_at=? WHERE search_id=? AND phase='delivering' AND updated_at=?", Date.now(), id, run.updated_at);
      else if (stale && run.phase === 'submitting') { // may have reached the provider: never resent
        if (!await this.store.db.run("UPDATE provider_runs SET phase='finished',updated_at=? WHERE search_id=? AND phase='submitting' AND updated_at=?", Date.now(), id, run.updated_at)) return this.view(userId, id); // another poll handles it
        console.warn('Icypeas submit interrupted; check the provider for this batch:', { search: id, batch: `clowzy-${id}-${run.people_checked + run.submitted}` });
        if (search.delivered > 0) { await this.store.alert(userId, id, 'توقف إرسال دفعة قبل تأكيده؛ راجع حساب المزوّد.'); return this.finish(userId, id, 'توقف إرسال الدفعة الأخيرة قبل تأكيده. حُسب فقط ما وصل.'); }
        await this.stop(userId, id, 'توقف إرسال الطلب قبل تأكيده.', true); // the page adds that nothing was charged
      }
      return this.view(userId, id);
    }
    if (!run.file || Date.now() - run.updated_at < 5000) return this.view(userId, id);
    while (!await this.takeSlot('read')) {
      if (this.elapsed() + this.gaps.read > 10000) return this.view(userId, id);
      await sleep(this.gaps.read);
    }
    // Read-only polling may safely resume after an interruption; the row lock spaces out concurrent readers.
    const locked = await this.store.db.run('UPDATE provider_runs SET updated_at=? WHERE search_id=? AND updated_at=?', Date.now(), id, run.updated_at);
    if (!locked) return this.view(userId, id);
    const age = Date.now() - (run.submitted_at ?? run.updated_at), people = JSON.parse(run.people) as Lead[];
    try {
      const result = await this.client.results(run.file, people);
      if (!result.done && age <= BATCH_DEADLINE) { await this.patch(id, { read_errors: 0, message: 'نبحث عن الإيميلات ونتحقق منها. يمكنك العودة لاحقًا من سجل البحث.' }); return this.view(userId, id); }
      // Exactly one request delivers this batch, and only while the search is open: the claim, the delivery and the move
      // to the next phase commit together, so an interrupted delivery leaves the batch 'waiting' for the next poll.
      const delivered = await this.store.transaction(async () => {
        if (await this.store.db.run(`UPDATE provider_runs SET phase='searching',file=NULL,people='[]',updated_at=? WHERE search_id=? AND phase='waiting' AND file=?
          AND EXISTS (SELECT 1 FROM searches WHERE id=? AND status='awaiting_provider')`, Date.now(), id, run.file, id) !== 1) return null;
        await rememberCandidates(this.store, result.candidates);
        const delivered = await this.store.deliverBatch(userId, id, result.candidates.map(c => ({ ...c, sector: input.sector })));
        if(delivered!==null&&result.coverage)await recordCoverage(this.store,userId,id,'verification',result.coverage);
        if (delivered !== null) await this.release(userId, cursorKey(input), result.unpaid); // rows the provider could not pay for were never searched
        if (!closeOnly && !result.unpaid.length && delivered !== null && delivered < search.requested && result.missing.length) {
          const c = await this.store.cursor(userId, cursorKey(input));
          await this.store.saveCursor(userId, cursorKey(input), c.stage, c.token, JSON.stringify([...JSON.parse(c.leftovers), ...result.missing]));
        }
        return delivered;
      });
      if (delivered === null) return this.view(userId, id);
      if (result.unpaid.length) { // the provider ran out of credit mid-batch: no further batch until it is topped up
        console.warn('Icypeas: insufficient credits for', result.unpaid.length, 'rows; top it up.');
        await this.store.alert(userId, id, 'رصيد مزوّد البيانات نفد أثناء البحث؛ اشحن الرصيد.');
        return this.finish(userId, id, 'رصيد مزوّد البيانات لا يكفي لإكمال البحث الآن. حُسب فقط ما وصل. تواصل مع مالك المنصة.');
      }
      // advance() fetches no page past fetchCap, but still tries people already fetched (the member's leftovers).
      if (!closeOnly && delivered < search.requested && (await this.run(id))!.submitted < submitCap(search.requested)) return this.advance(userId, id, input);
      return this.end(userId, id, input, closeOnly);
    } catch (e) {
      // Reads are repeatable and a failed delivery rolled back whole: the next poll retries. Only a batch past its deadline
      // whose reads keep failing (READ_ERRORS in a row) is closed with what was delivered.
      if (age > BATCH_DEADLINE && run.read_errors + 1 >= READ_ERRORS) { await this.closeExpired(userId, id, run.file, 'تعذّر إكمال قراءة النتائج من مزوّد البيانات. حُسب فقط ما وصل.'); return this.view(userId, id); }
      await this.patch(id, { read_errors: run.read_errors + 1, message: e instanceof IcypeasError ? e.message : 'تعذّر تحديث الحالة. سنحاول مجددًا؛ لن نعيد إرسال الطلب.' });
      return this.view(userId, id);
    }
  }
}
