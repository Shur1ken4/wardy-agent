# The hosted Wardy Agent: the dashboard and API on one port, with a sandbox per visitor. It never holds a mainnet key
# (scripts/serve.ts refuses to start with one). Build: docker build -t wardy-agent . Run: docker run -p 8080:8080 wardy-agent
FROM node:24.16.0-bookworm-slim

WORKDIR /app
COPY . .
# All dependencies, because the server runs TypeScript directly with tsx, as every other script here does.
RUN npm ci --no-audit --no-fund && npm run build:web

ENV PORT=8080 HOST=0.0.0.0 WARDY_DATA_DIR=/data
EXPOSE 8080
CMD ["node", "--import", "tsx", "scripts/serve.ts"]
