# Diamond Protocol: one small container. The database lives on a mounted disk at /data.
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=3000 \
    DB_FILE=/data/diamond.db \
    BACKUP_DIR=/data/backups \
    TRUST_PROXY=true
WORKDIR /app
# No dependencies to install: the app uses only what ships with Node.
COPY package.json ./
COPY src ./src
COPY public ./public
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "--no-warnings=ExperimentalWarning", "src/index.js"]
