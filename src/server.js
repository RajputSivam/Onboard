const fs = require('fs');
const path = require('path');
const { openDb } = require('./db');
const { createApp } = require('./app');
const { createWorker } = require('./worker');
const { seed } = require('./seed');

const file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'opsboard.db');
fs.mkdirSync(path.dirname(file), { recursive: true });
const db = openDb(file);
seed(db);
const app = createApp(db);
const publish = { team: app.hub.publishTeam, users: app.hub.publishUsers };
const stopWorker = createWorker(db, { publish }).start(1000);

const port = process.env.PORT || 3000;
const server = app.listen(port, () => {
    console.log(`OpsBoard on http://localhost:${port}  (demo login: alice|bob|carol|dave|erin|frank @example.com / password)`);
});

// Startup errors (e.g. port already in use) are now reported instead of exiting silently.
server.on('error', (e) => {
    console.error(
        e.code === 'EADDRINUSE'
            ? `Port ${port} is already in use. Stop the other process, or run with a different port:  $env:PORT=3001; npm start`
            : e
    );
    stopWorker();
    process.exit(1);
});

process.on('SIGINT', () => {
    stopWorker();
    server.close(() => process.exit(0));
});