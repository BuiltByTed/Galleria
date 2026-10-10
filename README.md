# Galleria

A modern photography portfolio website built with React 19, TypeScript, Express 5, and SQLite. Features optimized image delivery, admin panel, analytics tracking, and responsive design.

**🌐 Live Demo:** [tedcharles.net](https://tedcharles.net)

---

## 🐳 Docker Hub

Pre-built Docker images are available on Docker Hub: **[hub.docker.com/r/tedcharles/galleria](https://hub.docker.com/r/tedcharles/galleria)**

```bash
# Pull latest production image
docker pull tedcharles/galleria:latest

# Pull latest development image
docker pull tedcharles/galleria:dev

# Pull specific version
docker pull tedcharles/galleria:v1.2.0
```

**Quick Start with Docker Hub image:**

```bash
# Create data directory
mkdir -p ~/galleria-data

# Run with Docker
docker run -d \
  --name galleria \
  -p 3000:3000 \
  -v ~/galleria-data:/data \
  -e DATA_DIR=/data \
  tedcharles/galleria:latest
```

Open `http://YOUR-SERVER-IP:3000` and create a username and password. No email address, DNS setup, or second exposed port is required. Email is requested only when you choose Google sign-in. Local accounts can use MFA and passkeys; email password recovery requires an email-based account.

For Nginx Proxy Manager, create one proxy host pointing to your server's WebUI port, using HTTP upstream, and enable SSL. No custom API location is needed. For plain nginx:

```nginx
server {
    listen 443 ssl;
    server_name photos.example.com;
    # Configure your ssl_certificate and ssl_certificate_key here.
    client_max_body_size 0;
    location / {
        proxy_pass http://YOUR-SERVER-IP:3000;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Host $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

`DOMAIN=https://photos.example.com` is optional. Leaving it blank uses your browser's origin. If your public hostname changes after setup, set `DOMAIN` to update generated links and Google/passkey origins.

**Upgrading existing Unraid/Docker installations:** keep your current volumes, port mappings, and environment variables. `/app/data` remains the default for existing Unraid templates; installations using `DATA_DIR=/data` remain supported. Existing email/password accounts keep their logins and data. `FRONTEND_DOMAIN`, `BACKEND_DOMAIN`, `API_URL`, `ALLOWED_ORIGINS`, and saved split-domain API URLs remain supported. To intentionally switch an existing split-domain installation to one domain, remove `BACKEND_DOMAIN`/`API_URL`, set `DOMAIN` to the public URL, and point the reverse proxy to port 3000. Update your Google OAuth redirect URI if you use Google sign-in.

| Variable | Default / purpose |
| --- | --- |
| `DOMAIN` | Optional public URL; blank for automatic same-origin access |
| `FRONTEND_DOMAIN` | Legacy frontend URL override |
| `BACKEND_DOMAIN` / `API_URL` | Legacy public API URL; explicit values preserve split-domain access |
| `BACKEND_INTERNAL_URL` | Internal proxy target; defaults to `http://127.0.0.1:3001` |
| `DATA_DIR` | `/app/data` in Docker unless explicitly set, e.g. `/data` |
| `ALLOWED_ORIGINS` | Optional additional allowed browser origins |

**Available tags:**

- `:latest` - Latest production build
- `:dev` - Latest development build
- `:vX.Y.Z` - Specific version (e.g., `:v1.2.3`)

---

## Quick Start

### Prerequisites

- **Node.js** 22+ (for development)
- **Docker & Docker Compose** (for Docker deployment)
- **Google OAuth credentials** (optional - password-based authentication works without it)

---

## 🚀 Getting Started

### Option 1: Docker (Recommended)

**Single container deployment with PM2 process management.**

1. **Clone the repository:**

```bash
git clone https://github.com/theodorecharles/Galleria.git
cd Galleria
```

2. **Create a data directory:**

```bash
mkdir -p ~/galleria-data
```

3. **Configure environment variables** in `docker-compose.yml`:

```yaml
environment:
  - DATA_DIR=/data
  - DOMAIN= # Optional, e.g. https://photos.yourdomain.com
volumes:
  - ~/galleria-data:/data
```

4. **Build and start:**

```bash
docker-compose up -d --build
```

5. **Access the application:**

- Frontend: http://localhost:3000
- Admin Panel: http://localhost:3000/admin

---

### Option 2: Development Setup

1. **Clone and install dependencies:**

```bash
git clone https://github.com/theodorecharles/Galleria.git
cd Galleria
npm install
cd backend && npm install
cd ../frontend && npm install
cd ..
```

2. **Start the development server:**

```bash
npm run dev
```

3. **Open your browser:**
   Navigate to `http://localhost:3000` - the setup wizard will guide you through initial configuration.

---

## 📦 Production Deployment

### Using PM2

```bash
# Build both frontend and backend
npm run build

# Install PM2 globally
npm install -g pm2

# Start services
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

### Using Docker

See [Docker Deployment](#option-1-docker-recommended) section above.

### Automated Deployment

**Via GitHub Actions:**

Push to `master` (prod) or `devel` branch, and GitHub Actions automatically deploys.

**Manual deployment:**

```bash
git pull origin <branch>
./restart.sh
```

The `restart.sh` script handles:

- Install all dependencies
- Optimize all images
- Build both frontend and backend
- Restart services via PM2

---

## 🎬 Hardware Video Encoding

Galleria supports hardware-accelerated video encoding for faster video processing using your GPU.

### Supported Hardware

- **NVIDIA GPUs** (NVENC) - Docker and native
- **Intel Quick Sync Video** (QSV) - Native only
- **AMD GPUs** (AMF) - Native only
- **Apple VideoToolbox** - macOS native only
- **VA-API** - Linux native only

### Docker Setup (NVIDIA GPUs)

**Prerequisites:**
1. NVIDIA GPU with driver installed on host
2. NVIDIA Container Toolkit installed: [Installation Guide](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)

**Enable in `docker-compose.yml`:**

```yaml
services:
  app:
    runtime: nvidia  # Enable NVIDIA runtime
    environment:
      - NVIDIA_VISIBLE_DEVICES=all
      - NVIDIA_DRIVER_CAPABILITIES=compute,video,utility
```

### Non-Docker Setup

Hardware encoding automatically detects and uses available GPU encoders on your system. No special configuration needed - just ensure GPU drivers are installed.

### Enable Hardware Encoding

1. Navigate to **Admin Panel → Settings → Video Quality**
2. Toggle **Hardware Transcoding** to enabled
3. Video processing will now use GPU acceleration when available

**Performance:** Hardware encoding can be 5-10x faster than software encoding, especially for high-resolution videos.

---

## ⚙️ Configuration

Configuration is managed through environment variables or the admin panel - you don't need to edit config files directly.

### Docker Deployment

Configure via environment variables in `docker-compose.yml`:

```yaml
environment:
  - DATA_DIR=/data
  - DOMAIN= # Optional, e.g. https://photos.yourdomain.com
```

### Non-Docker Deployment

1. **Copy the example environment file:**

   ```bash
   cp .env.example .env
   ```

2. **Edit `.env` with your settings:**
   ```bash
   DOMAIN= # Optional public URL
   DATA_DIR=./data
   ```

After initial setup, all configuration is managed through the **Admin Panel** at `/admin` → Settings.

### Google OAuth Setup (Optional)

Google OAuth is completely optional. You can use password-based authentication without any OAuth setup.

**To enable Google OAuth login:**

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create OAuth 2.0 credentials
3. Add authorized redirect URIs:
   - Single-domain: `https://photos.yourdomain.com/api/auth/google/callback`
   - Local: `http://localhost:3000/api/auth/google/callback`
   - Existing split-domain: keep your backend URL, e.g. `https://api.yourdomain.com/api/auth/google/callback`
4. Configure OAuth credentials in Admin Panel → Settings → Advanced Settings → Authentication

---

## 📸 Adding Photos

1. Navigate to `/admin`
2. Select album → Upload Photos
3. Images auto-optimize in background

---

## 🛠️ Common Tasks

**View logs (PM2):**

```bash
pm2 logs
```

**View logs (Docker):**

```bash
docker exec galleria pm2 logs
```

**Restart services:**

```bash
pm2 restart all
# or
docker-compose restart
```

**Optimize images:**

```bash
node scripts/optimize_all_images.js
```

---

## 📚 Project Structure

```
galleria/
├── backend/              # Express API
│   ├── src/
│   │   ├── server.ts    # Main server
│   │   └── routes/      # API endpoints
│   └── package.json
├── frontend/            # React app
│   ├── src/
│   └── package.json
├── data/                # Data directory (not in Git)
│   ├── config.json      # Configuration (auto-generated, managed via admin panel)
│   ├── photos/          # Original photos
│   ├── optimized/       # Generated images
│   └── gallery.db       # SQLite database
├── .env.example         # Environment variables template (copy to .env)
├── scripts/             # Utility scripts
├── Dockerfile           # Docker container
├── docker-compose.yml   # Docker Compose config
└── package.json         # Root dependencies
```

---

## 🔒 Security

- ✅ CSRF protection on all mutations
- ✅ Rate limiting (configurable)
- ✅ Input validation and sanitization
- ✅ Path traversal protection
- ✅ Security headers (Helmet)
- ✅ HTTPS enforcement in production
- ✅ Multiple auth methods (OAuth, password, passkey)
- ✅ Role-based access control (viewer, manager, admin)

---

## 🌍 Internationalization

Galleria supports **37 languages** with full UI and SEO localization:

- 🇺🇸 English
- 🇪🇸 Spanish
- 🇫🇷 French
- 🇵🇹 Portuguese
- 🇷🇺 Russian
- 🇩🇪 German
- 🇹🇷 Turkish
- 🇮🇹 Italian
- 🇵🇱 Polish
- 🇺🇦 Ukrainian
- 🇷🇴 Romanian
- 🇳🇱 Dutch
- 🇬🇷 Greek
- 🇭🇺 Hungarian
- 🇨🇿 Czech
- 🇪🇸 Catalan
- 🇸🇪 Swedish
- 🇧🇬 Bulgarian
- 🇷🇸 Serbian
- 🇩🇰 Danish
- 🇫🇮 Finnish
- 🇳🇴 Norwegian
- 🇸🇰 Slovak
- 🇭🇷 Croatian
- 🇱🇹 Lithuanian
- 🇸🇮 Slovenian
- 🐑 Basque
- 🏛️ Latin
- 🇨🇳 Chinese (Simplified)
- 🇮🇩 Indonesian
- 🇯🇵 Japanese
- 🇻🇳 Vietnamese
- 🇰🇷 Korean
- 🇵🇭 Filipino
- 🇹🇭 Thai
- 🇲🇾 Malay
- 🇲🇲 Burmese

### Changing Language

1. Navigate to **Admin Panel → Settings → Branding**
2. Select your preferred language from the dropdown
3. The entire site (including SEO meta tags) updates instantly

The selected language applies to:
- All UI elements and buttons
- Navigation and menus
- Admin panel
- SEO titles and descriptions
- Error messages and notifications

---

## 🔗 Links

- **📦 Repository:** [github.com/theodorecharles/Galleria](https://github.com/theodorecharles/Galleria)
- **🐛 Issues:** [GitHub Issues](https://github.com/theodorecharles/Galleria/issues)
- **📧 Contact:** [me@tedcharles.net](mailto:me@tedcharles.net)

---

**Built by [Ted Charles](https://tedcharles.net) with React, TypeScript, and Express**
