# akebono-office-api（Cloud Run 用）
# ビルドコンテキストはリポジトリルート（shared/domain を含めるため）:
#   docker build -f api/Dockerfile -t akebono-office-api .

FROM node:22-slim AS build
WORKDIR /app
COPY api/package.json api/package-lock.json ./api/
RUN cd api && npm ci
COPY shared ./shared
COPY api ./api
RUN cd api && npm run typecheck && npm run build

FROM node:22-slim AS deps
WORKDIR /app/api
COPY api/package.json api/package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app/api
COPY --from=deps /app/api/node_modules ./node_modules
COPY --from=build /app/api/dist ./dist
COPY --from=build /app/api/package.json ./package.json
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
