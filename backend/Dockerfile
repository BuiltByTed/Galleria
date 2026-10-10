# Backend Dockerfile (DEPRECATED - use root Dockerfile instead)
# This standalone backend Dockerfile is kept for compatibility but the root Dockerfile is preferred
FROM node:22-alpine

# Install build dependencies for better-sqlite3 and sharp, plus wget for health checks, ffmpeg for video processing
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    vips-dev \
    wget \
    ffmpeg

WORKDIR /app

# Copy package files for workspace
COPY package*.json ./
COPY backend/package*.json ./backend/
COPY frontend/package*.json ./frontend/

# Install ALL dependencies via root workspace
RUN npm ci && \
    echo "✓ Workspace dependencies installed" && \
    ls -la node_modules/cors node_modules/express || (echo "ERROR: Backend dependencies missing!" && exit 1)

# Rebuild native modules for correct architecture
RUN npm rebuild better-sqlite3 --build-from-source

# Install tsx globally to run TypeScript directly
RUN npm install -g tsx

# Copy source code
COPY backend/ ./backend/
COPY scripts/ ./scripts/
COPY config/ ./config/
COPY shared/ ./shared/

# Expose port
EXPOSE 3001

# Set working directory to backend
WORKDIR /app/backend

# Use tsx to run TypeScript directly (no compilation needed)
CMD ["tsx", "src/server.ts"]

