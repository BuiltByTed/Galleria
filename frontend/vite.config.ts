import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { visualizer } from 'rollup-plugin-visualizer';
import fs from 'fs';
import { publicApiUrl, publicSiteUrl } from '../shared/deployment.js';
import path from 'path';

// Load .env file if it exists (for non-Docker deployments)
const envPath = path.resolve(__dirname, '../.env');
const envVars: Record<string, string> = {};

if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      if (key && valueParts.length > 0) {
        const value = valueParts.join('=').trim();
        envVars[key.trim()] = value.replace(/^["']|["']$/g, '');
      }
    }
  });
}

// Default configuration for when config.json doesn't exist
const defaultConfig = {
  environment: {
    frontend: {
      port: 3000,
      // Use BACKEND_DOMAIN from .env if available, otherwise localhost
      apiUrl: ""
    }
  },
  branding: {
    siteName: "Photography Portfolio",
    avatarPath: "/photos/avatar.png"
  },
  analytics: {
    openobserve: {
      enabled: false
    }
  }
};

// Load config.json - the single source of truth
const configPath = path.resolve(__dirname, '../data/config.json');
let config;
let configExists = false;

try {
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    configExists = true;
    console.log('✓ Loaded config.json');
  } else {
    console.log('⚠️  config.json not found - checking .env file');
    config = defaultConfig;
    if (envVars.BACKEND_DOMAIN) {
      console.log(`✓ Using API URL from .env: ${envVars.BACKEND_DOMAIN}`);
    } else {
      console.log('⚠️  No .env file found - using localhost defaults');
    }
  }
} catch (error) {
  console.error('❌ Failed to load config.json, using defaults:', error);
  config = defaultConfig;
}

const envConfig = config.environment;

const deploymentEnv = { ...envVars, ...process.env };
envConfig.frontend.apiUrl = publicApiUrl(envConfig, deploymentEnv);
const siteUrl = publicSiteUrl(envConfig, deploymentEnv) || 'http://localhost:3000';
const isRemoteDev = !new URL(siteUrl).hostname.match(/^(localhost|127\.0\.0\.1)$/);
const hmrHost = new URL(siteUrl).hostname;

if (configExists) {
  console.log('Vite config loaded:');
  console.log('  API URL:', envConfig.frontend.apiUrl);
  console.log('  Site URL:', siteUrl);
  console.log('  Listen host:', isRemoteDev ? '0.0.0.0' : '127.0.0.1');
  console.log('  HMR host:', hmrHost);
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: "primes-rewrite",
      configureServer(server) {
        server.middlewares.use((req: any, _res: any, next: any) => {
          // Rewrite /primes and /primes/ to /primes/index.html
          if (req.url === "/primes" || req.url === "/primes/") {
            req.url = "/primes/index.html";
          }
          next();
        });
      },
    },
    visualizer({
      filename: './dist/stats.html',
      open: false,
      gzipSize: true,
      brotliSize: false,
    }) as any,
  ],
  define: {
    // Inject config values from config.json for both dev and build
    // In OOBE mode, runtime API URL will be injected by server via <script> tag
    'import.meta.env.VITE_API_URL': JSON.stringify(envConfig.frontend.apiUrl),
    'import.meta.env.VITE_SITE_URL': JSON.stringify(siteUrl),
    'import.meta.env.VITE_SITE_NAME': JSON.stringify(config.branding.siteName),
    'import.meta.env.VITE_ANALYTICS_ENABLED': JSON.stringify(String(config.analytics?.openobserve?.enabled || false)),
    // Additional values for HTML meta tags
    'import.meta.env.VITE_SITE_URL_FULL': JSON.stringify(siteUrl),
    'import.meta.env.VITE_API_URL_FULL': JSON.stringify(envConfig.frontend.apiUrl),
    'import.meta.env.VITE_AVATAR_PATH': JSON.stringify(config.branding.avatarPath),
    // Map LOG_LEVEL to VITE_LOG_LEVEL so we only need one variable
    'import.meta.env.VITE_LOG_LEVEL': JSON.stringify(envVars.LOG_LEVEL || 'info'),
  },
  build: {
    cssCodeSplit: false, // CRITICAL: Keep all CSS in one file to prevent loading issues
    rollupOptions: {
      output: {
        manualChunks: {
          // Split React and React-DOM into their own chunk
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          // Split recharts (large charting library) into its own chunk
          'recharts-vendor': ['recharts'],
          // Split admin-only dependencies (drag-and-drop, maps)
          'admin-vendor': [
            '@dnd-kit/core',
            '@dnd-kit/sortable',
            '@dnd-kit/utilities',
            'leaflet',
            'react-leaflet'
          ],
        },
      },
    },
    // Increase chunk size warning limit for AdminPortal (lazy-loaded, 259 KB gzipped)
    chunkSizeWarningLimit: 900,
  },
  css: {
    devSourcemap: true,
  },
  server: {
    host: isRemoteDev ? '0.0.0.0' : '127.0.0.1',
    port: envConfig.frontend.port || 3000,
    strictPort: false,
    proxy: Object.fromEntries(['/api', '/photos', '/optimized', '/videos', '/sitemap.xml'].map(prefix => [prefix, {
      target: deploymentEnv.BACKEND_INTERNAL_URL || 'http://127.0.0.1:3001',
      changeOrigin: false,
      xfwd: true,
    }])),
    hmr: {
      host: hmrHost,
    },
    // Force pre-transform of all imports
    warmup: {
      clientFiles: ['./src/components/AdminPortal/**/*.{ts,tsx,css}'],
    },
  },
});
