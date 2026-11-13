// Entry point for hosts that launch a plain .js file (Plesk/Passenger, cPanel Node, most panels).
//
// `pnpm start` runs the server through tsx directly, but a panel asks for a startup FILE and runs
// it with plain node. This registers tsx's loader through tsx's own API, then hands over to the
// real server, so one codebase serves both ways with no separate build step to forget.
//
// This file is ESM: package.json sets "type": "module".
import { register } from 'tsx/esm/api';
register();
await import('./server/index.ts');
