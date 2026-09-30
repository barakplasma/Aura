# Aura, served as static files — for the homelab (homelab-manifests/apps/aura).
# The PWA needs no backend: stock Caddy in front of the `npm run build` output.
# Traefik does the routing.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: onnxruntime-node's postinstall downloads native binaries the
# browser-only build never uses.
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM caddy:2-alpine
COPY deploy/caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/public /srv
# Non-root: Caddy needs a writable home for its state even with autohttps off.
ENV XDG_DATA_HOME=/tmp XDG_CONFIG_HOME=/tmp
USER 65532:65532
EXPOSE 8080
