import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyPeople } from '../src/lib/store';

// The daily provider-work cap is the owner's knob (host env DAILY_PEOPLE), raised for thin markets that need
// more depth per day. A higher cap spends more provider credit, so it stays the owner's call. Unset or invalid
// falls back to the 2500 default, and a bad value never disables the cap by accident.
test('daily cap: default, a valid raise, and guards against bad values', () => {
  delete process.env.DAILY_PEOPLE;
  assert.equal(dailyPeople(), 2500, 'unset -> the 2500 default');

  process.env.DAILY_PEOPLE = '10000';
  assert.equal(dailyPeople(), 10000, 'a valid raise is honoured');

  process.env.DAILY_PEOPLE = ' 8000 ';
  assert.equal(dailyPeople(), 8000, 'surrounding spaces from a hosting panel are tolerated');

  // Non-positive or non-numeric must fall back to the default, never 0 (which would stop every search)
  for (const bad of ['', '0', '-5', 'lots', 'NaN']) {
    process.env.DAILY_PEOPLE = bad;
    assert.equal(dailyPeople(), 2500, `"${bad}" -> the safe default, not a disabled or zero cap`);
  }
  delete process.env.DAILY_PEOPLE;
});
