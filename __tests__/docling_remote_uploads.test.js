import { isFreshDoclingUpload } from '../src/services/docling_uploads.js';

test('temporary uploads accept only timestamps within the last ten minutes', () => {
  const now = 1800000000000;
  expect(isFreshDoclingUpload(now, now)).toBe(true);
  expect(isFreshDoclingUpload(now - 600000, now)).toBe(true);
  expect(isFreshDoclingUpload(now - 600001, now)).toBe(false);
  expect(isFreshDoclingUpload(now + 1, now)).toBe(false);
  for (const corrupt of [undefined, null, NaN, Infinity, -Infinity, 0, '1800000000000']) {
    expect(isFreshDoclingUpload(corrupt, now)).toBe(false);
  }
});
