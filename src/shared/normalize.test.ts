import { NORMALIZE_VECTORS, normalizeName } from './normalize';

describe('normalizeName', () => {
  it.each(NORMALIZE_VECTORS)('%j -> %j', (input, expected) => {
    expect(normalizeName(input)).toBe(expected);
  });
});
