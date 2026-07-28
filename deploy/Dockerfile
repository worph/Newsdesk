# Debian rather than Alpine: better-sqlite3 ships glibc prebuilds, so this
# avoids a node-gyp toolchain in the image.
FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund

COPY shared/ shared/
COPY server/ server/
COPY web/ web/

# shared -> web (built into server/public) -> server
RUN npm run build --workspace shared \
 && npm run build --workspace web \
 && npm run build --workspace server

# Drop dev dependencies from the tree we are about to copy.
RUN npm prune --omit=dev


FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    NEWSDESK_DATA_DIR=/data \
    NEWSDESK_PORT=8080

WORKDIR /app

COPY --from=build /app/node_modules       ./node_modules
COPY --from=build /app/package.json       ./package.json
COPY --from=build /app/shared/dist        ./shared/dist
COPY --from=build /app/shared/package.json ./shared/package.json
COPY --from=build /app/server/dist        ./server/dist
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/drizzle     ./server/drizzle
COPY --from=build /app/server/public      ./server/public

RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.NEWSDESK_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
