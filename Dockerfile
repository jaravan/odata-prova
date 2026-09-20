FROM node:22-alpine

WORKDIR /app

# Corepack ships with the node image but is disabled by default; enabling it makes `yarn`
# resolve to the version pinned in package.json's "packageManager" field instead of the
# classic yarn 1.x that would otherwise run and reject this repo's yarn 4 lockfile.
RUN corepack enable

COPY package.json yarn.lock .yarnrc.yml ./
RUN yarn install --immutable

COPY server.js ./
COPY lib ./lib
# The bundled model. To serve a different one, mount a directory containing metadata.xml
# (+ optional data/) anywhere in the container and point MODEL_DIR at it.
COPY model ./model

# node:22-alpine already ships an unprivileged "node" user (uid 1000).
USER node

ENV PORT=3000
# V2_PATH / V4_PATH default to /odata/v2/<SERVICE_NAME> and /odata/v4/<SERVICE_NAME>, where
# SERVICE_NAME defaults to the basename of MODEL_DIR. Set either to "" to switch it off.
EXPOSE 3000

# MODEL_DIR isn't hardcoded to a model name: it defaults to whichever single directory got
# copied into ./model above, so this image works unmodified for any bundled model. Pass -e
# MODEL_DIR=... to override, same as before.
CMD ["sh", "-c", "MODEL_DIR=\"${MODEL_DIR:-/app/model/$(ls /app/model)}\" exec node server.js"]