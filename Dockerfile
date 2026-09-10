# ./rethink must already exist in the build context before `docker build` runs - a plain clone or
# a submodule checked out on the host, same as local dev (see README's Setup section). This image
# never fetches it itself; it only packages whatever's on disk at build time.

# Build stage
FROM alpine:3.20 AS build
WORKDIR /app

RUN apk add --no-cache nodejs npm

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build && npm prune --omit=dev

# Production stage
FROM alpine:3.20 AS runtime
WORKDIR /app

# openssl: cloud/thinq2/provisioning.ts's device-onboarding path shells out to it (see
# rethink's util/pki.ts) - it's part of the device converters this adapter runs, not something
# specific to rethink's own cloud tunnel, so it's needed here too even though this adapter opens
# no listening ports or TLS connections of its own.
RUN apk add --no-cache nodejs openssl \
    && addgroup -S app \
    && adduser -S -G app app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY rusthinq-adapter-config.jsonc /app/config.jsonc

RUN mkdir -p /app/data && chown -R app:app /app/data
USER app

# First boot seeds /app/data/config.jsonc from the template so it can be edited in place via a
# volume mount at /app/data; later boots leave an already-edited copy alone.
CMD ["sh", "-c", "[ -f /app/data/config.jsonc ] || cp /app/config.jsonc /app/data/config.jsonc; exec node dist/rusthinq-adapter.js /app/data/config.jsonc"]
