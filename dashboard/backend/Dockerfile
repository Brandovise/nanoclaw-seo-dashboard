# Build context: dashboard/backend
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm install --cache /tmp/.npm
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS run
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libsqlite3-0 \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --cache /tmp/.npm
COPY --from=build /app/dist ./dist
EXPOSE 3002
CMD ["node", "dist/index.js"]
