# Aura, served as static files — for the homelab (homelab-manifests/apps/aura).
# The PWA needs no backend: this is nginx in front of the `npm run build` output.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: onnxruntime-node's postinstall downloads native binaries the
# browser-only build never uses.
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY deploy/aura/nginx.conf deploy/aura/isolation.inc /etc/nginx/conf.d/
COPY --from=build /app/public /usr/share/nginx/html
EXPOSE 8080
