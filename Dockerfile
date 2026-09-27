# Diamond Protocol: one small container. The database lives on a mounted disk at /data.
FROM node:22-alpine
# dp.db (not diamond.db): the first version of the app used /data/diamond.db with a different layout.
ENV NODE_ENV=production \
    PORT=3000 \
    DB_FILE=/data/dp.db \
    BACKUP_DIR=/data/dp-backups \
    TRUST_PROXY=true
WORKDIR /app
# No dependencies to install: the app uses only what ships with Node.
COPY package.json ./
COPY src ./src
COPY public ./public
# Runs as root: the Render disks were created by the first version (as root), so a restricted user couldn't write to them.
RUN mkdir -p /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
# DP_DEMO=1 (staging): load the sample data into an empty database before starting. The seed refuses to run twice.
CMD ["sh", "-c", "if [ \"$DP_DEMO\" = \"1\" ]; then node --no-warnings=ExperimentalWarning src/seed.js; fi; exec node --no-warnings=ExperimentalWarning src/index.js"]
