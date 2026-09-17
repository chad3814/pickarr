# syntax=docker/dockerfile:1

FROM node:24-alpine AS build
WORKDIR /app

# Manifests first so dependency installation caches independently of source.
COPY package.json package-lock.json tsconfig.base.json .oxlintrc.json ./
COPY packages/contract/package.json      packages/contract/
COPY packages/openmetadata/package.json  packages/openmetadata/
COPY packages/plugin-tv/package.json     packages/plugin-tv/
COPY packages/plugin-movie/package.json  packages/plugin-movie/
COPY packages/plugin-xxx/package.json    packages/plugin-xxx/
COPY packages/host/package.json          packages/host/
COPY packages/web/package.json           packages/web/
RUN npm ci

COPY . .

# Build only. Linting and typechecking are CI's job, and running them here as
# well bought nothing: every image build repeated them, and the coupling was
# not free — adding a dev-only browser-test workspace broke the *production*
# image, because `npm run typecheck --workspaces` found a package the image
# neither builds nor ships and whose dependencies it had no reason to install.
# An image build should fail when the image cannot be built.
#
# Targeted, not `npm run build`: the root script also names `plugin-api`,
# `plugin-scenes` and `core` — 1.x's workspaces, whose manifests this image
# never copied above — so the root script would fail on a missing workspace
# rather than building the 2.0 image this Dockerfile ships.
RUN npm run build \
      -w @pickarr/contract \
      -w @pickarr/openmetadata \
      -w @pickarr/plugin-tv \
      -w @pickarr/plugin-movie \
      -w @pickarr/plugin-xxx \
      -w @pickarr/host \
      -w @pickarr/web

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/contract/package.json      packages/contract/
COPY packages/openmetadata/package.json  packages/openmetadata/
COPY packages/plugin-tv/package.json     packages/plugin-tv/
COPY packages/plugin-movie/package.json  packages/plugin-movie/
COPY packages/plugin-xxx/package.json    packages/plugin-xxx/
COPY packages/host/package.json          packages/host/

# @pickarr/web is deliberately excluded: it ships as prebuilt static assets, so
# react and vite have no business in the runtime image.
RUN npm ci --omit=dev \
      --include-workspace-root \
      --workspace @pickarr/contract \
      --workspace @pickarr/openmetadata \
      --workspace @pickarr/plugin-tv \
      --workspace @pickarr/plugin-movie \
      --workspace @pickarr/plugin-xxx \
      --workspace @pickarr/host \
    && npm cache clean --force

COPY --from=build /app/packages/contract/dist      packages/contract/dist
COPY --from=build /app/packages/openmetadata/dist  packages/openmetadata/dist
COPY --from=build /app/packages/plugin-tv/dist     packages/plugin-tv/dist
COPY --from=build /app/packages/plugin-movie/dist  packages/plugin-movie/dist
COPY --from=build /app/packages/plugin-xxx/dist    packages/plugin-xxx/dist
COPY --from=build /app/packages/host/dist          packages/host/dist
COPY --from=build /app/packages/web/dist           packages/host/dist/web

ENV PICKARR_CONFIG=/config/pickarr.config.json
EXPOSE 8787

# Reads the port out of the config the way boot does, rather than guessing it.
# See `resolveHealthPort`: the `node -e` one-liner this replaces could not
# import anything, so it fell back to a hardcoded port and called every
# config-set port unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "packages/host/dist/healthcheck.js"]

CMD ["node", "packages/host/dist/bin.js"]
