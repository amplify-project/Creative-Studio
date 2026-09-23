const fs = require('fs');
const http = require('http');
const https = require('https');
const next = require('next');

const dev = process.env.NODE_ENV !== 'production';
const useHttps = process.env.USE_HTTPS === 'true'; // Parámetro para decidir protocolo
const app = next({ dev });
const handle = app.getRequestHandler();

// Opciones para HTTPS
const httpsOptions = {
  key: fs.readFileSync('./certs/key.pem'),
  cert: fs.readFileSync('./certs/cert.pem'),
};

app.prepare().then(() => {
  const serverCallback = (req, res) => {
    try {
      handle(req, res);
    } catch (err) {
      console.error('💥 Error in request handler:', err);
      res.statusCode = 500;
      res.end('Internal Server Error');
    }
  };

  if (useHttps) {
    https.createServer(httpsOptions, serverCallback).listen(3000, () => {
      console.log('> Running at https://localhost:3000');
    });
  } else {
    http.createServer(serverCallback).listen(3000, () => {
      console.log('> Running at http://localhost:3000');
    });
  }
});
