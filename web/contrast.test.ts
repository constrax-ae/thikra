// WCAG AA (backlog F-09): every text/background pairing the app really uses must reach 4.5:1 (3:1 for large text).
// The colours are read from the real stylesheet, so changing a token in styles.css re-runs this check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('./src/styles.css', import.meta.url), 'utf8');
// Tokens: the base set, and the dark set = base overridden by the `html[data-theme="dark"]` block.
const darkBlock = css.match(/html\[data-theme="dark"\]\s*\{([^}]*)\}/)?.[1] ?? '';
const read = (src: string, name: string) => src.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
let theme: 'light' | 'dark' = 'light';
const token = (name: string) => {
  const v = (theme === 'dark' ? read(darkBlock, name) : undefined) ?? read(css, name);
  assert.ok(v, `token --color-${name} missing from styles.css`);
  return v!;
};
type RGB = [number, number, number];
const rgb = (hex: string): RGB => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as RGB;
const over = (fg: RGB, bg: RGB, a: number): RGB => fg.map((f, i) => Math.round(f * a + bg[i] * (1 - a))) as RGB;
const lum = (c: RGB) => { const [r, g, b] = c.map(v => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a: RGB, b: RGB) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

function pairsFor(t: 'light' | 'dark'): Array<[string, RGB, RGB]> {
  theme = t;
  const ink = rgb(token('ink')), paper = rgb(token('paper')), card = rgb(token('card')), green = rgb(token('green'));
  const soft = rgb(token('green-soft')), gold = rgb(token('gold')), line = rgb(token('line')), muted = rgb(token('muted'));
  const goldDark = rgb(token('gold-dark')), danger = rgb(token('danger')), dangerSoft = rgb(token('danger-soft')), white: RGB = [255, 255, 255];
  
  // [what, text colour, background colour]
  const brand = rgb(token('brand')), mutedFill = rgb(token('muted-fill'));
  const pairs: Array<[string, RGB, RGB]> = [
    ['body text on paper', ink, paper],
    ['body text on card', ink, card],
    ['secondary text on paper', muted, paper],
    ['secondary text on card', muted, card],
    ['secondary text on line (neutral badge)', muted, line],
    ['secondary text on line/50 (system message)', muted, over(line, paper, 0.5)],
    ['button text (white on brand)', white, brand],
    ['sent-bubble text (white on brand)', white, brand],
    ['sent-bubble time (white/70 on green)', over(white, brand, 0.7), brand],
    ['sent-bubble link (white/80 on green)', over(white, brand, 0.8), brand],
    ['muted unread badge (white on muted fill)', white, mutedFill],
    ['active tab label (green on paper)', green, paper],
    ['read tick (sky-300 on brand)', rgb('#7dd3fc'), brand],
    ['delivered tick (white/80 on green)', over(white, brand, 0.8), brand],
    ['green text on card', green, card],
    ['green text on paper', green, paper],
    ['green text on green-soft badge', green, soft],
    ['agent badge (gold-dark on gold/20 over paper)', goldDark, over(gold, paper, 0.2)],
    ['agent badge (gold-dark on gold/20 over card)', goldDark, over(gold, card, 0.2)],
    ['pinned banner label (gold-dark on gold/15 over paper)', goldDark, over(gold, paper, 0.15)],
    ['pinned banner text (ink on gold/15 over paper)', ink, over(gold, paper, 0.15)],
    ['notice (gold-dark on gold/15 over card)', goldDark, over(gold, card, 0.15)],
    ['owner label (gold-dark on card)', goldDark, card],
    ['tonal button (gold-dark on gold/20 over card)', goldDark, over(gold, card, 0.2)],
    ['white on every selectable bubble colour', white, rgb('#6b4a0f')],
    ['white on navy bubble', white, rgb('#1d3557')],
    ['white on plum bubble', white, rgb('#5b2a5e')],
    ['white on teal bubble', white, rgb('#0f5a5a')],
    ['white on slate bubble', white, rgb('#3d4552')],
    ['text on my default bubble (ink on soft green)', rgb('#2b3832'), rgb('#d9f2d6')],
    ['read tick on my default bubble (soft green)', rgb('#075985'), rgb('#d9f2d6')],
    ['time on my default bubble (muted on soft green)', rgb('#3f4f47'), rgb('#d9f2d6')],
    ['danger link on paper', danger, paper],
    ['danger text on danger-soft', danger, dangerSoft],
  ];
  return pairs;
}

for (const t of ['light', 'dark'] as const) {
  test(`every text/background pair in use meets WCAG AA (4.5:1) in the ${t} theme`, () => {
    theme = t;
    if (t === 'dark') assert.notEqual(token('paper'), (theme = 'light', token('paper')), 'the dark theme must really override the light tokens');
    const failures = pairsFor(t).map(([what, fg, bg]) => ({ what, r: ratio(fg, bg) })).filter(x => x.r < 4.5);
    assert.deepEqual(failures.map(f => `${f.what}: ${f.r.toFixed(2)}`), []);
  });
}

test('plain gold is never used for text: it fails AA on paper and card (it is for fills and the logo heart)', () => {
  theme = 'light';
  assert.ok(ratio(rgb(token('gold')), rgb(token('paper'))) < 4.5, 'if gold ever passes, this guard can be relaxed');
  for (const f of ['Admin', 'ChatList', 'You', 'Memory', 'CircleView', 'Import', 'Login', 'main']) {
    const src = readFileSync(new URL(`./src/${f}.tsx`, import.meta.url), 'utf8');
    const bad = [...src.matchAll(/text-gold(?![-\w])/g)].length;
    // Login.tsx has one: the heart glyph on the green logo tile (gold on green is 5:1 and decorative).
    assert.ok(bad <= (f === 'Login' ? 1 : 0), `${f}.tsx uses text-gold ${bad} time(s); use text-gold-dark`);
  }
});

test('no text uses ink at partial opacity (it silently fails AA); use text-muted', () => {
  for (const f of ['Admin', 'ChatList', 'You', 'Memory', 'CircleView', 'Import', 'Login', 'main']) {
    const src = readFileSync(new URL(`./src/${f}.tsx`, import.meta.url), 'utf8');
    assert.equal([...src.matchAll(/text-ink\/\d+/g)].length, 0, `${f}.tsx has text-ink/NN`);
  }
});

test('received bubbles are always white with the light tokens pinned, in both themes (WhatsApp style)', () => {
  theme = 'light';
  const white: RGB = [255, 255, 255];
  const pairs: Array<[string, RGB]> = [
    ['ink on white', rgb(token('ink'))], ['muted on white', rgb(token('muted'))], ['green on white', rgb(token('green'))],
    ['gold-dark (sender name) on white', rgb(token('gold-dark'))],
  ];
  const failures = pairs.map(([what, fg]) => ({ what, r: ratio(fg, white) })).filter(x => x.r < 4.5);
  assert.deepEqual(failures.map(f => `${f.what}: ${f.r.toFixed(2)}`), []);
  // the pinned values in the stylesheet are the light ones
  const pinned = css.match(/\.bubble-other \{[^}]*\}/)?.[0] ?? '';
  for (const n of ['ink', 'muted', 'green', 'gold-dark']) assert.ok(pinned.includes(token(n)), `bubble-other must pin --color-${n} to ${token(n)}`);
});

test('every member-name colour reaches 4.5:1 on the white received bubble', () => {
  const src = readFileSync(new URL('./src/CircleView.tsx', import.meta.url), 'utf8');
  const list = src.match(/MEMBER_COLOURS = \[([^\]]*)\]/)?.[1].match(/#[0-9a-fA-F]{6}/g) ?? [];
  assert.ok(list.length >= 8, 'at least eight colours so a family rarely shares one');
  const white: RGB = [255, 255, 255];
  assert.deepEqual(list.filter(c => ratio(rgb(c), white) < 4.5), []);
});
