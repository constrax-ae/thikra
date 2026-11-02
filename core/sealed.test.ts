import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mentionsDeath, mentionsOccurrence, requiredMembers, MIN_MESSAGES } from './sealed.ts';

test('thresholds: more than three messages; three members, or two when exactly three others remain', () => {
  assert.equal(MIN_MESSAGES, 4);
  assert.deepEqual([10, 5, 4, 3, 2, 1, 0].map(requiredMembers), [3, 3, 3, 2, 2, 1, 1]);
});

test('death: the name next to a death phrase, in Arabic and English', () => {
  const dad = ['ناصر الدوسري'];
  for (const t of ['توفي ناصر الدوسري صباح اليوم', 'إنا لله وإنا إليه راجعون، انتقل ناصر إلى رحمة الله', 'البقاء لله، ناصر رحمه الله', 'ناصر مات الليلة', 'Naser passed away this morning', 'My condolences for Naser, rest in peace']) {
    assert.equal(mentionsDeath(t, ['ناصر الدوسري', 'Naser']), true, t);
  }
  assert.equal(mentionsDeath('الله يرحم ناصر ويغفر له، عظّم الله أجركم', dad), true);
  assert.equal(mentionsDeath('رحم الله ناصر الدوسري وغفر له', dad), true);
});

test('death: does NOT conclude from relatives, rumours, wishes, other people, or no name', () => {
  const names = ['ناصر الدوسري', 'Naser'];
  for (const t of [
    'توفي والد ناصر أمس',                       // his father
    'توفيت أم ناصر الله يرحمها',                 // his mother
    'مات جد ناصر قبل سنوات',                    // his grandfather
    'سمعت أن ناصر توفي لكنها إشاعة',            // rumour
    'ناصر لم يتوف، بخير والحمد لله',            // negation
    'الله يطيل عمر ناصر ولا يريني فيه مكروه، حفظه الله',   // wish
    'توفي خالد البارحة',                         // someone else
    'عظم الله أجركم جميعاً',                     // no name
    'Naser is not dead, that is a rumor',
    'I hope Naser does not die before the wedding',
    'ناصر وصل المطار بسلامة',                    // no death at all
  ]) assert.equal(mentionsDeath(t, names), false, t);
});

test('occasion: every meaningful word, plus an "it happened / congratulations" cue, never a future wish', () => {
  const occ = 'زواج خالد';
  for (const t of ['ألف مبروك زواج خالد', 'تم زواج خالد اليوم والحمد لله', 'مبروك لخالد بمناسبة زواجه', 'Congratulations on Khalid wedding'.replace('Khalid wedding', 'زواج خالد')]) assert.equal(mentionsOccurrence(t, occ), true, t);
  for (const t of [
    'عقبال زواج خالد إن شاء الله',      // future wish
    'موعد زواج خالد الأسبوع القادم',     // schedule
    'زواج خالد قريباً',                  // soon
    'مبروك التخرج لسارة',                // different occasion
    'خالد وصل',                          // no occasion
    'مبروك لخالد',                       // congratulation but not the occasion words
  ]) assert.equal(mentionsOccurrence(t, occ), false, t);
  assert.equal(mentionsOccurrence('Congratulations, graduation of Sara done'.replace('graduation of Sara done', 'تخرج سارة'), 'تخرج سارة'), true);
  assert.equal(mentionsOccurrence('مبروك', ''), false, 'an empty occasion never matches');
});
