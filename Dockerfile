# Build the plugin on Node 22 (matches this repo's engines requirement), then
# install it into the official signalk-server image the same declarative way
# real plugin deployments do it. See:
# https://github.com/SignalK/signalk-server/blob/master/docker/README.md
FROM node:22-alpine AS build
WORKDIR /build
COPY . .
RUN npm install && npm run build && npm prune --omit=dev

FROM cr.signalk.io/signalk/signalk-server:latest
# Baked outside /home/node/.signalk: that path is normally bind-mounted for
# persistence, which would otherwise shadow a plugin copied directly into it.
# The entrypoint installs it into the mounted volume on first run instead.
COPY --from=build --chown=node:node /build /opt/signalk-persistent-notifier
COPY --chown=node:node --chmod=755 docker-entrypoint.sh /home/node/docker-entrypoint.sh
ENTRYPOINT ["/home/node/docker-entrypoint.sh"]
