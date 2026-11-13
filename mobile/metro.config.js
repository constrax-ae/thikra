// Metro only watches the project folder, so an import that reaches outside it fails at
// bundle time even when TypeScript is happy. `core/` is the code the web and the phone
// share — the archive agent, the reaction list, the excerpt and email helpers — and it
// lives one level up, so the bundler is told to watch it and to resolve the repo's
// node_modules as well as the app's.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);
// web/src/lang: the 19 machine-translated language packs, shared with the web app.
config.watchFolders = [path.join(repoRoot, 'core'), path.join(repoRoot, 'web', 'src', 'lang')];
config.resolver.nodeModulesPaths = [
  path.join(projectRoot, 'node_modules'),
  path.join(repoRoot, 'node_modules'),
];
// `import … from './reactions.ts'` is how core/ refers to itself (the server runs it that
// way); Metro resolves bare .ts without the extension, so it is added to the source list.
config.resolver.sourceExts = [...new Set([...config.resolver.sourceExts, 'ts', 'tsx'])];

module.exports = config;
