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
  for (const href of ['/app-icons/favicon-32.png', '/app-icons/apple-touch-icon.png']) {
    assert.ok(html.includes(`href="${href}"`), `index.html links ${href}`);
    assert.ok(existsSync(`web/public${href}`), `${href} exists`);
  }
  assert.equal(pngSize('web/public/app-icons/apple-touch-icon.png'), '180x180');
  assert.equal(pngSize('web/public/app-icons/favicon-32.png'), '32x32');
});

test('the icons come from the owner\'s own logo, which is kept in the repository as the source', () => {
  assert.ok(existsSync('brand/source/logo-original.png'), 'the original logo file is kept');
  assert.equal(pngSize('brand/source/logo-original.png'), '462x485');
  assert.ok(!existsSync('web/public/icon.svg'), 'no substitute logo is shipped');
});

/**
 * Apache ships `Alias /icons/ "/usr/share/httpd/icons/"` in its stock configuration - the little
 * images it puts beside filenames in a directory listing. On tamtim.com that alias swallowed every
 * request for our own logo: the file was present and world-readable in the deployed build, but the
 * web server answered 404 for /icons/logo-160.png and 403 for /icons/, and the request never
 * reached the app at all. The sign-in page showed a broken image with no error anywhere to explain
 * it. Any path the server reserves for itself is a path we cannot use, so this keeps us off it.
 */
test('no public asset sits under a path the web server reserves for itself', () => {
  const reserved = ['/icons/', '/manual/', '/cgi-bin/', '/error/', '/doc/'];
  const sources: Array<[string, string]> = [
    ['web/index.html', readFileSync('web/index.html', 'utf8')],
    ['web/public/manifest.webmanifest', readFileSync('web/public/manifest.webmanifest', 'utf8')],
    ['web/public/sw.js', readFileSync('web/public/sw.js', 'utf8')],
  ];
  for (const [name, text] of sources)
    for (const path of reserved)
      assert.ok(!text.includes(`"${path}`) && !text.includes(`'${path}`), `${name} must not serve assets from ${path}`);
  assert.ok(!existsSync('web/public/icons'), 'web/public/icons would be shadowed by Apache\'s own alias');
});

/**
 * A panel host hands its web server a document root and lets it answer from there before the app is
 * asked. On tamtim.com that meant / was served straight off disk: every other address carried the
 * Content-Security-Policy from server/app.ts and the one people type did not - and on a single-page
 * app the first document's policy is the policy for the session. Directories with no index file
 * already fall through to the app, so the build renames the page out of the server's way.
 */
test('the built page is named so no web server serves it instead of the app', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.match(pkg.scripts.build, /seal-html\.mjs/, 'the build seals the page');
  assert.ok(existsSync('scripts/seal-html.mjs'), 'the sealing step exists');
  assert.match(readFileSync('server/index.ts', 'utf8'), /serveStatic\(\{ path: '\.\/dist\/app\.html'/, 'the server serves the sealed page');
  if (existsSync('dist')) {
    assert.ok(!existsSync('dist/index.html'), 'a built dist must not leave an index.html in the document root');
    assert.ok(existsSync('dist/app.html'), 'a built dist has the page under its sealed name');
  }
});
