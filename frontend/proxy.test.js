import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import express from 'express';
import { backendProxy } from './proxy.js';

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test('proxy preserves multipart bodies, cookies, redirects, ranges and streaming', async t => {
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/api/redirect') {
      res.writeHead(302, { location: 'https://accounts.example.com/login', 'set-cookie': ['one=1; HttpOnly', 'two=2; Secure'] });
      return res.end();
    }
    if (req.url === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: started\n\n');
      const timer = setTimeout(() => res.end('data: done\n\n'), 1500);
      res.on('close', () => clearTimeout(timer));
      return;
    }
    if (req.url === '/photos/video.mp4') {
      assert.equal(req.headers.range, 'bytes=1-3');
      res.writeHead(206, { 'content-range': 'bytes 1-3/4', 'content-type': 'video/mp4', 'content-length': '3' });
      return res.end(Buffer.from([0, 255, 127]));
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('base64') }));
  });
  const upstreamUrl = await listen(upstream);
  const app = express();
  app.use(['/api', '/photos'], backendProxy(upstreamUrl));
  app.use('/notifications', backendProxy(upstreamUrl, url => url.replace('/notifications', '/api/push-notifications')));
  const server = http.createServer(app);
  const url = await listen(server);
  t.after(() => { server.closeAllConnections(); server.close(); upstream.closeAllConnections(); upstream.close(); });
  const body = Buffer.concat([Buffer.from('--boundary\r\nContent-Disposition: form-data; name="photo"; filename="test.jpg"\r\n\r\n'), Buffer.alloc(150000, 255), Buffer.from('\r\n--boundary--\r\n')]);
  const response = await fetch(`${url}/api/upload?album=test`, {
    method: 'POST', body,
    headers: { 'content-type': 'multipart/form-data; boundary=boundary', cookie: 'connect.sid=test', origin: 'https://photos.example.com', 'x-forwarded-proto': 'https', 'x-csrf-token': 'token' },
  });
  const echoed = await response.json();
  assert.equal(echoed.body, body.toString('base64'));
  assert.equal(echoed.url, '/api/upload?album=test');
  assert.equal(echoed.headers.cookie, 'connect.sid=test');
  assert.equal(echoed.headers.origin, 'https://photos.example.com');
  assert.equal(echoed.headers['x-forwarded-proto'], 'https');
  assert.equal(echoed.headers['x-csrf-token'], 'token');
  assert.equal(echoed.headers['x-forwarded-host'], new URL(url).host);
  const redirect = await fetch(`${url}/api/redirect`, { redirect: 'manual' });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), 'https://accounts.example.com/login');
  assert.deepEqual(redirect.headers.getSetCookie(), ['one=1; HttpOnly', 'two=2; Secure']);
  const range = await fetch(`${url}/photos/video.mp4`, { headers: { range: 'bytes=1-3' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), 'bytes 1-3/4');
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), Buffer.from([0, 255, 127]));
  const stream = await fetch(`${url}/api/stream`);
  const reader = stream.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: started\n\n');
  await reader.cancel();
  const notification = await fetch(`${url}/notifications/status?test=1`);
  assert.equal((await notification.json()).url, '/api/push-notifications/status?test=1');
});
