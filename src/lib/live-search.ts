import type { Search, SearchInput } from './contracts';
import { Store } from './store';
import { BATCH, fetchCap, IcypeasClient, IcypeasError, type Lead, leadName, peopleQuery, personKey, STAGES, submitCap } from './icypeas';

type Run = { search_id: string; phase: string; people: string; file: string | null; scanned: number; submitted: number; submitted_at: number | null; message: string; updated_at: number };
type Slots = { read: number; bulk: number };
// ponytail: process-wide spacing for Icypeas account limits (results read 30/min, bulk submit 1/s); per server instance, move to shared storage if many instances run at once.
const sharedSlots: Slots = { read: 0, bulk: 0 };
function takeSlot(slots: Slots, kind: keyof Slots, gapMs: number) {
  const now = Date.now();
  if (now - slots[kind] < gapMs) return false;
  slots[kind] = now; return true;
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const BATCH_DEADLINE = 15 * 60000; // a batch that never fully returns is closed with what came back
const STALE = 90000;
// Batch sizing assumes an optimistic 30% find rate (measured ~20-23% on GCC samples, outputs/gulf-email-provider-research-2026-09-26.md):
// smaller first batches mean fewer found-but-undelivered emails paid for; later batches top up within the submit cap.
const EXPECTED_FIND_RATE = 0.3;

// Search = batches: take people from this member's cursor for these filters (leftovers, then next pages) -> submit
// for email discovery -> read results -> deliver, repeated until the requested count, the submit cap, or no new people.
// Phases: searching -> submitting -> waiting -> delivering -> searching ... -> finished. Only one request can move a
// search out of 'waiting' (conditional update), so overlapping polls never deliver or submit twice.
// Durable markers prevent refreshes, timeouts or restarts from replaying paid requests. Batches advance by polling (no worker).
export class LiveSearch {
  constructor(private store: Store, private client = new IcypeasClient(), private gaps = { read: 2100, bulk: 1100 }, private slots = sharedSlots) {}
  private run(id: string) { return this.store.db.get<Run>('SELECT * FROM provider_runs WHERE search_id=?', id); }
  private async patch(id: string, fields: Partial<Run>) {
    const keys = Object.keys(fields);
    await this.store.db.run(`UPDATE provider_runs SET ${[...keys.map(k => k + '=?'), 'updated_at=?'].join(',')} WHERE search_id=?`, ...keys.map(k => fields[k as keyof Run] ?? null), Date.now(), id);
  }
  private async view(userId: string, id: string): Promise<Search> {
    const search = await this.store.getSearch(userId, id), run = await this.run(id);
    // checked: people sent for email discovery so far (the live progress the results page shows while searching).
    return { ...search, checked: run?.submitted ?? 0, message: run?.message || (search.status === 'awaiting_provider' ? 'جارٍ البحث والتحقق من الإيميلات.' : '') };
  }
  private stop(id: string, message: string, uncertain = false) {
    return this.store.transaction(async () => {
      await this.patch(id, { phase: uncertain ? 'unknown' : 'failed', message });
      await this.store.db.run("UPDATE searches SET status=? WHERE id=? AND status='awaiting_provider'", uncertain ? 'unknown' : 'failed', id);
      await this.store.db.run('DELETE FROM reservations WHERE search_id=?', id);
    });
  }
  // Why a search ended short and what to do next, so an empty result never reads as a silent failure.
  private async shortfall(userId: string, search: Search, checked: number) {
    const widen = 'لنتائج أكثر، وسّع المعايير: احذف حجم الشركة أو المدينة أو المسمى الوظيفي.';
    if (!checked) return 'لا يوجد أشخاص جدد مطابقون لهذه المعايير حاليًا. ' + widen;
    const cursor = await this.store.cursor(userId, JSON.stringify(peopleQuery(JSON.parse(search.filters) as SearchInput)));
    const found = search.delivered + search.duplicates, dup = search.duplicates ? `، منها ${search.duplicates} مكرر مستبعد` : '';
    return `بحثنا عن بريد ${checked} من الأشخاص المطابقين، ${found ? `ووجدنا بريدًا موثّقًا لـ ${found} منهم${dup}` : 'ولم نجد بريدًا موثّقًا لأيّ منهم'}. `
      + (!cursor.stage && !cursor.token && cursor.leftovers === '[]' ? 'جرّبنا كل المطابقين المتاحين. ' + widen : 'أعد البحث بالمعايير نفسها لتجربة أشخاص آخرين، أو وسّعها لنتائج أكثر.');
  }
  private async finish(userId: string, id: string, message = '') {
    await this.store.finishSearch(id);
    if (!message) {
      const search = await this.store.getSearch(userId, id);
      // Best effort: the search is already closed and released; a failed read only leaves the page's generic text.
      if (search.delivered < search.requested) message = await this.shortfall(userId, search, (await this.run(id))?.submitted ?? 0)
        .catch(e => { console.warn('Shortfall message skipped:', e instanceof Error ? e.message : 'unknown'); return ''; });
    }
    await this.patch(id, { phase: 'finished', message });
    return this.view(userId, id);
  }
  // A batch past its deadline is closed with what was delivered, through the same claim as a delivery: if another
  // request is delivering it (or already closed it), that request decides.
  private closeExpired(id: string, file: string, message: string) {
    return this.store.transaction(async () => {
      if (!await this.store.db.run("UPDATE provider_runs SET phase='finished',message=?,updated_at=? WHERE search_id=? AND phase='waiting' AND file=?", message, Date.now(), id, file)) return;
      await this.store.finishSearch(id);
    });
  }
  private async page(input: SearchInput, token: string | null, stage: number) {
    try { return await this.client.people(input, token, stage); }
    catch (e) { if (token && e instanceof IcypeasError && e.rejected) return this.client.people(input, null, stage); throw e; } // only a refused (expired) token restarts the stage
  }
  // Called only by the request that owns the 'searching' phase (start, or the poll that won the 'delivering' claim).
  private async advance(userId: string, id: string, input: SearchInput): Promise<Search> {
    const picked: string[] = [];
    let sent = false; // from the paid submit on, a failure may mean the provider has the batch (and charged for it)
    try {
      const search = await this.store.getSearch(userId, id), run = (await this.run(id))!, queryKey = JSON.stringify(peopleQuery(input));
      const want = Math.min(BATCH, submitCap(search.requested) - run.submitted, Math.ceil((search.requested - search.delivered) / EXPECTED_FIND_RATE));
      const cursor = await this.store.cursor(userId, queryKey), batch: Lead[] = [];
      let pool = JSON.parse(cursor.leftovers) as Lead[], token = cursor.token, stage = cursor.stage, wrapped = false, scanned = run.scanned;
      while (want > 0 && batch.length < want) {
        if (!pool.length) {
          if (scanned >= fetchCap(search.requested) || wrapped) break;
          const page = await this.page(input, token, stage);
          scanned += page.returned; pool = page.leads; token = page.token;
          if (!token || !page.returned) { // stage done: next stage, or back to the top on the next search
            token = null; stage = (stage + 1) % STAGES; wrapped = stage === 0;
            if (wrapped) scanned = Math.max(scanned, fetchCap(search.requested)); // this search has seen everything: no further pages
          }
        }
        while (pool.length && batch.length < want) {
          const lead = pool.shift()!, key = personKey(lead);
          // Claimed at once so an overlapping search by the same member cannot pick the same person.
          if (await this.store.claimPerson(userId, key, leadName(lead), lead.lastCompanyName || '')) { picked.push(key); batch.push(lead); }
        }
        await this.store.saveCursor(userId, queryKey, stage, token, JSON.stringify(pool));
        await this.patch(id, { scanned });
      }
      if (!batch.length) return this.finish(userId, id);
      await this.patch(id, { phase: 'submitting', people: JSON.stringify(batch) });
      while (!takeSlot(this.slots, 'bulk', this.gaps.bulk)) { await this.patch(id, {}); await sleep(this.gaps.bulk); }
      if ((await this.store.getSearch(userId, id)).status !== 'awaiting_provider' || (await this.run(id))?.phase !== 'submitting') { await this.store.unmarkSeen(userId, picked); return this.view(userId, id); }
      sent = true;
      const file = await this.client.submit(batch, `clowzy-${id}-${run.submitted}`);
      await this.store.db.run("UPDATE provider_runs SET phase='waiting',file=?,submitted=submitted+?,submitted_at=?,message='',updated_at=? WHERE search_id=?", file, batch.length, Date.now(), Date.now(), id);
      return this.view(userId, id);
    } catch (e) {
      const error = e instanceof IcypeasError ? e : sent ? new IcypeasError('تعذّر حفظ نتيجة الطلب. لن نعيد الإرسال تلقائيًا.', 502, true)
        : new IcypeasError('تعذّر إكمال البحث الآن. حاول مجددًا بعد قليل.', 503);
      if (!error.uncertain) await this.store.unmarkSeen(userId, picked); // nothing reached the provider: available again once the cursor wraps
      if ((await this.store.getSearch(userId, id)).delivered > 0) return this.finish(userId, id, error.message);
      await this.stop(id, error.message, error.uncertain);
      return this.view(userId, id);
    }
  }
  async start(userId: string, input: SearchInput): Promise<Search> {
    peopleQuery(input); // Validate filters before reserving credits or contacting the provider.
    // Close this member's abandoned or interrupted searches first, so they do not hold credits or pending slots.
    const stale = await this.store.db.all<{ search_id: string }>(`SELECT r.search_id FROM provider_runs r JOIN searches s ON s.id=r.search_id WHERE s.user_id=? AND s.status='awaiting_provider'
      AND ((r.phase='waiting' AND r.submitted_at<?) OR (r.phase<>'waiting' AND r.updated_at<?))`, userId, Date.now() - BATCH_DEADLINE, Date.now() - STALE);
    for (const { search_id } of stale) await this.poll(userId, search_id, true);
    // Reservation and claim commit together, under the member's row lock (taken by enqueueSearch): a lost connection
    // leaves neither behind, and a repeated request (same request id, e.g. a double click) waits and then only polls.
    const { search, claimed } = await this.store.transaction(async () => {
      const search = await this.store.enqueueSearch(userId, input);
      if (search.status !== 'queued' || !await this.store.db.run("UPDATE searches SET status='awaiting_provider' WHERE id=? AND status='queued'", search.id)) return { search, claimed: false };
      await this.store.db.run("INSERT INTO provider_runs(search_id,phase,updated_at) VALUES(?,'searching',?)", search.id, Date.now());
      return { search, claimed: true };
    });
    return claimed ? this.advance(userId, search.id, input) : this.poll(userId, search.id);
  }
  // closeOnly: deliver what came back, then finish instead of paying for another batch (abandoned searches).
  async poll(userId: string, id: string, closeOnly = false): Promise<Search> {
    const search = await this.store.getSearch(userId, id), run = await this.run(id);
    if (!run || search.status !== 'awaiting_provider') return this.view(userId, id);
    if (run.phase !== 'waiting') {
      // An interrupted request: nothing was submitted while 'searching'/'delivering'; 'submitting' may have reached the provider.
      if (Date.now() - run.updated_at > STALE) {
        if (run.phase !== 'submitting') return this.finish(userId, id, 'توقف البحث قبل إكماله. حُسب فقط ما وصل.');
        await this.stop(id, 'توقف إرسال الطلب قبل تأكيده.', true); // the page adds that nothing was charged
      }
      return this.view(userId, id);
    }
    if (!run.file || Date.now() - run.updated_at < 5000 || !takeSlot(this.slots, 'read', this.gaps.read)) return this.view(userId, id);
    // Read-only polling may safely resume after an interruption; the row lock spaces out concurrent readers.
    const locked = await this.store.db.run('UPDATE provider_runs SET updated_at=? WHERE search_id=? AND updated_at=?', Date.now(), id, run.updated_at);
    if (!locked) return this.view(userId, id);
    const input = JSON.parse(search.filters) as SearchInput, expired = Date.now() - (run.submitted_at ?? run.updated_at) > BATCH_DEADLINE;
    let claimed = false;
    try {
      const result = await this.client.results(run.file, JSON.parse(run.people) as Lead[]);
      if (!result.done && !expired) { await this.patch(id, { message: 'نبحث عن الإيميلات ونتحقق منها. يمكنك العودة لاحقًا من سجل البحث.' }); return this.view(userId, id); }
      // Exactly one request may deliver this batch and start the next one, and only while the search is still open.
      claimed = await this.store.db.run(`UPDATE provider_runs SET phase='delivering',updated_at=? WHERE search_id=? AND phase='waiting' AND file=?
        AND EXISTS (SELECT 1 FROM searches WHERE id=? AND status='awaiting_provider')`, Date.now(), id, run.file, id) === 1;
      if (!claimed) return this.view(userId, id);
      const delivered = await this.store.deliverBatch(userId, id, result.candidates.map(c => ({ ...c, sector: input.sector })));
      claimed = false; // delivered (or the search closed meanwhile): never deliver this batch again
      if (delivered === null) return this.view(userId, id);
      const current = (await this.run(id))!;
      // advance() fetches no page past fetchCap, but still tries people already fetched (the member's leftovers).
      if (!closeOnly && delivered < search.requested && current.submitted < submitCap(search.requested)) {
        await this.patch(id, { phase: 'searching', file: null });
        return this.advance(userId, id, input);
      }
      return this.finish(userId, id);
    } catch (e) {
      // A delivery that failed rolled back as a whole; the results read is repeatable, so a later poll retries it.
      if (claimed) await this.store.db.run("UPDATE provider_runs SET phase='waiting',updated_at=? WHERE search_id=? AND phase='delivering' AND file=?", Date.now(), id, run.file);
      if (expired) { await this.closeExpired(id, run.file, 'تعذّر إكمال قراءة النتائج من مزوّد البيانات. حُسب فقط ما وصل.'); return this.view(userId, id); }
      await this.patch(id, { message: e instanceof IcypeasError ? e.message : 'تعذّر تحديث الحالة. سنحاول مجددًا؛ لن نعيد إرسال الطلب.' });
      return this.view(userId, id);
    }
  }
}
