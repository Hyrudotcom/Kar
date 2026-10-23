/** public.gb_normalize_name must equal src/shared/normalize.ts on the shared vectors. */
import { NORMALIZE_VECTORS, normalizeName } from '@/src/shared/normalize';
import { admin, closePool } from './_helpers';

afterAll(closePool);

test.each(NORMALIZE_VECTORS.map(([i, o]) => [i, o]))('gb_normalize_name(%j) = %j', async (input, expected) => {
  const rows = await admin<{ n: string }>('select public.gb_normalize_name($1) as n', [input]);
  expect(rows[0]!.n).toBe(expected);
  expect(normalizeName(input)).toBe(expected);
});

test('extra cases agree with the TypeScript implementation', async () => {
  const extra = ['Ëierkoek', 'appel sap', ' Ça  va ', 'ﬁjne ﬂes', 'Smörgås\n\nbord', 'Äpfel', 'ÀÉÎÕÜ'];
  for (const s of extra) {
    const rows = await admin<{ n: string }>('select public.gb_normalize_name($1) as n', [s]);
    expect([s, rows[0]!.n]).toEqual([s, normalizeName(s)]);
  }
});
