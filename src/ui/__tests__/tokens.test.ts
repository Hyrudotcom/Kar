import { contrastRatio } from '../contrast';
import { palette } from '../tokens';

/** WCAG 2.2 AA token test (design-spec 7), in light and dark. */
describe.each(['light', 'dark'] as const)('%s tokens', (scheme) => {
  const p = palette[scheme];
  it.each([
    ['text', 'bg'],
    ['text', 'surface'],
    ['text', 'surfaceRaised'],
    ['text', 'accentSoft'],
    ['textMuted', 'bg'],
    ['textMuted', 'surface'],
    ['textMuted', 'surfaceRaised'],
    ['accent', 'bg'],
    ['accent', 'surface'],
    ['onAccent', 'accent'],
    ['warning', 'bg'],
    ['warning', 'surfaceRaised'],
    ['danger', 'bg'],
    ['danger', 'dangerSoft'],
    ['danger', 'surfaceRaised'],
  ] as const)('%s on %s meets 4.5:1', (fg, bg) => {
    expect(contrastRatio(p[fg], p[bg])).toBeGreaterThanOrEqual(4.5);
  });

  it('checked items (textDisabled, always with strike-through) stay above 3:1', () => {
    expect(contrastRatio(p.textDisabled, p.bg)).toBeGreaterThanOrEqual(3);
  });

  it('the unchecked checkbox ring (textMuted) meets the 3:1 non-text contrast', () => {
    expect(contrastRatio(p.textMuted, p.bg)).toBeGreaterThanOrEqual(3);
  });
});
