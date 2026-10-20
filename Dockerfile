# Combined Frontend + Backend Dockerfile
# Use Debian-based Node image for better NVIDIA compatibility
FROM node:22-slim
# Mozilla bug 2083449: rebuild the distro store and exclude emSign ECC G3.
COPY security/remove-g3.sh /usr/local/sbin/remove-g3
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/* && sh /usr/local/sbin/remove-g3
ENV NODE_OPTIONS=--use-openssl-ca SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

# Install system dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    wget \
    curl \
    ca-certificates \
    gnupg \
    libvips-dev \
    && rm -rf /var/lib/apt/lists/*

# Install ffmpeg with hwaccel support from official Debian repos
# Note: Debian ffmpeg is compiled with --enable-nvenc but requires NVIDIA drivers at runtime
RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && ffmpeg -version

WORKDIR /app

# Copy package files for workspace
COPY package*.json ./
COPY backend/package*.json ./backend/
COPY frontend/package*.json ./frontend/

# Install ALL dependencies via root workspace (this installs frontend + backend + root deps)
# npm workspaces hoists all dependencies to root node_modules for sharing
RUN npm ci && \
    echo "✓ Workspace dependencies installed" && \
    echo "Verifying dependencies are hoisted to root node_modules..." && \
    ls -la node_modules/sharp node_modules/better-sqlite3 node_modules/openai && \
    ls -la node_modules/cors node_modules/express node_modules/helmet && \
    ls -la node_modules/react node_modules/react-dom && \
    echo "✓ All dependencies verified and hoisted correctly"

# Rebuild native modules for correct architecture
RUN npm rebuild better-sqlite3 --build-from-source

# Install tsx and PM2 globally
RUN npm install -g tsx pm2

# Copy source code
COPY backend/ ./backend/
COPY frontend/ ./frontend/
COPY scripts/ ./scripts/
COPY config/ ./config/

# Generate default favicons from config/icons/ (before frontend build)
# Creates empty data dir so generate-favicons falls back to default icons
RUN mkdir -p ./data && npm run generate-favicons

# Build frontend
RUN npm run build --workspace=frontend

# Expose ports
EXPOSE 3000 3001

# Copy frontend server to frontend directory (where node_modules are)
# Copy startup script and Docker PM2 config
COPY start-docker.sh ./start-docker.sh
COPY ecosystem.docker.cjs ./ecosystem.docker.cjs
RUN chmod +x ./start-docker.sh

# Create logs directory
RUN mkdir -p /data/logs

# Use the startup script
CMD ["./start-docker.sh"]


RUN sh /usr/local/sbin/remove-g3
