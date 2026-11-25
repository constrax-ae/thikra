import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addPoint, boxPixels, clampRange, clipName, dragBox, isWholeClip, MIN_BOX, MIN_CLIP, mosaicStep, pickMime, secs, VIDEO_MIMES, type Box, type Stroke } from './src/edit.ts';

const box = (x: number, y: number, w: number, h: number): Box => ({ x, y, w, h });

test('a box being dragged stays inside the picture, whichever way it is pushed', () => {
  assert.deepEqual(dragBox(box(0.1, 0.1, 0.5, 0.5), 'move', 0.2, 0.1), box(0.3, 0.2, 0.5, 0.5));
  assert.deepEqual(dragBox(box(0.1, 0.1, 0.5, 0.5), 'move', -5, -5), box(0, 0, 0.5, 0.5), 'pushed off the left edge it stops at the edge');
  assert.deepEqual(dragBox(box(0.1, 0.1, 0.5, 0.5), 'move', 5, 5), box(0.5, 0.5, 0.5, 0.5), 'and the right edge, keeping its size');
});

test('a corner resizes the box and never turns it inside out', () => {
  const b = box(0.2, 0.2, 0.6, 0.6);
  assert.deepEqual(dragBox(b, 'se', -5, -5), box(0.2, 0.2, MIN_BOX, MIN_BOX), 'dragged past itself it stops at the smallest size');
  const nw = dragBox(b, 'nw', 5, 5);
  assert.ok(nw.w >= MIN_BOX && nw.h >= MIN_BOX && nw.x + nw.w <= 1, 'the far edge stays put while the near one moves');
  assert.deepEqual(dragBox(b, 'ne', 5, 0).w, 0.8, 'widened to the right it stops at the edge of the picture');
});

test('a box becomes whole pixels that are always inside the picture and never empty', () => {
  assert.deepEqual(boxPixels(box(0.25, 0.5, 0.5, 0.5), 800, 600), { x: 200, y: 300, w: 400, h: 300 });
  assert.deepEqual(boxPixels(box(0.999, 0.999, 0.5, 0.5), 100, 100), { x: 99, y: 99, w: 1, h: 1 }, 'a box at the far corner keeps one pixel');
  const p = boxPixels(box(0, 0, 1, 1), 1, 1);
  assert.deepEqual(p, { x: 0, y: 0, w: 1, h: 1 });
});

test('the mosaic is coarse enough that what it covers cannot be read back', () => {
  assert.equal(mosaicStep(140, 140), 10);
  assert.equal(mosaicStep(1400, 700), 100, 'the squares grow with the area, so it always looks like about fourteen of them');
  assert.equal(mosaicStep(20, 10), 8, 'and never get fine enough to leave a face readable');
});

test('a stroke drops points that land on top of the last one, and stays inside the picture', () => {
  let s: Stroke = { colour: '#fff', width: 0.01, points: [] };
  s = addPoint(s, 0.5, 0.5);
  s = addPoint(s, 0.5005, 0.5);          // a hand resting still
  assert.equal(s.points.length, 1);
  s = addPoint(s, 0.6, 0.5);
  assert.equal(s.points.length, 2);
  s = addPoint(s, 2, -2);
  assert.deepEqual(s.points[2], [1, 0]);
});

test('the two ends of a trim stay in order and at least half a second apart', () => {
  assert.deepEqual(clampRange(2, 8, 10), { start: 2, end: 8 });
  assert.deepEqual(clampRange(5, 5, 10, 'end'), { start: 5, end: 5 + MIN_CLIP }, 'pushing the end onto the start moves the end');
  assert.deepEqual(clampRange(5, 5, 10, 'start'), { start: 5 - MIN_CLIP, end: 5 }, 'pushing the start onto the end moves the start');
  assert.deepEqual(clampRange(-3, 99, 10), { start: 0, end: 10 }, 'neither end leaves the clip');
  const tiny = clampRange(0, 0, 0.2);
  assert.ok(tiny.end <= 0.2, 'a clip shorter than the minimum is simply itself');
});

test('a range that covers the whole clip counts as no cut at all', () => {
  assert.ok(isWholeClip(0, 10, 10));
  assert.ok(isWholeClip(0.02, 9.98, 10), 'a handle a frame away from the end is still the whole clip');
  assert.ok(!isWholeClip(1, 10, 10));
});

test('recording picks the first container the browser admits to, and names the file after it', () => {
  assert.equal(pickMime(m => m === 'video/webm'), 'video/webm');
  assert.equal(pickMime(() => true), VIDEO_MIMES[0], 'mp4 first, because every phone plays it');
  assert.equal(pickMime(() => false), null, 'a browser that can record nothing is told so, not guessed at');
  assert.equal(clipName('holiday.MOV', 'video/mp4'), 'holiday.mp4');
  assert.equal(clipName('holiday.MOV', 'video/webm;codecs=vp9,opus'), 'holiday.webm');
});

test('times read as minutes and seconds', () => {
  assert.equal(secs(0), '0:00');
  assert.equal(secs(9.7), '0:09');
  assert.equal(secs(75), '1:15');
  assert.equal(secs(-4), '0:00');
});
