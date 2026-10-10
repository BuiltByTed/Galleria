import http from 'node:http';
import https from 'node:https';

const hopHeaders = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
function endToEndHeaders(headers) {
  const result = { ...headers };
  const connectionHeaders = String(headers.connection || '').split(',').map(value => value.trim().toLowerCase());
  for (const name of [...hopHeaders, ...connectionHeaders]) delete result[name];
  return result;
}

// Stream unchanged bodies and responses: multipart uploads, byte ranges, SSE,
// redirects, and every Set-Cookie header must survive the same-origin proxy.
export function backendProxy(target, rewrite = path => path) {
  const upstream = new URL(target);
  const transport = upstream.protocol === 'https:' ? https : http;
  return (req, res) => {
    const headers = endToEndHeaders(req.headers);
    headers['x-forwarded-host'] = req.headers['x-forwarded-host'] || req.headers.host;
    headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
    // The backend trusts one hop. Preserve the client reported by the external
    // reverse proxy, or use the direct client's address.
    headers['x-forwarded-for'] = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',').pop().trim();
    const request = transport.request({
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port,
      method: req.method,
      path: rewrite(req.originalUrl),
      headers,
    }, response => {
      res.writeHead(response.statusCode, endToEndHeaders(response.headers));
      res.flushHeaders();
      response.on('error', () => res.destroy());
      response.pipe(res);
    });
    request.on('error', () => {
      if (!res.headersSent) res.status(502).json({ error: 'Backend unavailable' });
      else res.destroy();
    });
    req.on('aborted', () => request.destroy());
    res.on('close', () => { if (!res.writableEnded) request.destroy(); });
    req.pipe(request);
  };
}
