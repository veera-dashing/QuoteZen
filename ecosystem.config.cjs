module.exports = {
  apps: [
    {
      name: 'quotezen-api',
      cwd: './apps/api',
      script: 'dist/server.js',
      env: {
        NODE_ENV: 'production',
        PORT: 4000,
        HOST: '127.0.0.1',
      },
      max_memory_restart: '500M',
      restart_delay: 2000,
    },
    {
      name: 'quotezen-web',
      cwd: './apps/web',
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3000 -H 127.0.0.1',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      max_memory_restart: '600M',
      restart_delay: 2000,
    },
  ],
};
