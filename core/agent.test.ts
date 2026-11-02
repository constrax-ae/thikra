import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assess, normalize } from './agent.ts';

test('normalize unifies Arabic letter variants and strips tashkeel', () => {
  assert.equal(normalize('مَبْرُوك'), 'مبروك');
  assert.equal(normalize('أحمد إبراهيم آل'), 'احمد ابراهيم ال');
  assert.equal(normalize('ولادة'), 'ولاده');
});

test('birth announcement is archived at strict sensitivity', () => {
  const r = assess('الحمدلله رزقنا بمولود جديد اسمه أحمد يوم الخميس، ألف مبروك لأخوي', 'strict');
  assert.equal(r.verdict, 'archived');
  assert.equal(r.category, 'birth');
});

test('passing news is categorised', () => {
  const r = assess('إنا لله وإنا إليه راجعون، توفي جدي الليلة والعزاء غداً', 'medium');
  assert.equal(r.verdict, 'archived');
  assert.equal(r.category, 'passing');
});

test('small talk is rejected even when manually requested', () => {
  const r = assess('هلا', 'lenient', true);
  assert.equal(r.verdict, 'rejected');
});

test('a bare question is rejected', () => {
  assert.equal(assess('وين كلكم متى نتجمع؟', 'lenient').verdict, 'rejected');
});

test('below-threshold message is skipped, but archived on manual request', () => {
  const text = 'وصلنا المطار';
  assert.equal(assess(text, 'strict').verdict, 'skipped');
  assert.equal(assess(text, 'strict', true).verdict, 'archived');
});

test('lenient threshold admits what strict does not', () => {
  const text = 'نجحت بنتي في الاختبار';
  assert.equal(assess(text, 'strict').verdict, 'skipped');
  assert.equal(assess(text, 'lenient').verdict, 'archived');
});

test('score is clamped 0..100', () => {
  const r = assess('زواج زفاف عرس خطوبة عقد القران العروس العريس مبروك ابني 2025 wedding engaged married', 'strict');
  assert.ok(r.score <= 100 && r.score >= 0);
});
