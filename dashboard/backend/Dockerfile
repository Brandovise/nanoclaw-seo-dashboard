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

# Set INSTALL_CLAUDE_CODE=1 at build time so the rewrite pipeline can run the Claude Agent SDK
# (requires the native `claude` binary). See dashboard/docker-compose.yml and Anthropic docs:
# https://docs.anthropic.com/en/docs/claude-code/setup
ARG INSTALL_CLAUDE_CODE=0
RUN apt-get update && apt-get install -y --no-install-recommends libsqlite3-0 \
  && if [ "$INSTALL_CLAUDE_CODE" = "1" ]; then \
       apt-get install -y --no-install-recommends curl ca-certificates bash \
       && curl -fsSL https://claude.ai/install.sh | bash; \
     fi \
  && rm -rf /var/lib/apt/lists/*

# Native installer typically places `claude` under root’s ~/.local/bin
ENV PATH="/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --cache /tmp/.npm
COPY --from=build /app/dist ./dist
EXPOSE 3002
CMD ["node", "dist/index.js"]
