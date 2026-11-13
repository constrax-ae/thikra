# Thekra server + the built web app in one image.
#
# Three stages so the image that runs in production carries only what production needs: no build tools, no test files, no
# mobile app. The pnpm version is pinned, and corepack only ever runs during a build — never at container start, where a
# registry outage would otherwise stop the app from booting.

# ---- the web app is built here -------------------------------------------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.24.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY core/package.json ./core/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# ---- production dependencies only ----------------------------------------------------------------------------------------
FROM node:22-slim AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.24.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY core/package.json ./core/
RUN pnpm install --prod --frozen-lockfile

# ---- what actually runs --------------------------------------------------------------------------------------------------
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8787 THIKRA_DB=/data/thikra.db THIKRA_BLOBS=/data/blobs THIKRA_BACKUPS=/data/backups
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/core/node_modules ./core/node_modules
COPY --from=build /app/dist ./dist
COPY package.json pnpm-workspace.yaml tsconfig.json ./
COPY server ./server
COPY core ./core
COPY scripts ./scripts
# Everything that must survive a restart lives in /data: mount a volume there, and copy it elsewhere (backups on the same disk do not survive losing it).
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8787
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://localhost:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# tsx straight from node_modules, not `pnpm start`: no corepack, no network, at start-up.
CMD ["node_modules/.bin/tsx", "server/index.ts"]
