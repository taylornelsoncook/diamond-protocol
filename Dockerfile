FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DP_DATA_DIR=/data
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
VOLUME /data
EXPOSE 3000
CMD ["node", "server/index.js"]
