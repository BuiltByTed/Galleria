# Standalone frontend image. Build from the repository root with -f frontend/Dockerfile.
# Set BACKEND_INTERNAL_URL=http://backend:3001 for the backend container.
FROM node:22-slim AS builder
WORKDIR /app
COPY package*.json ./
COPY backend/package*.json ./backend/
COPY frontend/package*.json ./frontend/
# Frontend compilation needs no native backend addons.
RUN npm ci --ignore-scripts
COPY frontend/ ./frontend/
COPY shared/ ./shared/
RUN npm run build --workspace=frontend

FROM node:22-slim
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/frontend/dist ./frontend/dist
COPY frontend/package.json frontend/server.js frontend/logger.js frontend/proxy.js ./frontend/
COPY shared/ ./shared/
COPY package.json ./
ENV HOST=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["node", "frontend/server.js"]
