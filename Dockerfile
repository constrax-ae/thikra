# Thekra server + built web app in one image.
# NOT TESTED: Docker was not available where this was written. Build it once (`docker build -t thikra .`) and run the smoke test in docs/DEPLOY.md before relying on it.
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8787 THIKRA_DB=/data/thikra.db THIKRA_BLOBS=/data/blobs THIKRA_BACKUPS=/data/backups
RUN corepack enable
COPY --from=build /app /app
# Everything that must survive a restart lives in /data: mount a volume there, and copy it elsewhere (backups on the same disk do not survive losing it).
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8787
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://localhost:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm", "start"]
