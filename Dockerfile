# Pinned by digest for reproducible builds. Update: docker buildx imagetools inspect node:22-alpine
ARG NODE_IMAGE=node:22.23.3-alpine3.24@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

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

USER node

ENV PORT=3000
EXPOSE 3000

# No model in the image. Mount one at /models/<ServiceName> (the folder name is the service
# name); with several, set MODEL_DIR to one. Startup fails with a clear message if none is found.
ENV MODEL_DIR=/models
CMD ["node", "server.js"]