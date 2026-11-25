import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TEXT, parseFormat, plainText, toggleMark, type Seg } from './format.ts';

// A compact picture of the result: plain text as is, styled text as <b>..</b>.
const show = (segs: Seg[]): string => segs.map(x => ('text' in x ? x.text : `<${x.style}>${show(x.children)}</${x.style}>`)).join('');
const f = (s: string) => show(parseFormat(s));

test('the four styles, as WhatsApp writes them', () => {
  assert.equal(f('*bold*'), '<b>bold</b>');
  assert.equal(f('_italic_'), '<i>italic</i>');
  assert.equal(f('~gone~'), '<s>gone</s>');
  assert.equal(f('`code`'), '<m>code</m>');
  assert.equal(f('say *hi* to _all_ of ~them~ now'), 'say <b>hi</b> to <i>all</i> of <s>them</s> now');
  assert.equal(f('*two words*'), '<b>two words</b>');
});

test('styles nest, and code is never formatted inside', () => {
  assert.equal(f('*_both_*'), '<b><i>both</i></b>');
  assert.equal(f('_*both*_'), '<i><b>both</b></i>');
  assert.equal(f('`*not bold*`'), '<m>*not bold*</m>');
  assert.equal(f('```\nline *one*\nline two\n```'), '<m>\nline *one*\nline two\n</m>');
});

test('markers that are not around a word stay as written', () => {
  for (const s of ['2*3*4', 'a*b*c', 'snake_case_name', '* not bold*', '*not bold *', '**', '*', 'a * b * c', '~ ~', '`', 'price ~ 5'])
    assert.equal(f(s), s, s);
  assert.equal(f('*open but never closed'), '*open but never closed');
  assert.equal(f('*one line\nnot two*'), '*one line\nnot two*', 'the short markers do not cross a line break');
});

test('punctuation may follow a closing marker, and Arabic is formatted too', () => {
  assert.equal(f('*yes*, and _no_.'), '<b>yes</b>, and <i>no</i>.');
  assert.equal(f('(*inside*)'), '(<b>inside</b>)');
  assert.equal(f('مرحبا *يا أهلا* بكم'), 'مرحبا <b>يا أهلا</b> بكم');
  assert.equal(f('*مرحبا*'), '<b>مرحبا</b>');
});

test('a link keeps its underscores and tildes', () => {
  assert.equal(f('see https://example.com/a_b_c/~d~ please'), 'see https://example.com/a_b_c/~d~ please');
  assert.equal(f('_https://example.com/x_'), '<i>https://example.com/x</i>', 'a whole link can still be styled');
  assert.equal(f('www.site.com/my_page_here and _this_'), 'www.site.com/my_page_here and <i>this</i>');
});

test('nothing is ever markup: tags in a message are just text', () => {
  assert.equal(f('<b>hi</b> <script>x</script>'), '<b>hi</b> <script>x</script>');
  assert.deepEqual(parseFormat('<img src=x onerror=alert(1)>'), [{ text: '<img src=x onerror=alert(1)>' }]);
});

test('plain text drops the markers (chat-list preview, notifications)', () => {
  assert.equal(plainText('*Hello* _there_ ~x~ `y`'), 'Hello there x y');
  assert.equal(plainText('2*3*4 stays'), '2*3*4 stays');
});

test('the toolbar wraps a selection, skips its spaces, and unwraps it again', () => {
  assert.deepEqual(toggleMark('say hello now', 4, 9, 'b'), { text: 'say *hello* now', start: 5, end: 10 });
  assert.deepEqual(toggleMark('say *hello* now', 5, 10, 'b'), { text: 'say hello now', start: 4, end: 9 });
  assert.deepEqual(toggleMark('say hello now', 3, 10, 'i'), { text: 'say _hello_ now', start: 5, end: 10 }, 'the spaces stay outside');
  assert.deepEqual(toggleMark('x', 0, 0, 's'), { text: 'x', start: 0, end: 0 }, 'nothing selected, nothing changes');
  assert.equal(f(toggleMark('a b', 0, 3, 'm').text), '<m>a b</m>');
});

test('the limit is 10,000 characters', () => assert.equal(MAX_TEXT, 10_000));
