FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    libstdc++6 \
    zlib1g \
    libssl3 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY src ./src
RUN mkdir -p data && chown -R node:node /app
USER node
ENV NODE_ENV=production
ENV PORT=3095
ENV HOST=0.0.0.0
EXPOSE 3095
CMD ["node", "src/main.js"]
