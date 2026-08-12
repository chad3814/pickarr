# syntax=docker/dockerfile:1

FROM node:24-alpine AS build
WORKDIR /app

# Manifests first so dependency installation caches independently of source.
COPY package.json package-lock.json tsconfig.base.json .oxlintrc.json ./
COPY packages/plugin-api/package.json   packages/plugin-api/
COPY packages/plugin-scenes/package.json packages/plugin-scenes/
COPY packages/core/package.json          packages/core/
COPY packages/web/package.json           packages/web/
RUN npm ci

COPY . .

# Build only. Linting and typechecking are CI's job, and running them here as
# well bought nothing: every image build repeated them, and the coupling was
# not free — adding a dev-only browser-test workspace broke the *production*
# image, because `npm run typecheck --workspaces` found a package the image
# neither builds nor ships and whose dependencies it had no reason to install.
# An image build should fail when the image cannot be built.
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/plugin-api/package.json    packages/plugin-api/
COPY packages/plugin-scenes/package.json packages/plugin-scenes/
COPY packages/core/package.json          packages/core/

# @pickarr/web is deliberately excluded: it ships as prebuilt static assets, so
# react and vite have no business in the runtime image.
RUN npm ci --omit=dev \
      --include-workspace-root \
      --workspace @pickarr/plugin-api \
      --workspace @pickarr/plugin-scenes \
      --workspace @pickarr/core \
    && npm cache clean --force

COPY --from=build /app/packages/plugin-api/dist    packages/plugin-api/dist
COPY --from=build /app/packages/plugin-scenes/dist packages/plugin-scenes/dist
COPY --from=build /app/packages/core/dist          packages/core/dist
COPY --from=build /app/packages/web/dist           packages/core/dist/web

ENV PICKARR_CONFIG=/config/config.json
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PICKARR_PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/core/dist/main.js"]
