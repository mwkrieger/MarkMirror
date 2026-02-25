module.exports = {
  apps: [
    {
      name: 'WallDashboard',
      script: 'src/server.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      },
      watch: false,
      ignore_watch: ['node_modules', 'data', 'logs'],
      max_memory_restart: '500M',
      error_file: 'logs/error.log',
      out_file: 'logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
    }
  ],
  deploy: {
    production: {
      user: 'mark',
      host: '192.168.86.199',
      ref: 'origin/main',
      repo: 'https://github.com/mwkrieger/MarkMirror.git',
      path: '/home/mark/wall-dashboard',
      'post-deploy': 'npm install && pm2 reload ecosystem.config.js --env production'
    }
  }
};
