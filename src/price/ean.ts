/**
 * GTIN / EAN validation (GTIN-8, -12, -13, -14) with the GS1 mod-10 check digit.
 * Mirrors SQL public.gb_valid_gtin(text) in 20261023001000_prices.sql.
 */
export function isValidGtin(ean: unknown): ean is string {
  if (typeof ean !== 'string' || !/^(\d{8}|\d{12,14})$/.test(ean)) return false;
  const digits = ean.split('').map(Number);
  const check = digits.pop()!;
  let sum = 0;
  // weights 3,1,3,1,... from the rightmost data digit
  for (let i = digits.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += digits[i]! * w;
  return (10 - (sum % 10)) % 10 === check;
}
