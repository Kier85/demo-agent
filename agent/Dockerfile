FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY eval ./eval
USER node
ENV PORT=3000
EXPOSE 3000
CMD ["node", "src/server.ts"]
