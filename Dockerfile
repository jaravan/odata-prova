# Pinned by digest for reproducible builds. Update: docker buildx imagetools inspect node:22-alpine
ARG NODE_IMAGE=node:22.23.3-alpine3.24@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

# ---- builder ----
FROM ${NODE_IMAGE} AS builder

WORKDIR /app

# Use the yarn version pinned in package.json "packageManager"
RUN corepack enable

COPY package.json yarn.lock .yarnrc.yml ./
# install --immutable verifies yarn.lock (focus alone does not); focus drops devDependencies
RUN yarn install --immutable && yarn workspaces focus --all --production

# ---- runtime ----
FROM ${NODE_IMAGE}

WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY package.json server.js ./
COPY lib ./lib
# Bundled model; override by mounting another one and setting MODEL_DIR
COPY model ./model

USER node

ENV PORT=3000
EXPOSE 3000

# MODEL_DIR defaults to the single directory under /app/model
CMD ["sh", "-c", "MODEL_DIR=\"${MODEL_DIR:-/app/model/$(ls /app/model)}\" exec node server.js"]