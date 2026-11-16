// Entry point for hosts that launch a plain .js file (Plesk/Passenger, cPanel Node, most panels).
//
// `pnpm start` runs the server through tsx directly, but a panel asks for a startup FILE and runs
// it itself. This registers tsx's loader through tsx's own API, then hands over to the real server,
// so one codebase serves both ways with no separate build step to forget.
//
// This file is ESM ("type": "module") and must stay free of TOP-LEVEL AWAIT. Passenger loads the
// startup file with require(), and require() of an ESM graph that awaits at the top level throws
// ERR_REQUIRE_ASYNC_MODULE - which reaches the visitor as a bare 500 with nothing in the logs.
// The await lives inside the dynamic import's promise instead, where require() is happy.
import { register } from 'tsx/esm/api';

register();

import('./server/index.ts').catch(err => {
  console.error('[thikra] the server failed to start:', err);
  process.exit(1);
});
