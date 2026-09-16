ARG SIGNALK_SERVER_IMAGE=cr.signalk.io/signalk/signalk-server:v2.31.1

# Keep the compiler image deterministic and copy only package inputs. In
# particular, never put the persistent Signal K data directory in an image.
FROM node:22.14.0-alpine3.21 AS build
WORKDIR /build
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY README.md LICENSE ./
RUN npm run build && npm prune --omit=dev

FROM ${SIGNALK_SERVER_IMAGE} AS runtime
# Baked outside /home/node/.signalk: that path is normally bind-mounted for
# persistence, which would otherwise shadow a plugin copied directly into it.
# The entrypoint installs it into the mounted volume on first run instead.
COPY --from=build --chown=node:node /build/package.json /build/README.md /build/LICENSE /opt/signalk-alert-center/
COPY --from=build --chown=node:node /build/dist /opt/signalk-alert-center/dist
COPY --from=build --chown=node:node /build/public /opt/signalk-alert-center/public
COPY --from=build --chown=node:node /build/node_modules /opt/signalk-alert-center/node_modules
COPY --chown=node:node --chmod=755 docker-entrypoint.sh /home/node/docker-entrypoint.sh
ENTRYPOINT ["/home/node/docker-entrypoint.sh"]

# Test-only target. The default final image does not contain the fixture plugin.
FROM runtime AS acceptance
COPY --chown=node:node test/integration/fixture-plugin /opt/signalk-test-fixture

FROM runtime AS final
