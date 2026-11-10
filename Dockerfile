FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
RUN mkdir -p data && chown -R node:node /app
USER node
ENV NODE_ENV=production
ENV PORT=3095
ENV HOST=0.0.0.0
EXPOSE 3095
CMD ["node", "src/main.js"]
