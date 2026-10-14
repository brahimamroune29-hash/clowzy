import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { audienceOf } from '../src/lib/audience';
import { IcypeasClient, stageCount } from '../src/lib/icypeas';
import { mapsCompanies, mapsEnabled, mapsPlaces } from '../src/lib/google-places';
import { item, live, testStore } from './pg';

// Client 2026-10-14 (owner's answers Q5, Q10-Q12): a local-business search (clinics, restaurants, shops) whose provider list
// runs out goes on with Google Maps, keeping the websites only, and through the country's main cities when no city is set.
process.env.GOOGLE_PLACES_API_KEY = 'maps-test-key';
const search = (o: Record<string, unknown> = {}) => audienceOf(JSON.stringify({ mode: 'companies', sector: 'عيادات الأسنان', countries: ['SA'], city: '', title: '',
  size: 'all', count: 2, widen: false, confirmed: true, requestId: randomUUID(), ...o }));

// The provider has no dental company here; Google has Riyadh's clinics on two pages and nothing elsewhere.
function mock() {
  const google: { body: { textQuery: string; regionCode: string; pageToken?: string }; headers: Headers }[] = [];
  let submitted = 0;
  const transport: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    if (String(url) === 'https://places.googleapis.com/v1/places:searchText') {
      google.push({ body, headers: new Headers(init?.headers) });
      if (body.textQuery === 'Dental clinics in Jeddah, Saudi Arabia') return new Response('down', { status: 503 }); // an outage ends that city only
      if (body.textQuery !== 'Dental clinics in Riyadh, Saudi Arabia') return Response.json({});
      return Response.json(body.pageToken === 'p2' ? { places: [{ displayName: { text: 'Bright Teeth' }, websiteUri: 'https://brightteeth.example/' }] }
        : { places: [{ displayName: { text: 'Smile Dental Clinic' }, websiteUri: 'https://www.smile-dental.example/ar' }, { displayName: { text: 'Riyadh Dental Lab' }, websiteUri: 'https://lab.example' },
          { displayName: { text: 'Insta Clinic' }, websiteUri: 'https://www.instagram.com/insta.clinic' }, { displayName: { text: 'No Site Clinic' } }], nextPageToken: 'p2' });
    }
    const path = String(url).replace('https://app.icypeas.com/api/', '');
    if (path === 'find-companies') return Response.json({ success: true, leads: [] });
    if (path === 'bulk-search') { submitted++; return Response.json({ success: true, file: 'file1' }); }
    if (path === 'bulk-single-searchs/read') return Response.json({ success: true, items: [item(0, 'info@smile-dental.example'), item(1, 'hello@brightteeth.example')] });
    throw Error('Unexpected ' + url);
  };
  return { google, client: new IcypeasClient('unit-test-secret', transport), submitted: () => submitted };
}

test('Google Maps serves local-business company searches only, and only with its key', () => {
  assert.equal(mapsEnabled(search()), true);
  assert.equal(stageCount(search()), 5, 'the four dental provider stages, then the maps');
  assert.equal(mapsEnabled(search({ sector: 'المطاعم' })), true);
  assert.equal(mapsEnabled(search({ sector: 'أطباء الأسنان', industries: ['Dentists'] })), true, 'a provider category that is one local niche\'s');
  assert.equal(mapsEnabled(search({ sector: 'خدمات العناية الشخصية', industries: ['Personal Care Services'] })), false, 'four niches share it: no guess');
  assert.equal(mapsEnabled(search({ mode: 'people' })), false);
  assert.equal(mapsEnabled(search({ sector: 'شركات البرمجيات' })), false, 'not a local business');
  delete process.env.GOOGLE_PLACES_API_KEY;
  try { assert.equal(mapsEnabled(search()), false); } finally { process.env.GOOGLE_PLACES_API_KEY = 'maps-test-key'; }
});

test('without a city the maps go through the country\'s main cities; a chosen city is searched alone', () => {
  const places = (o = {}) => mapsPlaces(search(o)).map(p => p.cc + ' ' + p.place);
  assert.deepEqual(places().slice(0, 3), ['SA Riyadh, Saudi Arabia', 'SA Jeddah, Saudi Arabia', 'SA Dammam, Saudi Arabia']);
  assert.deepEqual(places({ city: 'جدة' }), ['SA Jeddah, Saudi Arabia']);
  assert.deepEqual(places({ countries: ['LB', 'LY'] }).filter(p => p.includes('Tripoli')), ['LB Tripoli, Lebanon', 'LY Tripoli, Libya'], 'one city name, two countries');
});

test('the provider\'s list exhausted, Maps websites are checked and delivered under their own site name, never Google\'s', async () => {
  const store = await testStore(), user = await store.addUser('Alice', 'alice@example.com', 'secure-password', 'member', 10), m = mock();
  try {
    let result = await live(store, m.client).start(user.id, search());
    for (let i = 0; i < 30 && result.status === 'awaiting_provider'; i++) {
      await store.db.run('UPDATE provider_runs SET updated_at=0');
      result = await live(store, m.client).poll(user.id, result.id);
    }
    assert.equal(result.delivered, 2);
    const contacts = (await store.snapshot(user.id)).contacts;
    assert.deepEqual(contacts.map(c => [c.company, c.email, c.city, c.website]).sort(), [
      ['brightteeth.example', 'hello@brightteeth.example', 'Riyadh', 'https://brightteeth.example/'],
      ['smile-dental.example', 'info@smile-dental.example', 'Riyadh', 'https://www.smile-dental.example/ar']]);
    // Google's terms forbid saving its business names: none reaches a contact, the run, the member's cursor or the shared catalog.
    const saved = JSON.stringify([contacts, await store.db.all('SELECT * FROM provider_runs'), await store.db.all('SELECT * FROM provider_cursors'), await store.db.all('SELECT * FROM lead_catalog')]);
    for (const name of ['Smile Dental Clinic', 'Bright Teeth', 'Riyadh Dental Lab']) assert.ok(!saved.includes(name), name);
    // One paid check for the two sites: the lab (by its name), the Instagram page and the place without a website never go.
    assert.equal(m.submitted(), 1);
    const [first, second] = m.google;
    assert.equal(first.headers.get('X-Goog-Api-Key'), 'maps-test-key');
    assert.equal(first.headers.get('X-Goog-FieldMask'), 'places.displayName,places.websiteUri,nextPageToken', 'no phone, address or rating is asked for');
    assert.deepEqual([first.body.textQuery, first.body.regionCode, first.body.pageToken], ['Dental clinics in Riyadh, Saudi Arabia', 'SA', undefined]);
    assert.deepEqual([second.body.textQuery, second.body.pageToken], ['Dental clinics in Riyadh, Saudi Arabia', 'p2']);
    assert.ok(m.google.some(g => g.body.textQuery === 'Dental clinics in Dammam, Saudi Arabia'), 'Jeddah down: on to the next city');
    // Q12: Google's places spend neither the search's page budget nor the member's daily provider work.
    assert.equal((await store.db.get<{ fetched: number }>('SELECT fetched FROM provider_runs'))!.fetched, 0);
  } finally { await store.close(); }
});

test('a city ends after three pages even if Google repeats its page token, and an unreadable position starts at the first city', async () => {
  const asked: string[] = [];
  const repeating: typeof fetch = async (_url, init) => { const b = JSON.parse(String(init?.body)); asked.push(b.textQuery + ' ' + (b.pageToken ?? '-'));
    return Response.json({ places: [{ displayName: { text: 'A Clinic' }, websiteUri: 'https://a-clinic.example' }], nextPageToken: 'same' }); };
  let token: string | null = 'not json';
  for (let i = 0; i < 10 && token !== null; i++) token = (await mapsCompanies(search({ city: 'جدة' }), token, repeating)).token;
  assert.deepEqual(asked, ['Dental clinics in Jeddah, Saudi Arabia -', 'Dental clinics in Jeddah, Saudi Arabia same', 'Dental clinics in Jeddah, Saudi Arabia same']);
});
