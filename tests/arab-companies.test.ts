import { test } from 'node:test';
import assert from 'node:assert/strict';
import { peopleQuery } from '../src/lib/icypeas';
import { ARAB } from '../src/lib/places';
import { input } from './pg';

// Owner 2026-10-11 (Q7, Q12, confirmed with the free counts): targeting Arab countries, a company known to be headquartered outside
// them is left out at the provider; an unknown headquarters passes (most salons have none). Saudi tech 23,981 -> 15,580 people.
test('a search in Arab countries leaves out companies known to be headquartered outside them, at every stage', () => {
  for (const stage of [0, 1, 2, 3]) {
    const hq = peopleQuery(input(1), stage)['currentCompany.location'];
    assert.ok(hq?.exclude && !('include' in hq), 'exclude only: an unknown headquarters passes');
    assert.ok(hq.exclude.length <= 200, 'the provider takes 200 values per filter');
    for (const foreign of ['US', 'GB', 'FR', 'DE', 'IN', 'CN', 'JP', 'TR', 'KY', 'VG', 'BM', 'JE']) assert.ok(hq.exclude.includes(foreign), foreign);
    assert.deepEqual(ARAB.filter(c => hq.exclude.includes(c)), [], 'no Arab country is excluded');
  }
  assert.equal(ARAB.length, 22, 'the Arab League');
});

test('a country the member chose outside the Arab world keeps its own companies; every other foreign headquarters stays out', () => {
  const mixed = peopleQuery({ ...input(1), countries: ['SA', 'TR'] })['currentCompany.location']!;
  assert.ok(!mixed.exclude.includes('TR') && mixed.exclude.includes('US'), 'Saudi staff of a US company stay out of a Saudi and Turkish search');
  const us = peopleQuery({ ...input(1), countries: ['US'] })['currentCompany.location']!;
  assert.ok(!us.exclude.includes('US') && us.exclude.includes('GB'));
});
