# Pinned by digest for reproducible builds. Update: docker buildx imagetools inspect node:24-alpine
# Node 24: node:sqlite (--persist) prints an ExperimentalWarning on 22
ARG NODE_IMAGE=node:24.22.1-alpine3.24@sha256:6a1c190e17215d844926b0677f4bf87273ff7d5e54db06d3b5b5863ab0b09a3d

# ---- builder ----
FROM ${NODE_IMAGE} AS builder

WORKDIR /app

# Use the yarn version pinned in package.json "packageManager"
RUN corepack enable

COPY package.json yarn.lock .yarnrc.yml ./
# install --immutable verifies yarn.lock (focus alone does not)
RUN yarn install --immutable

# Compile the TypeScript sources to dist/, then drop the devDependencies the build needed
COPY tsconfig.json tsconfig.build.json server.ts mock-data.ts ./
COPY lib ./lib
RUN yarn build && yarn workspaces focus --all --production

# ---- runtime ----
FROM ${NODE_IMAGE}

LABEL org.opencontainers.image.title="odata-prova" \
      org.opencontainers.image.description="Mock OData V2 and V4 server generated from a metadata.xml" \
      org.opencontainers.image.licenses="Apache-2.0"

WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
# The compiled JavaScript: /app/server.js, /app/mock-data.js and /app/lib. package.json makes
# them ES modules.
COPY --from=builder /app/dist ./
COPY package.json ./

# Where --persist keeps the data: PERSIST=/state/<name>.db, with a volume at /state. Owned by
# the user the server runs as, so a named volume mounted there can be written to.
RUN mkdir /state && chown node:node /state

USER node

ENV PORT=3000
EXPOSE 3000

# No model in the image. Mount one at /models/<ServiceName> (the folder name is the service
# name); with several, set MODEL_DIR to one. Startup fails with a clear message if none is found.
ENV MODEL_DIR=/models
CMD ["node", "server.js"]