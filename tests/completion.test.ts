import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completionDraft, gulf, type Search } from '../src/lib/contracts';
import { assistRequestSchema } from '../src/lib/schemas';

test('completion is an explicit wider draft for only the missing count, retaining the requested audience', () => {
  const filters = { mode: 'companies', sector: 'عيادات الأسنان', countries: ['SA'], city: 'Riyadh', title: '', size: '50', count: 50 };
  const search = { status: 'partial', requested: 50, delivered: 12, filters: JSON.stringify(filters) } as Search;
  assert.equal(completionDraft(search, null), undefined);
  const country = completionDraft(search, 'country')!;
  assert.deepEqual(country, { ...filters, title: [], count: 38, city: '' }, 'a stored single title reads as a list');
  assert.deepEqual(completionDraft(search, 'region'), { ...country, countries: [...gulf] });
  assert.equal('confirmed' in country, false);
  assert.equal(completionDraft({ ...search, status: 'completed' }, 'region'), undefined);
  assert.equal(completionDraft({ ...search, filters: '{broken' }, 'region'), undefined);
  assert.equal(completionDraft({ ...search, filters: JSON.stringify({ ...filters, countries: ['US'] }) }, 'region'), undefined);
  assert.equal(completionDraft({ ...search, filters: JSON.stringify({ ...filters, countries: [...gulf], city: '' }) }, 'region'), undefined);
  assert.equal(completionDraft({ ...search, filters: JSON.stringify({ ...filters, city: '' }) }, 'country'), undefined);
});

test('a short search offers the member\'s region and another country; nothing widens on its own (owner 2026-10-11)', () => {
  const filters = { mode: 'people', sector: 'التقنية والبرمجيات', countries: ['LB'], city: '', title: '', size: '1000', count: 20 };
  const search = { status: 'partial', requested: 20, delivered: 5, filters: JSON.stringify(filters) } as Search;
  assert.deepEqual(completionDraft(search, 'region')!.countries, ['LB', 'SY', 'JO', 'PS', 'IQ'], 'the Levant, not the Gulf');
  assert.deepEqual(completionDraft(search, 'other'), { ...filters, title: [], count: 15, countries: [] }, 'the member picks the country');
  assert.equal(completionDraft({ ...search, filters: JSON.stringify({ ...filters, countries: ['LB', 'SY', 'JO', 'PS', 'IQ'] }) }, 'region'), undefined, 'nothing to add');
  assert.equal(completionDraft(search, 'country'), undefined, 'no city: the whole country is what was searched');
});

test('the region button never offers more countries than a search takes, old Gulf links still open the Gulf, and the assistant takes an empty country list', () => {
  const filters = { mode: 'people', sector: 'التقنية والبرمجيات', countries: ['SA', 'LB'], city: '', title: '', size: '1000', count: 20 };
  const search = { status: 'partial', requested: 20, delivered: 5, filters: JSON.stringify(filters) } as Search;
  assert.equal(completionDraft(search, 'region'), undefined, 'the Gulf and the Levant together are 12 countries: a search takes 10');
  const saudi = { ...search, filters: JSON.stringify({ ...filters, countries: ['SA'] }) };
  assert.deepEqual(completionDraft(saudi, 'gulf'), completionDraft(saudi, 'region'), 'a link from before 2026-10-11');
  const context = { mode: 'people', sector: 'التقنية والبرمجيات', countries: [], city: '', title: [], size: '1000', count: 15 };
  assert.ok(assistRequestSchema.safeParse({ messages: [{ role: 'user', content: 'in Jordan' }], context }).success, '«another country» left the list empty');
});
