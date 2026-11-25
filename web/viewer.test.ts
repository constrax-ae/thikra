import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampPan, clampScale, FIT, keyStep, MAX_SCALE, stepIndex, swipeStep, toggleZoom, zoomAt } from './src/viewer.ts';

test('zoom stays between fitting the screen and five times', () => {
  assert.equal(clampScale(0.2), 1);
  assert.equal(clampScale(99), MAX_SCALE);
  assert.equal(clampScale(NaN), 1);
  assert.deepEqual(zoomAt(FIT, 0.5, 10, 10, 400, 300), FIT, 'zooming out past fit just fits');
});

test('zooming on a point keeps that point under the finger', () => {
  const w = 400, h = 300;
  const v = zoomAt(FIT, 2, 100, 50, w, h);
  assert.equal(v.scale, 2);
  // The photo point under (100, 50) at scale 1 is (100, 50); after zooming it must still be on screen at (100, 50).
  assert.equal(v.x + 100 * 2, 100);
  assert.equal(v.y + 50 * 2, 50);
});

test('a zoomed photo can be dragged only to its own edge', () => {
  const w = 400, h = 300;
  assert.deepEqual(clampPan({ scale: 2, x: 5000, y: -5000 }, w, h), { scale: 2, x: 200, y: -150 });
  assert.deepEqual(clampPan({ scale: 1, x: 30, y: 30 }, w, h), { scale: 1, x: 0, y: 0 }, 'at fit it cannot move at all');
});

test('a double tap zooms in on the point, and a second one fits again', () => {
  const v = toggleZoom(FIT, 0, 0, 400, 300);
  assert.equal(v.scale, 2.5);
  assert.deepEqual(toggleZoom(v, 0, 0, 400, 300), FIT);
});

test('a sideways swipe turns the page the way the language reads', () => {
  assert.equal(swipeStep(-120, 10, false), 1, 'English: swipe left for the next photo');
  assert.equal(swipeStep(120, 10, false), -1);
  assert.equal(swipeStep(120, 10, true), 1, 'Arabic: swipe right for the next photo');
  assert.equal(swipeStep(-120, 10, true), -1);
  assert.equal(swipeStep(30, 0, false), 0, 'a short drag is not a swipe');
  assert.equal(swipeStep(80, 120, false), 0, 'a mostly vertical drag is not a swipe');
});

test('arrow keys and the ends of the list', () => {
  assert.equal(keyStep('ArrowRight', false), 1);
  assert.equal(keyStep('ArrowLeft', true), 1);
  assert.equal(keyStep('Enter', false), 0);
  assert.equal(stepIndex(0, -1, 5), 0, 'no step before the first');
  assert.equal(stepIndex(4, 1, 5), 4, 'no step past the last');
  assert.equal(stepIndex(2, 1, 5), 3);
});
