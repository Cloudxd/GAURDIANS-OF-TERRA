'use strict';
/**
 * Camp Command server. No dependencies: Node's built-in http + SQLite.
 *
 *   node server.js
 *   open http://localhost:8000
 *
 * Environment variables: PORT (default 8000), HOST (default 127.0.0.1;
 * use 0.0.0.0 to accept connections from other devices), CAMP_DB (database path).
 */
// Hide Node's "SQLite is experimental" notice; it is noise for this project.
const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => (String(w).includes('SQLite') ? undefined : emit.call(process, w, ...rest));

const http = require('http');
const fs = require('fs');
const path = require('path');

let engine;
try {
  engine = require('./engine');
} catch (e) {
  if (String(e.message).includes('node:sqlite')) {
    console.error('\nThis project needs Node.js 22.13 or newer (it uses the built-in SQLite).');
    console.error('You have ' + process.version + '. Download the current LTS from https://nodejs.org and try again.\n');
    process.exit(1);
  }
  throw e;
}

const PORT = Number(process.env.PORT) || 8000;
const HOST = process.env.HOST || '127.0.0.1';
const STATIC = path.join(__dirname, 'static');
const { bad, run } = engine;

engine.initDb();

// ----------------------------------------------------------------- validation
function num(body, key, { min = -Infinity, max = Infinity, def, required = false, gt = null } = {}) {
  const v = body[key];
  if (v === undefined || v === null) {
    if (required) throw bad(`${key} is required`);
    return def;
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(`${key} must be a number`);
  if (v < min || v > max || (gt !== null && v <= gt)) throw bad(`${key} is out of range`);
  return v;
}
const str = (body, key) => {
  const v = body[key];
  if (v !== undefined && v !== null && typeof v !== 'string') throw bad(`${key} must be text`);
  return v;
};

// ----------------------------------------------------------------- routes
// [method, path pattern, handler({ params, query, body }) -> JSON, optional status]
const routes = [
  ['GET', '/api/health', () => ({ ok: true })],
  ['GET', '/api/status', () => run(engine.snapshot)],

  ['GET', '/api/energy/history', ({ query }) =>
    run(engine.energyHistory, num({ h: query.hours === undefined ? undefined : Number(query.hours) }, 'h', { def: 24, gt: 0, max: 720 }))],

  ['POST', '/api/energy/readings', ({ body }) => run(engine.ingestEnergy, {
    solar_kw: num(body, 'solar_kw', { min: 0, def: 0 }),
    wind_kw: num(body, 'wind_kw', { min: 0, def: 0 }),
    soc_pct: num(body, 'soc_pct', { min: 0, max: 100, def: null }),
    stored_kwh: num(body, 'stored_kwh', { min: 0, def: null }),
    ts: str(body, 'ts') || null,
  })],

  ['GET', '/api/loads', () => run(engine.listLoads)],
  ['POST', '/api/loads', ({ body }) => run(engine.addLoad, str(body, 'name'),
    num(body, 'priority', { required: true }), num(body, 'power_kw', { required: true, min: 0 })), 201],
  ['PUT', '/api/loads/:id', ({ params, body }) => {
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw bad('enabled must be true or false');
    return run(engine.updateLoad, Number(params.id), {
      enabled: body.enabled,
      power_kw: num(body, 'power_kw', { min: 0, def: null }),
      priority: num(body, 'priority', { def: null }),
    });
  }],

  ['GET', '/api/bridge', ({ query }) => {
    const hours = query.hours === undefined ? 24 : Number(query.hours);
    return run((d) => ({ status: engine.bridgeStatus(d), history: engine.bridgeHistory(d, hours) }));
  }],
  ['POST', '/api/bridge/readings', ({ body }) => run(engine.ingestBridge, {
    water_level_m: num(body, 'water_level_m', { required: true, min: 0 }),
    tilt_deg: num(body, 'tilt_deg', { required: true, min: 0 }),
    vibration_mm_s: num(body, 'vibration_mm_s', { required: true, min: 0 }),
    vehicle_load_t: num(body, 'vehicle_load_t', { min: 0, def: 0 }),
    ts: str(body, 'ts') || null,
  })],

  ['GET', '/api/shelter', () => run(engine.shelterStatus)],
  ['PUT', '/api/shelter', ({ body }) => run(engine.setOccupied, num(body, 'occupied', { required: true }))],

  ['GET', '/api/alerts', () => run(engine.getAlerts)],

  ['POST', '/api/sizing', ({ body }) => {
    let loads = null;
    if (body.loads !== undefined && body.loads !== null) {
      if (!Array.isArray(body.loads)) throw bad('loads must be a list');
      loads = body.loads.map((l) => ({ name: String(l.name || 'Load'), power_kw: num(l, 'power_kw', { required: true, min: 0 }) }));
    }
    return run(engine.sizeBattery, {
      loads,
      hours: num(body, 'hours', { def: 48, gt: 0 }),
      depth_of_discharge: num(body, 'depth_of_discharge', { def: 0.8, gt: 0, max: 1 }),
      efficiency: num(body, 'efficiency', { def: 0.9, gt: 0, max: 1 }),
      include_priority: num(body, 'include_priority', { def: 2, min: 1, max: 3 }),
    });
  }],

  // Simulator: stands in for real sensors during a demo.
  ['POST', '/api/sim/step', ({ query }) =>
    run(engine.simStep, query.minutes === undefined ? 30 : Number(query.minutes))],
  ['POST', '/api/sim/scenario', ({ body }) => run(engine.setScenario, str(body, 'name'))],
  ['POST', '/api/sim/reset', () => { engine.initDb(true); return { ok: true }; }],
].map(([method, pattern, handler, status]) => ({
  method, handler, status: status || 200,
  keys: [...pattern.matchAll(/:(\w+)/g)].map((m) => m[1]),
  regex: new RegExp('^' + pattern.replace(/:\w+/g, '([^/]+)') + '/?$'),
}));

// ----------------------------------------------------------------- http plumbing
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
               '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) { reject(bad('Request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        const parsed = JSON.parse(text);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch (e) { reject(new engine.HttpError(400, 'Request body is not valid JSON')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname);
  const file = path.normalize(path.join(STATIC, rel));
  if (!file.startsWith(STATIC)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, pathname);
  }
  if (req.method === 'OPTIONS') return send(res, 204, {});

  try {
    let matched = null, params = {};
    let pathKnown = false;
    for (const r of routes) {
      const m = r.regex.exec(pathname);
      if (!m) continue;
      pathKnown = true;
      if (r.method !== req.method) continue;
      matched = r;
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      break;
    }
    if (!matched) return send(res, pathKnown ? 405 : 404, { detail: pathKnown ? 'Method not allowed' : 'No such endpoint' });
    const body = req.method === 'GET' ? {} : await readBody(req);
    const query = Object.fromEntries(url.searchParams);
    send(res, matched.status, matched.handler({ params, query, body }));
  } catch (e) {
    if (e instanceof engine.HttpError) return send(res, e.status, { detail: e.message });
    console.error(e);
    send(res, 500, { detail: 'Internal server error' });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`\nPort ${PORT} is already in use. Close the other program or run with a different port:\n  $env:PORT=8001; node server.js\n`);
  else console.error(e);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`Camp Command running at http://localhost:${PORT}`);
  if (HOST === '0.0.0.0') console.log('Listening on all network interfaces. Other devices can use your computer\'s IP address.');
});
