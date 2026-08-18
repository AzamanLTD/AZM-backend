// Render dashboard hardcodes 'node index.js' as the start command,
// overriding render.yaml's 'npm start'. This wrapper ensures the
// real entry point (server.js) is loaded regardless of which command
// Render uses. Once the dashboard start command is corrected to
// 'npm start', this file becomes a harmless no-op.
require('./server.js');
