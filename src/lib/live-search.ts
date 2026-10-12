import { DEFAULT_SIZE, MIN_FIND_RATE, POLL_MS, type Candidate, type Resolved, type Search } from './contracts';
import { catalogMatches, crmEnabled, rememberCandidates } from './catalog';
import { audienceOf } from './audience';
import { judgeLeads } from './ai';
import { WEB_ROUNDS } from './web-companies';
import {recordCoverage} from './coverage';
import { setTimeout as sleep } from 'node:timers/promises';
import { AppError, dailyPeople, dailyLimit, Store } from './store';
import { ARAB, countryLabel, farther, nearby } from './places';
import { BATCH, companyKeys, cursorKey, fetchCap, IcypeasClient, IcypeasError, type Lead, leadKeys, leadName, missKey, personKey, publishedEnabled, queryOf, siteOf, stageCount, submissionTask, submitCap, webStage, withinSize } from './icypeas';

type Run = { search_id: string; phase: string; people: string; file: string | null; scanned: number; fetched: number; submitted: number; submitted_at: number | null; message: string; updated_at: number; read_errors: number; mode: 'companies' | null; people_checked: number; scope: number; stop_requested: number | null };
// Where a search looks, in order: the member's place, then (widen) the whole country when a city was set, then the region's
// other countries one by one (client 2026-10-05: «يوسّع… ولا مرة بدي يكون ناقص»; owner: the place only, the same region, on by default),
// then the other regions, nearest first (tier 1, 2, 3; owner 2026-10-07: every niche falls short somewhere).
// ponytail: since 2026-10-11 every new search is stored with widen: false (route.ts), so only searches started before then can widen.
// Once none of those is open, delete together: the places past the first here, regionOf, widenedTo, the region moves in end(), the
// widen field (schemas.ts) and its override (route.ts), the «from widening» tag (member-views.tsx) and tests/widen.test.ts.
const placesOf = (input: Resolved) => [{ countries: input.countries, city: input.city, tier: 0 }, ...!input.widen ? []
  : [...input.city ? [{ countries: input.countries, city: '', tier: 0 }] : [], ...nearby(input.countries).map(cc => ({ countries: [cc], city: '', tier: 0 })),
    ...farther(input.countries).map((countries, i) => ({ countries, city: '', tier: i + 1 }))]];
// The first and last place of a place's region: a region's people, then its businesses' own emails, come before the next region.
const regionOf = (input: Resolved, scope: number) => {
  const tiers = placesOf(input).map(p => p.tier);
  return { first: tiers.indexOf(tiers[scope]), last: tiers.lastIndexOf(tiers[scope]), total: tiers.length };
};
// The audience a run continues with: the stored filters at the place it has reached, switched to companies once a people search fell back.
const inputOf = (filters: string, run?: Pick<Run, 'mode' | 'scope'>): Resolved => {
  const input = audienceOf(filters), { countries, city } = placesOf(input)[run?.scope ?? 0];
  return { ...input, countries, city, ...(run?.mode ? { mode: run.mode } : {}) };
};
// The places a search has widened to: in a companies phase, every place of its region (that region's people came first).
const widenedTo = (input: Resolved, run: Pick<Run, 'mode' | 'scope'>) => placesOf(input).slice(1, (run.mode ? regionOf(input, run.scope).last : run.scope) + 1);
type Slots = { read: number; bulk: number };
const BATCH_DEADLINE = 15 * 60000; // a batch that never fully returns is closed with what came back
// A stopped search waits this long for the batch already at the provider (median 9 s, longest seen 32 s), then closes with what came.
// Counted from the stop, or from the submit when the batch went out after it. Past it, three failed reads in a row close the batch
// with what came (one failed read must not throw away emails that are ready).
const STOP_WAIT = 30000, STOP_READ_ERRORS = 3;
const STOPPING = 'جارٍ إيقاف البحث: نسلّم ما وصل من الإيميلات ثم نغلقه.', STOPPED = 'أُوقف البحث قبل اكتماله. حُسب فقط ما وصل.';
const READ_ERRORS = 10; // a batch past its deadline is closed on read errors only after this many in a row
const STALE = 90000; // no request lives this long (maxDuration 60 s): a run untouched for 90 s was interrupted
// One request's share of a search (the function is killed at 60 s): at most 3 paid pages and 20 s collecting people, and
// no paid submit after 25 s (a submit can take ~31 s: a 10.5 s connect timeout, then one 20 s retry). Past that the search
// pauses with its picked people saved, and the next poll resumes it.
const PAGES_PER_CALL = 3, COLLECT_MS = 20000, SUBMIT_MS = 25000;
// The AI judge (judge below) answers within 8 s and by 50 s into the request: a page fetched late (a slow or retried provider call)
// goes unjudged rather than past the kill at 60 s, counted as a judge failure.
const JUDGE_MS = 8000, JUDGE_BY = 50000;
// Batch sizing: until a batch of this mode has come back, an optimistic 30% find rate (measured ~20-23% on GCC samples,
// outputs/gulf-email-provider-research-2026-09-26.md) keeps the first paid batch small. After that, the rate this search measured
// (floored at 5%): restaurants in Saudi Arabia found 10 in 185 (5.4%), and assuming 30% took 13 small batches (2026-10-05).
// ponytail: a rate measured low can over-find by up to a 100-person batch; those extra finds cost provider credits and are not
// delivered (owner's choice, 2026-10-05). Cap the batch by the provider balance if that spend starts to matter.
const PRIOR_FIND_RATE = 0.3;
// Owner 2026-10-11 (Q2): past its first 100 people, a people search finding under 3% goes to the companies' own emails in the same place
// now, not after every page of people (salons, Saudi Arabia: 0.6% over 1,016 people was 74% of a 21-minute search).
const EARLY_SWITCH_AFTER = 100, EARLY_SWITCH_BELOW = 0.03;
// ponytail: people without a website wait in the member's list (at most this many per filter set) until no page is left; the rest
// come back when the list starts over.
const LATER_KEPT = 100;
// A website batch reads up to ten sites a round (in parallel, 8 s), and is verified once ten addresses are ready, or nothing more is
// coming (no page left, the daily cap, a paid web round next, or ten companies of the other kind waiting). Owner 2026-10-08: dental
// Lebanon sent 35 company attempts one or two at a time (2026-10-07).
// ponytail: an address found in the first round waits for the later rounds (about 10 s each); add a time limit if that shows.
const SITE_BATCH = 10;

// Search = batches: take people from this member's cursor for these filters (leftovers, then next pages) -> submit
// for email discovery -> read results -> deliver, repeated until the requested count, the submit cap, or no new people.
// Phases: searching (<-> paused) -> submitting -> waiting -> searching ... -> finished. The people picked for the next batch
// are saved with the run as they are picked. Only one request can move a search out of 'waiting' or 'paused' (conditional
// update), and a delivery commits together with leaving 'waiting', so overlapping polls never deliver or submit twice.
// Durable markers prevent refreshes, timeouts or restarts from replaying paid requests. Batches advance through browser polls or the optional search worker.
export class LiveSearch {
  private begun = Date.now(); // one LiveSearch per HTTP request
  // catalog: how long emails another search already found wait before they show, so the page reads as a search (owner, 2026-10-07).
  constructor(private store: Store, private client = new IcypeasClient(), private gaps: { read: number; bulk: number; catalog?: number } = { read: 2100, bulk: 1100, catalog: 15000 }, private slots?: Slots) {}
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
  // Stage times add up on the run: one value per search, no audit row per stage. A measurement: a write that fails is logged and
  // skipped, never a failed (or paid-and-lost) search. Called outside transactions only: a failed update inside one would abort it.
  private async timing(id: string, counts: Record<string, number>) {
    await this.store.db.run(`UPDATE provider_runs SET timing=coalesce(timing,'{}'::jsonb)||(SELECT jsonb_object_agg(k,coalesce((timing->>k)::bigint,0)+v::bigint)
      FROM jsonb_each_text(?::jsonb) e(k,v)) WHERE search_id=?`, JSON.stringify(counts), id).catch(e => console.warn('Stage timing not recorded:', e instanceof Error ? e.message : 'unknown'));
  }
  // The AI judge on each new provider page (ai.ts judgeLeads): off without a key or with AI_JUDGE_ENABLED=false; a failure keeps the page.
  // ponytail: what an unjudged page leaves in the member's list (and picks saved before the deploy) is paid for later unjudged, as before
  // the judge; tag judged leads and judge the untagged ones read back if judgeErrors shows up in the run timing.
  private async judge(id: string, input: Resolved, leads: Lead[]) {
    if (!leads.length || process.env.AI_JUDGE_ENABLED === 'false' || !process.env.OPENROUTER_API_KEY?.trim()) return leads;
    const at = Date.now(), time = Math.min(JUDGE_MS, JUDGE_BY - this.elapsed());
    const drop = await (time < 1000 ? Promise.reject(new Error('no time left')) : judgeLeads({ field: input.sector, industries: input.industries, titles: input.mode === 'companies' ? [] : input.titles, countries: input.countries },
      leads.map(l => ({ title: l.lastJobTitle || undefined, company: l.lastCompanyName || '', industry: l.lastCompanyIndustry || undefined, website: siteOf(l) || undefined })), time))
      .catch(e => { console.warn('AI judge skipped:', e instanceof Error ? e.message : 'unknown'); return null; });
    const kept = drop ? leads.filter((_, i) => !drop.includes(i)) : leads;
    await this.timing(id, { judgeMs: Date.now() - at, judged: drop ? leads.length : 0, dropped: leads.length - kept.length, judgeErrors: drop ? 0 : 1 });
    return kept;
  }
  private run(id: string) { return this.store.db.get<Run>('SELECT * FROM provider_runs WHERE search_id=?', id); }
  private async patch(id: string, fields: Partial<Run>) {
    const keys = Object.keys(fields);
    await this.store.db.run(`UPDATE provider_runs SET ${[...keys.map(k => k + '=?'), 'updated_at=?'].join(',')} WHERE search_id=?`, ...keys.map(k => fields[k as keyof Run] ?? null), Date.now(), id);
  }
  private async view(userId: string, id: string): Promise<Search> {
    const search = await this.store.getSearch(userId, id), run = await this.run(id);
    // checked: people (and companies) sent for email discovery so far, the live progress the results page shows while searching.
    return { ...search, checked: (run?.people_checked ?? 0) + (run?.submitted ?? 0), ...(run?.mode ? { companiesChecked: run.submitted } : {}),
      ...(run && widenedTo(audienceOf(search.filters), run).length ? { widenedTo: widenedTo(audienceOf(search.filters), run).flatMap(p => p.countries) } : {}), message: run?.stop_requested && search.status === 'awaiting_provider' ? STOPPING : run?.message || (search.status === 'awaiting_provider' ? 'جارٍ البحث والتحقق من الإيميلات.' : '') };
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
    const input = audienceOf(search.filters), companies = input.mode === 'companies', checked = run.mode ? run.people_checked : run.people_checked + run.submitted;
    const places = widenedTo(input, run), all = places.length && places.length === placesOf(input).length - 1; // every place tried: no city or country to add
    const wide = places.length ? `وسّعنا البحث إلى: ${places.map((p, i) => (i === 0 && input.city ? 'كل ' : '') + p.countries.map(countryLabel).join('، ')).join('، ')}. ` : '';
    // The advice names only the filters this search set (a salons search with none was told to remove three, 2026-10-05).
    const set = [input.size !== DEFAULT_SIZE && 'حد حجم الشركة', !all && input.city.trim() && 'المدينة', !companies && input.title.length > 0 && 'المسمى الوظيفي'].filter(Boolean);
    const widen = all ? (set.length ? `لنتائج أكثر، وسّع المعايير: احذف ${set.join(' أو ')}.` : 'لنتائج أكثر، اختر نشاطًا أوسع.')
      : set.length ? `لنتائج أكثر، وسّع المعايير: احذف ${set.join(' أو ')} أو أضف دولًا.` : 'لنتائج أكثر، أضف دولًا أو اختر نشاطًا أوسع.';
    if (run.mode && run.submitted) return wide + `بحثنا عن بريد ${run.people_checked} من الأشخاص المطابقين، ثم أجرينا ${run.submitted} عملية بحث عن بريد الشركات نفسها، فوصلك ${search.delivered} من ${search.requested}. `
      + widen; // a fallback that found no company email reads as the people search
    if (!checked) return wide + (companies ? 'لم نجد شركات جديدة مطابقة لها نطاق عمل صالح للبحث حاليًا. ' : 'لا يوجد أشخاص جدد مطابقون لهذه المعايير حاليًا. ') + widen;
    // The list the advice is about: the member's own kind (people, or companies) at the last place it was searched in.
    const cursor = await this.store.cursor(userId, cursorKey(inputOf(search.filters, { mode: null, scope: run.mode ? regionOf(input, run.scope).last : run.scope })));
    const found = search.delivered + search.duplicates, dup = search.duplicates ? `، منها ${search.duplicates} مكرر مستبعد` : '';
    // One company can have domain discovery followed by publication verification: attempts are not unique companies.
    return wide + (companies ? `نفّذنا ${checked} محاولة للعثور على بريد الشركات المطابقة والتحقق منه، فوصلك ${search.delivered} من ${search.requested}. `
      : `بحثنا عن بريد ${checked} من الأشخاص المطابقين، ${found ? `ووجدنا بريدًا موثّقًا لـ ${found} منهم${dup}` : 'ولم نجد بريدًا موثّقًا لأيّ منهم'}. `)
      + (!cursor.stage && !cursor.token && cursor.leftovers === '[]' ? (webStage(input, stageCount(input) - 1) ? 'انتهت جولات البحث المتاحة لهذا الطلب. ' : 'جرّبنا كل المطابقين المتاحين. ') + widen : run.mode && checked >= EARLY_SWITCH_AFTER && found < checked * EARLY_SWITCH_BELOW ? widen // the people left after an early switch: under 3%, not worth another round
        : `أعد البحث بالمعايير نفسها لتجربة ${companies ? 'شركات أخرى' : 'أشخاص آخرين'}، أو وسّعها لنتائج أكثر.`);
  }
  // Colleagues held back for a company this search delivered would open the next search with the same filters: they leave the
  // member's lists (the people one and the companies fallback's). Never claimed, so they come back once a list starts over.
  private async dropHeld(userId: string, search: Search) {
    const taken = await this.store.takenCompanies(search.id), input = audienceOf(search.filters);
    if (taken.size) await this.store.transaction(async () => {
      for (const mode of ['people', 'companies'] as const) for (const { countries, city } of placesOf(input)) {
        const key = cursorKey({ ...input, countries, city, mode }), c = await this.store.cursor(userId, key), left = JSON.parse(c.leftovers) as Lead[];
        const kept = left.filter(l => !leadKeys(l).some(k => taken.has(k)));
        if (kept.length < left.length) await this.store.saveCursor(userId, key, c.stage, c.token, JSON.stringify(kept));
      }
    });
  }
  private async finish(userId: string, id: string, message = '') {
    await this.store.finishSearch(id); // 'stopped' when a stop was asked (store.ts)
    const search = await this.store.getSearch(userId, id);
    // Best effort: the search is already closed and released; a failure only leaves the page's generic text (or the colleagues).
    await this.dropHeld(userId, search).catch(e => console.warn('Held colleagues kept:', e instanceof Error ? e.message : 'unknown'));
    const run = (await this.run(id))!;
    if (!message && search.delivered < search.requested) message = run.stop_requested ? STOPPED : await this.shortfall(userId, search, run)
      .catch(e => { console.warn('Shortfall message skipped:', e instanceof Error ? e.message : 'unknown'); return ''; });
    await this.patch(id, { phase: 'finished', message });
    return this.view(userId, id);
  }
  // The natural end of a search's place (no more people, or the attempts cap). Short of its count, it moves to the next place of
  // its region (placesOf), with a page budget of its own; the region's people come before any company's own email (owner, 2026-10-05).
  // Then a people search falls back to the companies' own verified emails (owner's rule, 2026-10-01), from the region's first place
  // again; then the next region starts over with its people.
  private async end(userId: string, id: string, input: Resolved, closeOnly = false) {
    if (!closeOnly) {
      const search = await this.store.getSearch(userId, id), run = (await this.run(id))!, short = search.delivered < search.requested;
      if (run.stop_requested) return this.finish(userId, id); // stopped: no wider place, no companies' fallback
      const region = regionOf(audienceOf(search.filters), run.scope);
      // A place of people gets its own attempts too (a capped first place must not skip the rest); their total is people_checked.
      if (short && run.scope < region.last) {
        if (await this.store.db.run(`UPDATE provider_runs SET scope=scope+1,scanned=0,people='[]',updated_at=?${run.mode ? '' : ',people_checked=people_checked+submitted,submitted=0'}
          WHERE search_id=? AND scope=? AND COALESCE(mode,'')=?`, Date.now(), id, run.scope, run.mode ?? ''))
          return this.advance(userId, id, inputOf(search.filters, { mode: run.mode, scope: run.scope + 1 }));
        return this.view(userId, id); // another request moved it on
      }
      if (short && input.mode === 'people' && await this.store.db.run(
        "UPDATE provider_runs SET mode='companies',scope=?,people_checked=people_checked+submitted,scanned=0,submitted=0,people='[]',updated_at=? WHERE search_id=? AND mode IS NULL AND scope=?", region.first, Date.now(), id, run.scope))
        return this.advance(userId, id, inputOf(search.filters, { mode: 'companies', scope: region.first }));
      // ponytail: an earlier region's company attempts leave the counters here (they are not people); the end message then counts
      // only the last region's. Add a column of their own if the owner wants the total.
      if (short && region.last + 1 < region.total) {
        if (await this.store.db.run(`UPDATE provider_runs SET mode=NULL,scope=?,people_checked=people_checked+CASE WHEN mode IS NULL THEN submitted ELSE 0 END,scanned=0,submitted=0,people='[]',updated_at=?
          WHERE search_id=? AND scope=? AND COALESCE(mode,'')=?`, region.last + 1, Date.now(), id, run.scope, run.mode ?? ''))
          return this.advance(userId, id, inputOf(search.filters, { mode: null, scope: region.last + 1 }));
        return this.view(userId, id); // another request moved it on
      }
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
      batch = (JSON.parse(run.people) as Lead[]).filter(l => !l.suppressed && withinSize(input, l)); // a pick from before 2026-10-11 has no ceiling // picked (and claimed) by an earlier request of this search, not sent yet
      if (run.stop_requested) { // the picked people go back to the member's list; closing the search clears them from the run
        await this.release(userId, queryKey, batch);
        return this.finish(userId, id);
      }
      if (input.mode === 'companies') batch = batch.map(l => ({ ...l, kind: 'company', email: l.published ? l.email : '' }));
      // The rate counts what the provider found: the fallback its own attempts (submitted restarts at 0) and emails (company rows),
      // never emails the saved catalog delivered before any batch (2 catalog emails in 7 people read as a 29% rate).
      const contacts = await this.store.db.all<Candidate & { catalog: boolean }>("SELECT kind,website,email,company,EXISTS(SELECT 1 FROM crm_deliveries d WHERE d.contact_id=c.id AND d.origin='catalog') catalog FROM contacts c WHERE search_id=?", id);
      // People count people: a later region's people come after an earlier region's company emails.
      // ponytail: the fallback counts the company emails of earlier regions too, so a later region's fallback starts with smaller
      // batches (slower, never wrong); keep a per-region baseline if that wait shows.
      const found = contacts.filter(c => !c.catalog && (run.mode ? c.kind === 'company' : input.mode === 'companies' || c.kind !== 'company')).length + (run.mode ? 0 : search.duplicates); // a duplicate was found too
      const tried = run.mode ? run.submitted : run.people_checked + run.submitted; // people: every place so far
      const rate = tried ? Math.max(MIN_FIND_RATE, found / tried) : PRIOR_FIND_RATE;
      if (!run.mode && input.mode === 'people' && !input.widen && tried >= EARLY_SWITCH_AFTER && found / tried < EARLY_SWITCH_BELOW) { // an older widening search keeps its course
        await this.release(userId, queryKey, batch); // picked, not sent: back to the member's list
        return this.end(userId, id, input);
      }
      const most = Math.min(BATCH, submitCap(search.requested) - run.submitted), want = Math.min(most, Math.ceil((search.requested - search.delivered) / rate));
      // One email per company in a search: a colleague of someone delivered or already in this batch waits in the member's list
      // (held), and is tried in a later batch only if that company still has no email. People whose company has no website rarely
      // have a findable email (0 of 200 salon people, 0 of 227 dental people): they wait (later) until no other page is left.
      const taken = new Set([...contacts.flatMap(companyKeys), ...batch.flatMap(leadKeys)]);
      // aside: a different kind of check than this batch's (a company this member already tried comes back for its website):
      // it opens the next batch instead of cutting this one short.
      const held: Lead[] = [], later: Lead[] = [], aside: Lead[] = [];
      const cursor = await this.store.cursor(userId, queryKey);
      let pool = (JSON.parse(cursor.leftovers) as Lead[]).filter(l => !l.suppressed), token = cursor.token, stage = cursor.stage, wrapped = false, daily = false, scanned = run.scanned, fetched = run.fetched, pages = 0, noMore = false;
      const exhausted = () => scanned >= fetchCap(search.requested) || wrapped || daily;
      // A batch is full at `want` paid checks. A website batch counts its addresses only (reading a site is free) and also stops at
      // ten sites to read, or when its sites could fill the search's cap of paid checks (`most`): its verification can then exceed
      // `want` by up to nine addresses (over-finding the owner accepted, D4), never the cap.
      const full = () => {
        const toRead = batch[0]?.published ? batch.filter(l => l.publicationPending).length : 0;
        return batch.length - toRead >= want || toRead >= SITE_BATCH || batch.length >= most;
      };
      while (want > 0 && !full()) {
        if (!pool.length && exhausted() && later.length) pool = later.splice(0);
        if (!pool.length) {
          if (exhausted()) { noMore = true; break; }
          // Ten of the other kind wait: this batch goes now rather than buying pages that rarely bring its kind.
          if (batch.length && aside.length >= SITE_BATCH) { noMore = true; break; }
          if (pages >= PAGES_PER_CALL || this.elapsed() > COLLECT_MS) return this.pause(userId, id, batch, input);
          if (await this.store.dailyFetched(userId) >= dailyPeople()) { // the member's daily provider work: send who was picked, then stop
            if (later.length) { daily = true; continue; } // no page is left today: the people without a website go now
            if (batch.length) { noMore = true; break; }
            return this.finish(userId, id, 'حُسب فقط ما وصل. ' + dailyLimit);
          }
          if (webStage(input, stage)) {
            if (batch.length) { noMore = true; break; } // verify what we have before paying for another web page
            // Web discovery and classification together have a 42 s ceiling. Start them in a fresh request,
            // persist the result, then pause before any paid email submission if the submit window has passed.
            if (this.elapsed() > 5000) return this.pause(userId, id, batch, input);
            // A web cap ends this place's pages, not the search: the next place or region still has its provider pages (dental
            // Lebanon ended at 8 of 10 on the per-search cap, 2026-10-07).
            try {
              await this.store.hit('web-search:' + id, WEB_ROUNDS, 86400000);
              await this.store.hit('web-day:' + userId, 12, 86400000);
            } catch (e) { if (!(e instanceof AppError)) throw e; wrapped = true; continue; }
          }
          if ((await this.run(id))?.stop_requested) return this.pause(userId, id, batch, input); // no paid page after a stop: the next advance closes it
          pages++;
          const pageAt = Date.now(), page = await this.page(input, token, stage);
          await this.timing(id, { pageMs: Date.now() - pageAt, pages: 1 });
          scanned += page.returned; fetched += page.returned; pool = await this.judge(id, input, page.leads); token = page.token;
          if (!token || (!page.returned && !webStage(input, stage))) { // an empty web round can still have another search engine to try
            token = null; stage = (stage + 1) % stageCount(input); wrapped = stage === 0;
            if (wrapped) scanned = Math.max(scanned, fetchCap(search.requested)); // this search has seen everything: no further pages
          }
        }
        // Claimed at once (an overlapping search by the same member cannot pick the same person), and recorded with the run
        // and the cursor in the same transaction, so an interruption never leaves a person claimed but unrecorded.
        // No email there for any member within 30 days: not paid for again. Read outside the claim (a failure only skips nothing).
        const missed = await this.store.recentMisses(pool.map(missKey)).catch(() => new Set<string>());
        await this.store.transaction(async () => {
          while (pool.length && !full()) {
            if (batch.length && submissionTask(pool[0]) !== submissionTask(batch[0])) {
              // A company this member already tried joins a website batch as a website check (never claimed again for a domain
              // search: another search may release that claim meanwhile). Any other kind opens the next batch.
              // ponytail: one lookup per set-aside company per request, inside the claim transaction; batch the lookup if pools grow.
              if (batch[0].published && pool[0].kind === 'company' && publishedEnabled() && await this.store.seen(userId, personKey(pool[0])))
                pool[0] = { ...pool[0], email: '', published: true, publicationPending: true };
              else { aside.push(pool.shift()!); continue; }
            }
            let lead = pool.shift()!;
            if (!withinSize(input, lead)) continue; // left over from before 2026-10-11, when pages had no ceiling
            if (missed.has(missKey(lead))) { // nothing there for anyone within 30 days; a company still has its website (as below)
              if (lead.kind !== 'company' || lead.published || !publishedEnabled()) continue;
              lead = { ...lead, email: '', published: true, publicationPending: true };
              if (batch.length && submissionTask(lead) !== submissionTask(batch[0])) { aside.push(lead); continue; }
            }
            const keys = leadKeys(lead);
            if (keys.some(k => taken.has(k))) { held.push(lead); continue; }
            if (lead.kind !== 'company' && !siteOf(lead) && !exhausted()) { later.push(lead); continue; }
            let claimed = await this.store.claimPerson(userId, personKey(lead), leadName(lead), lead.lastCompanyName || '', lead.kind === 'company' ? siteOf(lead) : '');
            if (!claimed && lead.kind === 'company' && !lead.published && publishedEnabled()) {
              lead = { ...lead, email: '', published: true, publicationPending: true };
              if (batch.length && submissionTask(lead) !== submissionTask(batch[0])) { aside.push(lead); continue; }
              claimed = await this.store.claimPerson(userId, personKey(lead), leadName(lead), lead.lastCompanyName || '', siteOf(lead));
            }
            if (claimed) { batch.push(lead); keys.forEach(k => taken.add(k)); }
          }
          await this.store.saveCursor(userId, queryKey, stage, token, JSON.stringify([...aside, ...pool, ...held, ...later.slice(0, LATER_KEPT)]));
          await this.patch(id, { scanned, fetched, people: JSON.stringify(batch) });
        });
      }
      if (!batch.length) return this.end(userId, id, input);
      if (batch[0].published) {
        if(this.elapsed()>8000&&batch.some(l=>l.publicationPending))return this.pause(userId,id,batch,input);
        const pending=new Set(batch.filter(l=>l.publicationPending).map(siteOf));
        // Websites any search read within 30 days are not read again; a shared read that fails only means reading the site now.
        const known=await this.store.siteReads([...pending]).catch(()=>new Map<string,string[]>());
        const {leads:prepared,read}=await this.client.published(batch,known);
        await this.store.rememberSiteReads(read).catch(e=>console.warn('Website reads not shared:',e instanceof Error?e.message:'unknown'));
        await this.store.transaction(async()=>{
          batch=[];
          for(const lead of prepared)if(!pending.has(siteOf(lead))||await this.store.claimPerson(userId,personKey(lead),leadName(lead),lead.lastCompanyName||'',siteOf(lead)))batch.push(lead);
          await this.patch(id,{people:JSON.stringify(batch)});
          if(pending.size){
            const sites=prepared.filter(l=>pending.has(siteOf(l)));
            await recordCoverage(this.store,userId,id,'site',{companies:pending.size,withEmail:sites.length,queued:batch.filter(l=>pending.has(siteOf(l))).length,addresses:sites.reduce((n,l)=>n+1+(l.alternateEmails?.length||0),0)});
          }
        });
        // Too few addresses while pages remain: they wait, saved with the run, and the next request reads more websites.
        if (!batch.length || (batch.length < Math.min(want, SITE_BATCH) && !noMore)) return this.pause(userId, id, batch, input);
      }
      while (!await this.takeSlot('bulk')) {
        if (this.elapsed() + this.gaps.bulk > SUBMIT_MS) return this.pause(userId, id, batch, input);
        await this.patch(id, {}); await sleep(this.gaps.bulk);
      }
      if (this.elapsed() > SUBMIT_MS) return this.pause(userId, id, batch, input); // checked once the slot is ours: the submit starts now
      await this.patch(id, { phase: 'submitting', people: JSON.stringify(batch) });
      // The run is read last: a stop that lands after this read meets a batch already on its way, delivered like any batch at the provider.
      const open = (await this.store.getSearch(userId, id)).status === 'awaiting_provider', before = await this.run(id);
      if (!open || before?.phase !== 'submitting' || before.stop_requested) {
        await this.release(userId, queryKey, batch);
        return before?.phase === 'submitting' && before.stop_requested ? this.finish(userId, id) : this.view(userId, id);
      }
      sent = true;
      const submitAt = Date.now(), file = await this.client.submit(batch, `clowzy-${id}-${run.people_checked + run.submitted}`); // unique across the fallback's reset
      try {
        await this.store.db.run("UPDATE provider_runs SET phase='waiting',file=?,submitted=submitted+?,submitted_at=?,message='',updated_at=? WHERE search_id=?", file, batch.length, Date.now(), Date.now(), id);
      } catch (e) { console.error('Paid Icypeas batch not saved; reconcile by hand:', { search: id, file }); throw e; }
      await this.timing(id, { submitMs: Date.now() - submitAt, submits: 1 });
      return this.view(userId, id);
    } catch (e) {
      const error = e instanceof IcypeasError ? e : !sent && e instanceof AppError ? new IcypeasError(e.message, e.status) : sent ? new IcypeasError('تعذّر حفظ نتيجة الطلب. لن نعيد الإرسال تلقائيًا.', 502, true)
        : new IcypeasError('تعذّر إكمال البحث الآن. حاول مجددًا بعد قليل.', 503);
      if (!error.uncertain) await this.release(userId, queryKey, batch); // nothing reached the provider: offered again first
      // With emails delivered, or in the companies fallback (the people part ended normally), the search closes with what came.
      const now = await this.run(id);
      if ((await this.store.getSearch(userId, id)).delivered > 0 || now?.mode || (!error.uncertain && now?.stop_requested)) { await this.store.alert(userId, id, error.message); return this.finish(userId, id, error.message); }
      await this.stop(userId, id, error.message, error.uncertain);
      return this.view(userId, id);
    }
  }
  // Client 2026-10-11: the member stops their own search, the owner any search; someone else's reads as missing, not forbidden.
  // Nothing new is sent after it; a batch at the provider is delivered (owner's choice) and then the search closes 'stopped'.
  async requestStop(actorId: string, id: string): Promise<Search> {
    const actor = await this.store.user(actorId), search = await this.store.db.get<{ user_id: string }>('SELECT user_id FROM searches WHERE id=?', id);
    if (!search || (search.user_id !== actorId && actor.role !== 'admin')) throw new AppError('البحث غير موجود.', 404);
    await this.store.db.run(`UPDATE provider_runs SET stop_requested=? WHERE search_id=? AND stop_requested IS NULL
      AND EXISTS (SELECT 1 FROM searches WHERE id=? AND status='awaiting_provider')`, Date.now(), id, id);
    return this.poll(search.user_id, id);
  }
  async recoverStale(userId: string) {
    // With a background worker, leaving the page does not abandon the authorized target. Resume it;
    // capacity checks will keep a second search from interrupting it. Legacy browser-only mode closes abandoned work.
    const stale = await this.store.db.all<{ search_id: string }>(`SELECT r.search_id FROM provider_runs r JOIN searches s ON s.id=r.search_id WHERE s.user_id=? AND s.status='awaiting_provider'
      AND ((r.phase='waiting' AND r.submitted_at<?) OR (r.phase<>'waiting' AND r.updated_at<?) OR (r.stop_requested IS NOT NULL AND GREATEST(r.stop_requested, coalesce(r.submitted_at, 0))<?))`, userId, Date.now() - BATCH_DEADLINE, Date.now() - STALE, Date.now() - STOP_WAIT); // a stopped one past its wait too: its member may have left
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
      // Emails another search already found are held with the run until submitted_at, then delivered by a poll and charged as usual.
      // ponytail: the 'catalog' phase keeps Candidates in people and its reveal time in submitted_at (no migration, owner 2026-10-07);
      // both are reset when it ends. Give it columns of its own if another phase ever needs them at the same time.
      const cached = await catalogMatches(this.store, userId, input, input.count);
      if (cached.length) await this.patch(search.id, { phase: 'catalog', people: JSON.stringify(cached), submitted_at: Date.now() + (this.gaps.catalog ?? 0) });
      return { search: await this.store.getSearch(userId, search.id), claimed: !cached.length };
    });
    return claimed ? this.advance(userId, search.id, input) : this.poll(userId, search.id);
  }
  // closeOnly: deliver what came back, then finish instead of paying for another batch (abandoned searches).
  async poll(userId: string, id: string, closeOnly = false): Promise<Search> {
    const search = await this.store.getSearch(userId, id), run = await this.run(id);
    if (!run || search.status !== 'awaiting_provider') return this.view(userId, id);
    const stale = Date.now() - run.updated_at > STALE, input = inputOf(search.filters, run);
    if (run.phase === 'catalog') {
      if (!run.stop_requested && Date.now() < (run.submitted_at ?? 0)) return this.view(userId, id);
      const delivered = await this.store.transaction(async () => {
        if (!await this.store.db.run("UPDATE provider_runs SET phase='searching',people='[]',submitted_at=NULL,updated_at=? WHERE search_id=? AND phase='catalog'", Date.now(), id)) return null;
        return this.store.deliverBatch(userId, id, (JSON.parse(run.people) as Candidate[]).map(c => ({ ...c, sector: input.sector })), 'catalog');
      });
      if (delivered === null) return this.view(userId, id); // another poll delivered them, or the search closed
      return delivered >= search.requested || closeOnly ? this.finish(userId, id) : this.advance(userId, id, input);
    }
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
    // Reads of a waiting batch are spaced just under one poll apart (owner 2026-10-08: 5 s, with polls every 6 s, before).
    if (!run.file || Date.now() - run.updated_at < POLL_MS - 500) return this.view(userId, id);
    if (this.elapsed() > COLLECT_MS) return this.view(userId, id); // a read can take 31 s: none starts late in a worker tick (60 s limit)
    while (!await this.takeSlot('read')) {
      if (this.elapsed() + this.gaps.read > 10000) return this.view(userId, id);
      await sleep(this.gaps.read);
    }
    // Read-only polling may safely resume after an interruption; the row lock spaces out concurrent readers.
    const locked = await this.store.db.run('UPDATE provider_runs SET updated_at=? WHERE search_id=? AND updated_at=?', Date.now(), id, run.updated_at);
    if (!locked) return this.view(userId, id);
    const age = Date.now() - (run.submitted_at ?? run.updated_at), people = JSON.parse(run.people) as Lead[];
    const stopDue = !!run.stop_requested && Date.now() - Math.max(run.stop_requested, run.submitted_at ?? 0) > STOP_WAIT; // past it, what came is delivered
    try {
      const readAt = Date.now(), result = await this.client.results(run.file, people).finally(() => this.timing(id, { readMs: Date.now() - readAt, reads: 1 }));
      if (!result.done && age <= BATCH_DEADLINE && !stopDue) { await this.patch(id, { read_errors: 0, message: 'نبحث عن الإيميلات ونتحقق منها. يمكنك العودة لاحقًا من سجل البحث.' }); return this.view(userId, id); }
      // Exactly one request delivers this batch, and only while the search is open: the claim, the delivery and the move
      // to the next phase commit together, so an interrupted delivery leaves the batch 'waiting' for the next poll.
      let deliverMs = 0;
      const delivered = await this.store.transaction(async () => {
        if (await this.store.db.run(`UPDATE provider_runs SET phase='searching',file=NULL,people='[]',updated_at=? WHERE search_id=? AND phase='waiting' AND file=?
          AND EXISTS (SELECT 1 FROM searches WHERE id=? AND status='awaiting_provider')`, Date.now(), id, run.file, id) !== 1) return null;
        // A batch sent before 2026-10-11 had no ceiling: what is known to be above it is not delivered (nor charged).
        const fit = result.candidates.filter(c => !/^\d+$/.test(c.size) || Number(c.size) <= Number(input.size));
        await rememberCandidates(this.store, fit, input.sector, input.countries.every(c => ARAB.includes(c))); // see peopleQuery
        const deliverAt = Date.now(), delivered = await this.store.deliverBatch(userId, id, fit.map(c => ({ ...c, sector: input.sector })));
        deliverMs = Date.now() - deliverAt;
        if(delivered!==null&&result.coverage)await recordCoverage(this.store,userId,id,'verification',{...result.coverage,waitMs:age}); // how long the provider took
        if (delivered !== null) await this.release(userId, cursorKey(input), result.unpaid); // rows the provider could not pay for were never searched
        if (!closeOnly && !result.unpaid.length && delivered !== null && delivered < search.requested && result.missing.length) {
          const c = await this.store.cursor(userId, cursorKey(input));
          await this.store.saveCursor(userId, cursorKey(input), c.stage, c.token, JSON.stringify([...JSON.parse(c.leftovers), ...result.missing]));
        }
        return delivered;
      });
      if (delivered === null) return this.view(userId, id);
      await this.timing(id, { deliverMs });
      await this.store.rememberMisses(result.misses.map(missKey)).catch(e => console.warn('No-email answers not shared:', e instanceof Error ? e.message : 'unknown'));
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
      if ((stopDue && run.read_errors + 1 >= STOP_READ_ERRORS) || (age > BATCH_DEADLINE && run.read_errors + 1 >= READ_ERRORS)) { await this.closeExpired(userId, id, run.file, 'تعذّر إكمال قراءة النتائج من مزوّد البيانات. حُسب فقط ما وصل.'); return this.view(userId, id); }
      await this.patch(id, { read_errors: run.read_errors + 1, message: e instanceof IcypeasError ? e.message : 'تعذّر تحديث الحالة. سنحاول مجددًا؛ لن نعيد إرسال الطلب.' });
      return this.view(userId, id);
    }
  }
}
