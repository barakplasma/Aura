# Aura, served as static files — for the homelab (homelab-manifests/apps/aura).
# The PWA needs no backend: a small Go file server (deploy/server) in front of
# the `npm run build` output. Traefik does the routing.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: onnxruntime-node's postinstall downloads native binaries the
# browser-only build never uses.
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM golang:1.24-alpine AS server
WORKDIR /src
COPY deploy/server/ .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /aura-server .

FROM scratch
COPY --from=server /aura-server /aura-server
COPY --from=build /app/public /srv
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/aura-server"]
