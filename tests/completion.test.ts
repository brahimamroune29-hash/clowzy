import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completionDraft, gulf, type Search } from '../src/lib/contracts';

test('completion is an explicit wider draft for only the missing count, retaining the requested audience', () => {
  const filters = { mode: 'companies', sector: 'عيادات الأسنان', countries: ['SA'], city: 'Riyadh', title: '', size: '11-50', count: 50 };
  const search = { status: 'partial', requested: 50, delivered: 12, filters: JSON.stringify(filters) } as Search;
  assert.equal(completionDraft(search, null), undefined);
  const country = completionDraft(search, 'country')!;
  assert.deepEqual(country, { ...filters, count: 38, city: '' });
  assert.deepEqual(completionDraft(search, 'gulf'), { ...country, countries: [...gulf] });
  assert.equal('confirmed' in country, false);
  assert.equal(completionDraft({ ...search, status: 'completed' }, 'gulf'), undefined);
  assert.equal(completionDraft({ ...search, filters: '{broken' }, 'gulf'), undefined);
  assert.equal(completionDraft({ ...search, filters: JSON.stringify({ ...filters, countries: ['US'] }) }, 'gulf'), undefined);
  assert.equal(completionDraft({ ...search, filters: JSON.stringify({ ...filters, countries: [...gulf], city: '' }) }, 'gulf'), undefined);
  assert.equal(completionDraft({ ...search, filters: JSON.stringify({ ...filters, city: '' }) }, 'country'), undefined);
});
