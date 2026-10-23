import {
  cleanItemName,
  formatIncrement,
  formatQuantity,
  formatQuantityField,
  parseEntry,
  parseQuantityField,
  speakQuantity,
} from './quantity';

describe('parseEntry (quick-add bar)', () => {
  const cases: [string, string, number, string, boolean][] = [
    ['melk', 'Melk', 1, 'stuk', false],
    ['2 melk', 'Melk', 2, 'stuk', true],
    ['melk 2', 'Melk', 2, 'stuk', true],
    ['500 g gehakt', 'Gehakt', 500, 'g', true],
    ['500g gehakt', 'Gehakt', 500, 'g', true],
    ['gehakt 500 g', 'Gehakt', 500, 'g', true],
    ['gehakt 500g', 'Gehakt', 500, 'g', true],
    ['3x brood', 'Brood', 3, 'stuk', true],
    ['3 x brood', 'Brood', 3, 'stuk', true],
    ['3× brood', 'Brood', 3, 'stuk', true],
    ['x3 brood', 'Brood', 3, 'stuk', true],
    ['brood 3x', 'Brood', 3, 'stuk', true],
    ['brood x3', 'Brood', 3, 'stuk', true],
    ['1,5 l melk', 'Melk', 1.5, 'l', true],
    ['1.5 l melk', 'Melk', 1.5, 'l', true],
    ['2 l melk', 'Melk', 2, 'l', true],
    ['2 liter melk', 'Melk', 2, 'l', true],
    ['melk 1,5l', 'Melk', 1.5, 'l', true],
    ['1 kg aardappelen', 'Aardappelen', 1, 'kg', true],
    ['2 kilo appels', 'Appels', 2, 'kg', true],
    ['250 ml slagroom', 'Slagroom', 250, 'ml', true],
    ['33 cl cola', 'Cola', 330, 'ml', true],
    ['1 pond gehakt', 'Gehakt', 500, 'g', true],
    ['2 ons kaas', 'Kaas', 200, 'g', true],
    ['6 stuks eieren', 'Eieren', 6, 'stuk', true],
    ['2 lasagne', 'Lasagne', 2, 'stuk', true],
    ['2 kaa', 'Kaa', 2, 'stuk', true],
    ['  2   halfvolle   melk ', 'Halfvolle melk', 2, 'stuk', true],
    ['7up', '7up', 1, 'stuk', false],
    ['Vitamine B12', 'Vitamine B12', 1, 'stuk', false],
    ['Pizza 4 kazen', 'Pizza 4 kazen', 1, 'stuk', false],
    ['2', '2', 1, 'stuk', false],
    ['500 g', '500 g', 1, 'stuk', false],
    ['0 melk', '0 melk', 1, 'stuk', false],
    ['100000 melk', '100000 melk', 1, 'stuk', false],
    ['Crème fraîche', 'Crème fraîche', 1, 'stuk', false],
    ['ijsbergsla', 'Ijsbergsla', 1, 'stuk', false],
    ['iPhone-oplader', 'IPhone-oplader', 1, 'stuk', false],
  ];
  it.each(cases)('%j -> %s / %d %s', (input, name, quantity, unit, explicit) => {
    expect(parseEntry(input)).toEqual({ name, quantity, unit, explicitQuantity: explicit });
  });

  it('returns null for empty input', () => {
    expect(parseEntry('')).toBeNull();
    expect(parseEntry('   ')).toBeNull();
  });

  it('caps the name at 120 characters', () => {
    expect(parseEntry('a'.repeat(300))!.name).toHaveLength(120);
  });

  it('rounds to three decimals', () => {
    expect(parseEntry('0,125 kg kaas')).toMatchObject({ quantity: 0.125, unit: 'kg' });
  });
});

describe('parseQuantityField (item detail)', () => {
  it.each([
    ['', 1, 'stuk'],
    ['2', 2, 'stuk'],
    ['2x', 2, 'stuk'],
    ['x2', 2, 'stuk'],
    ['2 stuks', 2, 'stuk'],
    ['500 g', 500, 'g'],
    ['500g', 500, 'g'],
    ['1,5 l', 1.5, 'l'],
    ['1,5 L', 1.5, 'l'],
    ['1 pond', 500, 'g'],
  ] as const)('%j -> %d %s', (input, quantity, unit) => {
    expect(parseQuantityField(input)).toEqual({ quantity, unit });
  });

  it.each(['abc', '0', '-1', '2 dozen', '100000', '1,5 l melk'])('rejects %j', (input) => {
    expect(parseQuantityField(input)).toBeNull();
  });
});

describe('formatting', () => {
  it('shows nothing for 1 stuk and a decimal comma otherwise', () => {
    expect(formatQuantity(1, 'stuk')).toBe('');
    expect(formatQuantity(2, 'stuk')).toBe('2');
    expect(formatQuantity(500, 'g')).toBe('500 g');
    expect(formatQuantity(1.5, 'l')).toBe('1,5 l');
    expect(formatQuantity(0.1 + 0.2, 'kg')).toBe('0,3 kg');
  });
  it('formats the detail field, increments and speech', () => {
    expect(formatQuantityField(1, 'stuk')).toBe('1');
    expect(formatQuantityField(500, 'g')).toBe('500 g');
    expect(formatIncrement(1, 'stuk')).toBe('+1');
    expect(formatIncrement(500, 'g')).toBe('+500 g');
    expect(speakQuantity(1, 'stuk')).toBe('');
    expect(speakQuantity(1.5, 'l')).toBe('1,5 liter');
  });
  it('capitalises only a lower-case first letter', () => {
    expect(cleanItemName('melk')).toBe('Melk');
    expect(cleanItemName('AH melk')).toBe('AH melk');
    expect(cleanItemName('ëieren')).toBe('Ëieren');
  });
});
