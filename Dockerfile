FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN BETTER_AUTH_URL=http://localhost:3000 \
    BETTER_AUTH_SECRET=build-only-secret-that-is-never-used-at-runtime \
    NEXUS_MASTER_KEY=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY= \
    NEXUS_BACKUP_SIGNING_KEY=YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY= \
    NEXUS_DATABASE_PATH=:memory: \
    NEXUS_ARTIFACT_ROOT=/tmp/nexus-build-artifacts \
    npm run build

FROM node:22-bookworm-slim AS production-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXUS_DATABASE_PATH=/app/data/nexus.db \
    NEXUS_ARTIFACT_ROOT=/app/data/artifacts
RUN groupadd --system --gid 1001 nexus && useradd --system --uid 1001 --gid nexus nexus && mkdir -p /app/data && chown -R nexus:nexus /app
COPY --from=build --chown=nexus:nexus /app/package.json /app/package-lock.json ./
COPY --from=production-deps --chown=nexus:nexus /app/node_modules ./node_modules
COPY --from=build --chown=nexus:nexus /app/.next ./.next
COPY --from=build --chown=nexus:nexus /app/public ./.next/standalone/public
COPY --from=build --chown=nexus:nexus /app/.next/static ./.next/standalone/.next/static
COPY --from=build --chown=nexus:nexus /app/public ./public
COPY --from=build --chown=nexus:nexus /app/scripts ./scripts
COPY --from=build --chown=nexus:nexus /app/src ./src
COPY --from=build --chown=nexus:nexus /app/db ./db
COPY --from=build --chown=nexus:nexus /app/tsconfig.json ./tsconfig.json
USER nexus
EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["npm", "run", "start:production"]
