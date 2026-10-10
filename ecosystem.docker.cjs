// PM2 ecosystem config for Docker
// Used by start-docker.sh in Docker container
const dataDir = process.env.DATA_DIR || '/app/data';
module.exports = {
  apps: [
    {
      name: 'backend',
      cwd: '/app/backend',
      script: 'tsx',
      args: 'src/server.ts',
      exec_mode: 'fork',
      instances: 1,
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        HOST: '0.0.0.0',
        // PM2 will inherit environment variables from docker-compose.yml
        // DATA_DIR, FRONTEND_DOMAIN, BACKEND_DOMAIN, ALLOWED_ORIGINS
      },
      error_file: `${dataDir}/logs/backend-error.log`,
      out_file: `${dataDir}/logs/backend-out.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: false,
      combine_logs: false,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
    },
    {
      name: 'frontend',
      cwd: '/app/frontend',
      script: 'node',
      args: 'server.js',
      exec_mode: 'fork',
      instances: 1,
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        HOST: '0.0.0.0',
        // PM2 will inherit environment variables from docker-compose.yml
        // DATA_DIR, API_URL, BACKEND_DOMAIN
      },
      error_file: `${dataDir}/logs/frontend-error.log`,
      out_file: `${dataDir}/logs/frontend-out.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
    },
  ],
};

