import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('web/public/manifest.webmanifest', 'utf8'));
const pngSize = (path: string) => {
  const b = readFileSync(path);
  assert.equal(b.subarray(1, 4).toString(), 'PNG', `${path} is a PNG`);
  return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`; // width and height from the IHDR chunk
};

test('every icon the manifest promises exists, at the size it declares', () => {
  for (const icon of manifest.icons as Array<{ src: string; sizes: string; type: string }>) {
    const file = `web/public${icon.src}`;
    assert.ok(existsSync(file), `${icon.src} exists`);
    assert.equal(pngSize(file), icon.sizes, icon.src);
  }
});

test('the installable app has a normal and a maskable icon, and the page links the favicon and the touch icon', () => {
  const purposes = (manifest.icons as Array<{ purpose: string }>).map(i => i.purpose);
  assert.ok(purposes.includes('any') && purposes.includes('maskable'));
  const html = readFileSync('web/index.html', 'utf8');
  for (const href of ['/icons/favicon-32.png', '/icons/apple-touch-icon.png']) {
    assert.ok(html.includes(`href="${href}"`), `index.html links ${href}`);
    assert.ok(existsSync(`web/public${href}`), `${href} exists`);
  }
  assert.equal(pngSize('web/public/icons/apple-touch-icon.png'), '180x180');
  assert.equal(pngSize('web/public/icons/favicon-32.png'), '32x32');
});

test('the icons come from the owner\'s own logo, which is kept in the repository as the source', () => {
  assert.ok(existsSync('brand/source/logo-original.png'), 'the original logo file is kept');
  assert.equal(pngSize('brand/source/logo-original.png'), '462x485');
  assert.ok(!existsSync('web/public/icon.svg'), 'no substitute logo is shipped');
});
