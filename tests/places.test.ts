import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countrySuggestions, placeOf } from '../src/lib/places';

test('a profile address gives its country code and city, in any language Icypeas returns', () => {
  const cases: [string, string, string][] = [
    ['Abha, \'Asīr, Saoedi-Arabië', 'SA', 'Abha'], ['الرياض السعودية', 'SA', 'الرياض'], ['السعودية', 'SA', ''],
    ['الشرقية الدمام السعودية', 'SA', 'الدمام'], ['مكة جدة السعودية', 'SA', 'جدة'], ['Jubail, Province de l\'Est, Arabie saoudite', 'SA', 'Jubail'],
    ['دبي الإمارات العربية المتحدة', 'AE', 'دبي'], ['أبو ظبي الإمارات العربية المتحدة', 'AE', 'أبو ظبي'], ['Doubaï, Émirats arabes unis', 'AE', 'Doubaï'],
    ['Saudi Arabia', 'SA', ''], ['Riyadh, Riyadh, Saudi Arabia', 'SA', 'Riyadh'], ['Zone 57, Doha, Qatar', 'QA', 'Zone 57'],
    ['Kuwait City, Al Asimah, Kuwait', 'KW', 'Kuwait City'], ['Las Vegas, United States', 'US', 'Las Vegas'], ['Toulouse, Occitanie, France', 'FR', 'Toulouse'],
    ['Greater Paris Metropolitan Region', '', ''], ['', '', ''],
  ];
  for (const [address, code, city] of cases) assert.deepEqual(placeOf(address), { code, city }, address);
});

test('typing part of a country name suggests it: Arabic with or without «ال», English, common short forms; the Gulf first', () => {
  assert.equal(countrySuggestions('السع')[0], 'SA');
  assert.equal(countrySuggestions('سعو')[0], 'SA');
  assert.equal(countrySuggestions('ق')[0], 'QA', 'one letter: the Gulf country first');
  assert.equal(countrySuggestions('امار')[0], 'AE');
  assert.equal(countrySuggestions('uae')[0], 'AE');
  assert.equal(countrySuggestions('emir')[0], 'AE', 'any word of the English name');
  assert.equal(countrySuggestions('مصر')[0], 'EG');
  assert.equal(countrySuggestions('امريك')[0], 'US');
  assert.ok(countrySuggestions('ال').length === 0 && countrySuggestions('  ').length === 0, 'nothing to match yet');
  assert.ok(countrySuggestions('a').length <= 6, 'a short list');
});
