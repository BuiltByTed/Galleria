#!/bin/sh
set -e

# Use PM2 to manage processes in Docker
cd /app

# Preserve the original Unraid /app/data mount and explicit /data deployments.
export DATA_DIR="${DATA_DIR:-/app/data}"

# Ensure data directory structure exists
echo "Ensuring data directory structure..."
mkdir -p "$DATA_DIR/photos"
mkdir -p "$DATA_DIR/optimized"
mkdir -p "$DATA_DIR/logs"
echo "✓ Data directories ready"

# Download GeoIP database if it doesn't exist (for failed login location tracking)
if [ ! -f "$DATA_DIR/GeoLite2-City.mmdb" ]; then
    echo "Downloading GeoIP database for location lookup..."
    
    # Get current year and month
    YEAR=$(date +%Y)
    MONTH=$(date +%m)
    GEOIP_URL="https://download.db-ip.com/free/dbip-city-lite-${YEAR}-${MONTH}.mmdb.gz"
    
    # Download and extract
    if wget -T 15 -t 1 -qO- "$GEOIP_URL" | gunzip > "$DATA_DIR/GeoLite2-City.mmdb" 2>/dev/null; then
        echo "✓ GeoIP database downloaded successfully"
    else
        echo "⚠ Failed to download GeoIP database. Location lookup will be disabled."
        echo "  You can manually download from https://db-ip.com/db/download/ip-to-city-lite"
        echo "  and save it as /data/GeoLite2-City.mmdb"
    fi
else
    echo "✓ GeoIP database already exists"
fi

# Generate pre-rendered homepage HTML if config and database exist
# Environment variables from docker-compose.yml (BACKEND_DOMAIN, FRONTEND_DOMAIN) 
# are automatically available in the container
if [ -f "$DATA_DIR/config.json" ] && [ -f "$DATA_DIR/gallery.db" ]; then
    echo "Generating pre-rendered homepage HTML..."
    if node scripts/generate-homepage-html.js; then
        echo "✓ Homepage HTML generated successfully"
    else
        echo "⚠ Homepage HTML generation failed (site will use dynamic rendering)"
    fi
else
    echo "⚠ Skipping homepage HTML generation (system not configured yet)"
fi

# Run all database migrations automatically
echo "Running database migrations..."
if node scripts/run-all-migrations.js; then
    echo "✓ Database migrations completed"
else
    echo "⚠ Some migrations failed (continuing anyway)"
fi

# Generate static JSON files if config exists
if [ -f "$DATA_DIR/config.json" ]; then
    echo "Generating static JSON files..."
    if node scripts/generate-static-json.js; then
        echo "✓ Static JSON generated successfully"
    else
        echo "⚠ Static JSON generation failed (site will use API fallback)"
    fi
fi

# Copy Docker PM2 config to ecosystem.config.cjs (PM2 requires this name)
cp ecosystem.docker.cjs ecosystem.config.cjs

# Start both services
pm2 start ecosystem.config.cjs

# Keep container running and show logs
pm2 logs --lines 0

