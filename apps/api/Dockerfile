# Build from the repo root:  docker build -f apps/api/Dockerfile -t brand-api .
FROM node:24-alpine AS build
RUN npm install -g pnpm@9.15.9
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@brand/api
# Self-contained production bundle: api dist + prod node_modules (incl. built @brand/shared).
RUN pnpm deploy --filter=@brand/api --prod /out

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out .
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
