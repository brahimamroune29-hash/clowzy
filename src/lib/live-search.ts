import type { Search, SearchInput } from './contracts';
import { Store } from './store';
import { BATCH, fetchCap, IcypeasClient, IcypeasError, type Lead, leadName, peopleQuery, personKey, STAGES, submitCap } from './icypeas';

type Run = { search_id: string; phase: string; people: string; file: string | null; scanned: number; submitted: number; submitted_at: number | null; message: string; updated_at: number };
type Slots = { read: number; bulk: number };
// ponytail: process-wide spacing for Icypeas account limits (results read 30/min, bulk submit 1/s); fine for one server process, move to shared storage if we scale out.
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
  private run(id: string) { return this.store.db.prepare('SELECT * FROM provider_runs WHERE search_id=?').get(id) as Run | undefined; }
  private patch(id: string, fields: Partial<Run>) {
    const keys = Object.keys(fields);
    this.store.db.prepare(`UPDATE provider_runs SET ${[...keys.map(k => k + '=?'), 'updated_at=?'].join(',')} WHERE search_id=?`).run(...keys.map(k => fields[k as keyof Run] ?? null), Date.now(), id);
  }
  private view(userId: string, id: string): Search {
    const search = this.store.getSearch(userId, id), run = this.run(id);
    return { ...search, message: run?.message || (search.status === 'awaiting_provider' ? 'جارٍ البحث والتحقق من الإيميلات.' : '') };
  }
  private stop(id: string, message: string, uncertain = false) {
    this.store.transaction(() => {
      this.patch(id, { phase: uncertain ? 'unknown' : 'failed', message });
      this.store.db.prepare("UPDATE searches SET status=? WHERE id=? AND status='awaiting_provider'").run(uncertain ? 'unknown' : 'failed', id);
      this.store.db.prepare('DELETE FROM reservations WHERE search_id=?').run(id);
    });
  }
  private finish(userId: string, id: string, message = '') {
    this.store.finishSearch(id);
    this.patch(id, { phase: 'finished', message });
    return this.view(userId, id);
  }
  private async page(input: SearchInput, token: string | null, stage: number) {
    try { return await this.client.people(input, token, stage); }
    catch (e) { if (token && e instanceof IcypeasError && e.rejected) return this.client.people(input, null, stage); throw e; } // only a refused (expired) token restarts the stage
  }
  // Called only by the request that owns the 'searching' phase (start, or the poll that won the 'delivering' claim).
  private async advance(userId: string, id: string, input: SearchInput): Promise<Search> {
    const picked: string[] = [];
    try {
      const search = this.store.getSearch(userId, id), run = this.run(id)!, queryKey = JSON.stringify(peopleQuery(input));
      const want = Math.min(BATCH, submitCap(search.requested) - run.submitted, Math.ceil((search.requested - search.delivered) / EXPECTED_FIND_RATE));
      const cursor = this.store.cursor(userId, queryKey), batch: Lead[] = [];
      let pool = JSON.parse(cursor.leftovers) as Lead[], token = cursor.token, stage = cursor.stage, wrapped = false, scanned = run.scanned;
      while (want > 0 && batch.length < want) {
        if (!pool.length) {
          if (scanned >= fetchCap(search.requested) || wrapped) break;
          const page = await this.page(input, token, stage);
          scanned += page.returned; pool = page.leads; token = page.token;
          if (!token || !page.returned) { // stage done: next stage, or back to the top on the next search
            token = null; stage = (stage + 1) % STAGES; wrapped = stage === 0;
            if (wrapped) scanned = Math.max(scanned, fetchCap(search.requested)); // this search has seen everything: no further batches
          }
        }
        while (pool.length && batch.length < want) {
          const lead = pool.shift()!, key = personKey(lead);
          // Marked seen at once so an overlapping search by the same member cannot pick the same person.
          if (!this.store.isKnownPerson(userId, key, leadName(lead), lead.lastCompanyName || '')) { this.store.markSeen(userId, key); picked.push(key); batch.push(lead); }
        }
        this.store.saveCursor(userId, queryKey, stage, token, JSON.stringify(pool));
        this.patch(id, { scanned });
      }
      if (!batch.length) return this.finish(userId, id, search.delivered < search.requested ? 'لا يوجد أشخاص جدد مطابقون لهذه المعايير حاليًا.' : '');
      this.patch(id, { phase: 'submitting', people: JSON.stringify(batch) });
      while (!takeSlot(this.slots, 'bulk', this.gaps.bulk)) { this.patch(id, {}); await sleep(this.gaps.bulk); }
      if (this.store.getSearch(userId, id).status !== 'awaiting_provider' || this.run(id)?.phase !== 'submitting') { this.store.unmarkSeen(userId, picked); return this.view(userId, id); }
      const file = await this.client.submit(batch, `clowzy-${id}-${run.submitted}`);
      this.store.db.prepare("UPDATE provider_runs SET phase='waiting',file=?,submitted=submitted+?,submitted_at=?,message='',updated_at=? WHERE search_id=?").run(file, batch.length, Date.now(), Date.now(), id);
      return this.view(userId, id);
    } catch (e) {
      const error = e instanceof IcypeasError ? e : new IcypeasError('تعذّر حفظ نتيجة الطلب. لن نعيد الإرسال تلقائيًا.', 502, true);
      if (!error.uncertain) this.store.unmarkSeen(userId, picked); // nothing reached the provider: available again once the cursor wraps
      if (this.store.getSearch(userId, id).delivered > 0) return this.finish(userId, id, error.message);
      this.stop(id, error.message, error.uncertain);
      return this.view(userId, id);
    }
  }
  async start(userId: string, input: SearchInput): Promise<Search> {
    peopleQuery(input); // Validate filters before reserving credits or contacting the provider.
    // Close this member's abandoned or interrupted searches first, so they do not hold credits or pending slots.
    const stale = this.store.db.prepare(`SELECT r.search_id FROM provider_runs r JOIN searches s ON s.id=r.search_id WHERE s.user_id=? AND s.status='awaiting_provider'
      AND ((r.phase='waiting' AND r.submitted_at<?) OR (r.phase<>'waiting' AND r.updated_at<?))`).all(userId, Date.now() - BATCH_DEADLINE, Date.now() - STALE) as { search_id: string }[];
    for (const { search_id } of stale) await this.poll(userId, search_id);
    const search = this.store.enqueueSearch(userId, input);
    if (this.run(search.id) || search.status !== 'queued') return this.poll(userId, search.id);
    this.store.transaction(() => {
      this.store.db.prepare("INSERT INTO provider_runs(search_id,phase,updated_at) VALUES(?,'searching',?)").run(search.id, Date.now());
      this.store.db.prepare("UPDATE searches SET status='awaiting_provider' WHERE id=?").run(search.id);
    });
    return this.advance(userId, search.id, input);
  }
  async poll(userId: string, id: string): Promise<Search> {
    const search = this.store.getSearch(userId, id), run = this.run(id);
    if (!run || search.status !== 'awaiting_provider') return this.view(userId, id);
    if (run.phase !== 'waiting') {
      // An interrupted request: nothing was submitted while 'searching'/'delivering'; 'submitting' may have reached the provider.
      if (Date.now() - run.updated_at > STALE) {
        if (run.phase !== 'submitting') return this.finish(userId, id, 'توقف البحث قبل إكماله. حُسب فقط ما وصل.');
        this.stop(id, 'توقف إرسال الطلب قبل تأكيده. لم يُخصم كريدت من المنصة لما لم يصل.', true);
      }
      return this.view(userId, id);
    }
    if (!run.file || Date.now() - run.updated_at < 5000 || !takeSlot(this.slots, 'read', this.gaps.read)) return this.view(userId, id);
    // Read-only polling may safely resume after an interruption; the row lock spaces out concurrent readers.
    const locked = this.store.db.prepare('UPDATE provider_runs SET updated_at=? WHERE search_id=? AND updated_at=?').run(Date.now(), id, run.updated_at);
    if (!locked.changes) return this.view(userId, id);
    const input = JSON.parse(search.filters) as SearchInput, expired = Date.now() - (run.submitted_at ?? run.updated_at) > BATCH_DEADLINE;
    try {
      const result = await this.client.results(run.file, JSON.parse(run.people) as Lead[]);
      if (!result.done && !expired) { this.patch(id, { message: 'نبحث عن الإيميلات ونتحقق منها. يمكنك العودة لاحقًا من سجل البحث.' }); return this.view(userId, id); }
      // Exactly one request may deliver this batch and start the next one.
      const claim = this.store.db.prepare("UPDATE provider_runs SET phase='delivering',updated_at=? WHERE search_id=? AND phase='waiting' AND file=?").run(Date.now(), id, run.file);
      if (!claim.changes) return this.view(userId, id);
      const delivered = this.store.deliverBatch(userId, id, result.candidates.map(c => ({ ...c, sector: input.sector })));
      const current = this.run(id)!;
      if (delivered < search.requested && current.submitted < submitCap(search.requested) && current.scanned < fetchCap(search.requested)) {
        this.patch(id, { phase: 'searching', file: null });
        return this.advance(userId, id, input);
      }
      return this.finish(userId, id);
    } catch (e) {
      if (expired) return this.finish(userId, id, 'تعذّر إكمال قراءة النتائج من مزوّد البيانات. حُسب فقط ما وصل.');
      this.patch(id, { message: e instanceof IcypeasError ? e.message : 'تعذّر تحديث الحالة. سنحاول مجددًا؛ لن نعيد إرسال الطلب.' });
      return this.view(userId, id);
    }
  }
}
