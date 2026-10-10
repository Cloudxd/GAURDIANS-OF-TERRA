'use strict';
/**
 * Camp Command: data layer and decision logic (JavaScript port).
 * Uses Node's built-in SQLite (node:sqlite), so there is nothing to npm install.
 *
 * The 48 h requirement is a rolling reserve: at any moment the battery alone
 * (zero solar, zero wind) must carry the protected loads for 48 more hours.
 * Loads that would break that promise are shed, lowest priority first.
 */
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.CAMP_DB || path.join(__dirname, 'camp.db');
const REQUIRED_HOURS = 48;
const HORIZON_HOURS = 72;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(422, m);
const notFound = (m) => new HttpError(404, m);

// PLACEHOLDER limits. The civil/structural team must replace these with
// values from their own design calculations.
const BRIDGE_LIMITS = [
  // key, label, unit, caution, alarm
  ['water_level_m', 'River level', 'm', 3.5, 4.5],
  ['tilt_deg', 'Deck tilt', 'deg', 0.5, 1.0],
  ['vibration_mm_s', 'Vibration', 'mm/s', 5.0, 10.0],
  ['vehicle_load_t', 'Vehicle on span', 't', 13.0, 15.0],
];

const SCENARIOS = {
  clear: { cloud: 0.10, wind_ms: 4.0, water_m: 2.0 },
  overcast: { cloud: 0.60, wind_ms: 6.0, water_m: 2.8 },
  storm: { cloud: 0.95, wind_ms: 9.0, water_m: 4.0 },
  surge: { cloud: 0.97, wind_ms: 11.0, water_m: 5.2 },
};

// name, priority (1 critical, 2 important, 3 non-critical), kW
const DEFAULT_LOADS = [
  ['Medical and triage equipment', 1, 1.0],
  ['Emergency lighting', 1, 0.4],
  ['Radio and communications', 1, 0.3],
  ['Water pumps', 2, 0.6],
  ['Heating', 2, 2.0],
  ['Vaccine and food refrigeration', 2, 0.5],
  ['General lighting', 3, 0.6],
  ['Device charging', 3, 0.8],
  ['Kitchen appliances', 3, 1.0],
];

const DEFAULT_CONFIG = {
  battery_capacity_kwh: 360.0,
  depth_of_discharge: 0.8,
  efficiency: 0.9,
  solar_peak_kw: 30.0,
  wind_rated_kw: 15.0,
  shelter_capacity: 150,
  shelter_units: 30,
  occupied: 143,
  scenario: 'storm',
  cloud: 0.95,
  wind_ms: 9.0,
  water_m: 4.0,
  step: 0,
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS loads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 3),
  power_kw REAL NOT NULL CHECK (power_kw >= 0),
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS energy_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  solar_kw REAL NOT NULL,
  wind_kw REAL NOT NULL,
  load_kw REAL NOT NULL,
  stored_kwh REAL NOT NULL,
  soc_pct REAL NOT NULL,
  source TEXT NOT NULL DEFAULT 'sim'
);
CREATE INDEX IF NOT EXISTS idx_energy_ts ON energy_readings(ts);
CREATE TABLE IF NOT EXISTS bridge_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  water_level_m REAL NOT NULL,
  tilt_deg REAL NOT NULL,
  vibration_mm_s REAL NOT NULL,
  vehicle_load_t REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'sim'
);
CREATE INDEX IF NOT EXISTS idx_bridge_ts ON bridge_readings(ts);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  raised_at TEXT NOT NULL,
  resolved_at TEXT
);
`;

const SEVERITY_RANK = { alarm: 0, caution: 1, info: 2 };

// --------------------------------------------------------------------------
// Small helpers
// --------------------------------------------------------------------------
const round = (x, d = 0) => { const f = 10 ** d; return Math.round(x * f) / f; };
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const pad = (n) => String(n).padStart(2, '0');

// All timestamps are "YYYY-MM-DDTHH:MM:SS" and treated as one consistent clock (UTC math,
// no timezone conversion), so the dashboard shows exactly the simulated clock time.
const parseTs = (s) => new Date(s.slice(0, 19) + 'Z');
const fmtTs = (d) => d.toISOString().slice(0, 19);
const addMinutes = (d, m) => new Date(d.getTime() + m * 60000);

// Small seeded random generator so simulation runs are repeatable.
function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { uniform: (lo, hi) => lo + (hi - lo) * next(), choice: (arr) => arr[Math.floor(next() * arr.length)] };
}

// --------------------------------------------------------------------------
// Database
// --------------------------------------------------------------------------
let _db = null;
function open() {
  if (!_db) _db = new DatabaseSync(DB_PATH);
  return _db;
}

/** Run fn(db) inside a transaction. Rolls back if it throws. */
function run(fn, ...args) {
  const d = open();
  d.exec('BEGIN');
  try {
    const out = fn(d, ...args);
    d.exec('COMMIT');
    return out;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

function getCfg(d) {
  const out = {};
  for (const r of d.prepare('SELECT key, value FROM config').all()) out[r.key] = JSON.parse(r.value);
  return out;
}

function setCfg(d, obj) {
  const st = d.prepare(
    'INSERT INTO config(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(obj)) st.run(k, JSON.stringify(v));
}

function initDb(reset = false) {
  const d = open();
  if (reset) {
    d.exec('DROP TABLE IF EXISTS config; DROP TABLE IF EXISTS loads; DROP TABLE IF EXISTS energy_readings;' +
           'DROP TABLE IF EXISTS bridge_readings; DROP TABLE IF EXISTS alerts;');
  }
  d.exec(SCHEMA);
  if (d.prepare('SELECT COUNT(*) AS n FROM config').get().n === 0) run(seed);
}

function seed(d) {
  const now = new Date();
  const start = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T18:00:00`;
  const cfg = { ...DEFAULT_CONFIG, sim_time: start, stored_kwh: DEFAULT_CONFIG.battery_capacity_kwh };
  setCfg(d, cfg);
  const st = d.prepare('INSERT INTO loads(name, priority, power_kw) VALUES(?, ?, ?)');
  for (const l of DEFAULT_LOADS) st.run(...l);
  for (let i = 0; i < 12; i++) simStep(d, 30); // 6 simulated hours so charts have history
}

// --------------------------------------------------------------------------
// Physics-lite models
// --------------------------------------------------------------------------
function solarKw(cfg, t, cloud) {
  const h = t.getUTCHours() + t.getUTCMinutes() / 60;
  if (h < 6 || h > 18) return 0;
  return cfg.solar_peak_kw * Math.sin(Math.PI * (h - 6) / 12) * (1 - 0.92 * cloud);
}

/** Cut-in 3 m/s, rated at 12 m/s, cut-out at 25 m/s. */
function windKw(cfg, v) {
  if (v < 3 || v > 25) return 0;
  if (v >= 12) return cfg.wind_rated_kw;
  return cfg.wind_rated_kw * ((v - 3) / 9) ** 3;
}

const floorKwh = (cfg) => cfg.battery_capacity_kwh * (1 - cfg.depth_of_discharge);

/** Energy loads can actually receive: above the depth-of-discharge floor, after losses. */
const deliverableKwh = (cfg, stored) => Math.max(0, stored - floorKwh(cfg)) * cfg.efficiency;

/** net_kw > 0 charges, < 0 discharges. */
function applyEnergy(cfg, stored, netKw, hours) {
  stored += netKw >= 0 ? netKw * hours * cfg.efficiency : netKw * hours / cfg.efficiency;
  return clamp(stored, 0, cfg.battery_capacity_kwh);
}

// --------------------------------------------------------------------------
// Loads and load shedding
// --------------------------------------------------------------------------
const toLoad = (r) => ({ ...r, enabled: !!r.enabled });

function listLoads(d) {
  return d.prepare('SELECT * FROM loads ORDER BY priority, id').all().map(toLoad);
}

function getLoad(d, id) {
  const r = d.prepare('SELECT * FROM loads WHERE id = ?').get(id);
  if (!r) throw notFound(`Load ${id} not found`);
  return toLoad(r);
}

function checkLoad(priority, powerKw) {
  if (![1, 2, 3].includes(priority)) throw bad('Priority must be 1 (critical), 2 (important) or 3 (non-critical)');
  if (!(powerKw >= 0)) throw bad('Power must be zero or more');
}

function addLoad(d, name, priority, powerKw) {
  checkLoad(priority, powerKw);
  if (!String(name || '').trim()) throw bad('Load name is required');
  const res = d.prepare('INSERT INTO loads(name, priority, power_kw) VALUES(?, ?, ?)')
    .run(String(name).trim(), priority, powerKw);
  return getLoad(d, Number(res.lastInsertRowid));
}

function updateLoad(d, id, { enabled, power_kw, priority } = {}) {
  const cur = getLoad(d, id);
  const next = {
    enabled: enabled == null ? cur.enabled : enabled,
    power_kw: power_kw == null ? cur.power_kw : power_kw,
    priority: priority == null ? cur.priority : priority,
  };
  checkLoad(next.priority, next.power_kw);
  d.prepare('UPDATE loads SET enabled = ?, power_kw = ?, priority = ? WHERE id = ?')
    .run(next.enabled ? 1 : 0, next.power_kw, next.priority, id);
  return getLoad(d, id);
}

/**
 * Decide which loads run.
 * - Priority 1 always runs (unless an operator switched it off).
 * - Others run if the battery alone still covers every protected load for 48 h
 *   ("reserve"), or else if current generation has spare power ("surplus").
 *   Surplus-fed loads are not protected: they drop off the moment generation
 *   falls, so they never count against the 48 h reserve.
 */
function planLoads(cfg, loads, genKw, stored) {
  const deliver = deliverableKwh(cfg, stored);
  let prot = 0;    // kW the battery alone must carry
  let running = 0; // kW running now, including surplus-fed loads
  const plan = [];
  const sorted = [...loads].sort((a, b) => a.priority - b.priority || a.id - b.id);
  for (const load of sorted) {
    const p = load.power_kw;
    const item = { ...load };
    if (!load.enabled) {
      Object.assign(item, { state: 'off', basis: null, reason: 'Switched off by operator' });
    } else if (load.priority === 1) {
      prot += p; running += p;
      Object.assign(item, { state: 'on', basis: 'critical', reason: 'Critical load, always supplied' });
    } else if (prot + p > 0 && deliver / (prot + p) >= REQUIRED_HOURS) {
      prot += p; running += p;
      Object.assign(item, { state: 'on', basis: 'reserve', reason: 'Battery alone still covers 48 h' });
    } else if (genKw - running >= p) {
      running += p;
      Object.assign(item, { state: 'on', basis: 'surplus', reason: 'Running on surplus generation' });
    } else {
      Object.assign(item, { state: 'shed', basis: null, reason: 'Would cut the 48 h reserve' });
    }
    plan.push(item);
  }
  return plan;
}

const activeKw = (plan) => plan.filter((p) => p.state === 'on').reduce((s, p) => s + p.power_kw, 0);
const protectedKw = (plan) =>
  plan.filter((p) => p.state === 'on' && p.basis !== 'surplus').reduce((s, p) => s + p.power_kw, 0);

// --------------------------------------------------------------------------
// Reserve projection
// --------------------------------------------------------------------------
/**
 * Two hour-by-hour projections of battery state of charge:
 * - worst: no solar, no wind, protected loads only (the design requirement)
 * - forecast: current weather persists, solar follows the daily curve, all running loads served
 */
function project(cfg, loadKw, stored, t0, prot = null, horizon = HORIZON_HOURS) {
  if (prot === null) prot = loadKw;
  const cap = cfg.battery_capacity_kwh;
  const floor = floorKwh(cfg);
  const deliver = deliverableKwh(cfg, stored);

  const worstHours = prot > 0 ? deliver / prot : horizon;
  const worstCapped = worstHours > horizon;

  let s = stored;
  let fcHours = null;
  const hours = [], worst = [], forecast = [];
  for (let h = 0; h <= horizon; h++) {
    const wStored = stored > floor ? Math.max(floor, stored - prot / cfg.efficiency * h) : stored;
    hours.push(h);
    worst.push(round(wStored / cap * 100, 1));
    forecast.push(round(s / cap * 100, 1));
    if (h === horizon) break;
    const tm = new Date(t0.getTime() + (h + 0.5) * 3600000);
    const gen = solarKw(cfg, tm, cfg.cloud) + windKw(cfg, cfg.wind_ms);
    const sNew = applyEnergy(cfg, s, gen - loadKw, 1.0);
    if (fcHours === null && sNew <= floor + 1e-9) {
      fcHours = s > floor ? h + (s - floor) / Math.max(s - sNew, 1e-9) : h;
    }
    s = sNew;
  }
  return {
    worst_case_hours: round(Math.min(worstHours, horizon), 1),
    worst_case_capped: worstCapped,
    forecast_hours: round(fcHours !== null ? fcHours : horizon, 1),
    forecast_capped: fcHours === null,
    floor_pct: round((1 - cfg.depth_of_discharge) * 100, 1),
    horizon_hours: horizon,
    series: { hours, worst, forecast },
  };
}

function reserveLevel(worstHours) {
  if (worstHours >= REQUIRED_HOURS) return 'safe';
  if (worstHours >= REQUIRED_HOURS * 0.75) return 'caution';
  return 'alarm';
}

// --------------------------------------------------------------------------
// Energy readings
// --------------------------------------------------------------------------
function insertEnergy(d, cfg, ts, solar, wind, load, stored, source) {
  d.prepare('INSERT INTO energy_readings(ts, solar_kw, wind_kw, load_kw, stored_kwh, soc_pct, source) ' +
            'VALUES(?, ?, ?, ?, ?, ?, ?)')
    .run(ts, round(solar, 3), round(wind, 3), round(load, 3), round(stored, 2),
         round(stored / cfg.battery_capacity_kwh * 100, 2), source);
}

/** Record a real sensor reading. Battery level is given as soc_pct or stored_kwh. */
function ingestEnergy(d, { solar_kw = 0, wind_kw = 0, soc_pct = null, stored_kwh = null, ts = null }) {
  const cfg = getCfg(d);
  if (stored_kwh == null && soc_pct == null) throw bad('Provide soc_pct or stored_kwh');
  let stored = stored_kwh != null ? stored_kwh : cfg.battery_capacity_kwh * soc_pct / 100;
  stored = clamp(stored, 0, cfg.battery_capacity_kwh);
  const plan = planLoads(cfg, listLoads(d), solar_kw + wind_kw, stored);
  insertEnergy(d, cfg, (ts || cfg.sim_time).slice(0, 19), solar_kw, wind_kw, activeKw(plan), stored, 'sensor');
  setCfg(d, { stored_kwh: stored });
  return { ok: true, stored_kwh: round(stored, 2), load_kw: round(activeKw(plan), 3) };
}

function energyHistory(d, hours = 24) {
  const last = d.prepare('SELECT MAX(ts) AS ts FROM energy_readings').get().ts;
  if (!last) return [];
  const since = fmtTs(addMinutes(parseTs(last), -hours * 60));
  return d.prepare('SELECT ts, solar_kw, wind_kw, load_kw, stored_kwh, soc_pct FROM energy_readings ' +
                   'WHERE ts >= ? ORDER BY ts').all(since).map((r) => ({ ...r }));
}

// --------------------------------------------------------------------------
// Bridge
// --------------------------------------------------------------------------
function levelOf(value, caution, alarm) {
  if (value > alarm) return 'alarm';
  if (value >= caution) return 'caution';
  return 'ok';
}

function ingestBridge(d, { water_level_m, tilt_deg, vibration_mm_s, vehicle_load_t = 0, ts = null, source = 'sensor' }) {
  const cfg = getCfg(d);
  d.prepare('INSERT INTO bridge_readings(ts, water_level_m, tilt_deg, vibration_mm_s, vehicle_load_t, source) ' +
            'VALUES(?, ?, ?, ?, ?, ?)')
    .run((ts || cfg.sim_time).slice(0, 19), water_level_m, tilt_deg, vibration_mm_s, vehicle_load_t, source);
  return bridgeStatus(d);
}

function bridgeStatus(d) {
  const r = d.prepare('SELECT * FROM bridge_readings ORDER BY ts DESC, id DESC LIMIT 1').get();
  if (!r) return null;
  let worst = 'ok';
  const metrics = BRIDGE_LIMITS.map(([key, label, unit, caution, alarm]) => {
    const level = levelOf(r[key], caution, alarm);
    if (level === 'alarm' || (level === 'caution' && worst === 'ok')) worst = level;
    return { key, label, unit, value: round(r[key], 2), caution, alarm, level };
  });
  const access = { ok: 'Open', caution: 'Open, watch closely', alarm: 'Closed to traffic' }[worst];
  return { ts: r.ts, metrics, level: worst, access, limits_are_placeholders: true };
}

function bridgeHistory(d, hours = 24) {
  const last = d.prepare('SELECT MAX(ts) AS ts FROM bridge_readings').get().ts;
  if (!last) return [];
  const since = fmtTs(addMinutes(parseTs(last), -hours * 60));
  return d.prepare('SELECT ts, water_level_m, tilt_deg, vibration_mm_s, vehicle_load_t FROM bridge_readings ' +
                   'WHERE ts >= ? ORDER BY ts').all(since).map((r) => ({ ...r }));
}

// --------------------------------------------------------------------------
// Shelter
// --------------------------------------------------------------------------
function shelterStatus(d) {
  const cfg = getCfg(d);
  const cap = cfg.shelter_capacity, units = cfg.shelter_units, occ = cfg.occupied;
  const per = Math.floor(cap / units);
  const fill = [];
  let left = occ;
  for (let i = 0; i < units; i++) { const n = Math.min(per, left); fill.push(n); left -= n; }
  return { capacity: cap, family_units: units, people_per_unit: per, occupied: occ,
           free_places: cap - occ, units: fill, medical_tent: 'Active' };
}

function setOccupied(d, occupied) {
  const cfg = getCfg(d);
  if (!Number.isInteger(occupied) || occupied < 0 || occupied > cfg.shelter_capacity) {
    throw bad(`Occupancy must be a whole number between 0 and ${cfg.shelter_capacity}`);
  }
  setCfg(d, { occupied });
  return shelterStatus(d);
}

// --------------------------------------------------------------------------
// Alerts
// --------------------------------------------------------------------------
const trim = (v) => String(Number(v.toFixed(2)));

function collectAlerts(plan, proj, bridge) {
  const out = [];
  const w = proj.worst_case_hours;
  const lvl = reserveLevel(w);
  if (lvl !== 'safe') {
    out.push({ code: 'reserve', severity: lvl,
               message: `Battery-only reserve is ${w.toFixed(0)} h, below the 48 h requirement.` });
  }
  const shed = plan.filter((p) => p.state === 'shed').map((p) => p.name);
  if (shed.length) {
    out.push({ code: 'load_shed', severity: 'info',
               message: `Shedding ${shed.length} load(s) to protect the reserve: ${shed.join(', ')}.` });
  }
  if (bridge) {
    for (const m of bridge.metrics) {
      if (m.level === 'ok') continue;
      const thr = m.level === 'alarm' ? m.alarm : m.caution;
      out.push({ code: 'bridge_' + m.key, severity: m.level,
                 message: `${m.label} is ${trim(m.value)} ${m.unit}, past the ${m.level} limit of ${thr} ${m.unit}.` });
    }
  }
  return out;
}

function syncAlerts(d, current, now) {
  const active = {};
  for (const r of d.prepare('SELECT * FROM alerts WHERE resolved_at IS NULL').all()) active[r.code] = r;
  const resolve = d.prepare('UPDATE alerts SET resolved_at = ? WHERE id = ?');
  const seen = new Set();
  for (const a of current) {
    seen.add(a.code);
    const row = active[a.code];
    if (row && row.severity === a.severity) {
      d.prepare('UPDATE alerts SET message = ? WHERE id = ?').run(a.message, row.id);
      continue;
    }
    if (row) resolve.run(now, row.id);
    d.prepare('INSERT INTO alerts(code, severity, message, raised_at) VALUES(?, ?, ?, ?)')
      .run(a.code, a.severity, a.message, now);
  }
  for (const [code, row] of Object.entries(active)) if (!seen.has(code)) resolve.run(now, row.id);
}

function getAlerts(d) {
  const rows = d.prepare('SELECT * FROM alerts ORDER BY id DESC LIMIT 60').all().map((r) => ({ ...r }));
  const active = rows.filter((r) => r.resolved_at === null)
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.id - a.id);
  const recent = rows.filter((r) => r.resolved_at !== null).slice(0, 8);
  return { active, recent };
}

// --------------------------------------------------------------------------
// Battery sizing calculator
// --------------------------------------------------------------------------
function sizeBattery(d, { loads = null, hours = 48, depth_of_discharge = 0.8, efficiency = 0.9, include_priority = 2 } = {}) {
  if (!(depth_of_discharge > 0 && depth_of_discharge <= 1) || !(efficiency > 0 && efficiency <= 1) || !(hours > 0)) {
    throw bad('Hours must be positive; depth of discharge and efficiency must be between 0 and 1');
  }
  if (!loads) {
    loads = listLoads(d).filter((l) => l.priority <= include_priority).map((l) => ({ name: l.name, power_kw: l.power_kw }));
  }
  const totalKw = loads.reduce((s, l) => s + l.power_kw, 0);
  const energy = totalKw * hours;
  const required = energy / (depth_of_discharge * efficiency);
  const installed = getCfg(d).battery_capacity_kwh;
  return {
    total_kw: round(totalKw, 2),
    energy_kwh: round(energy, 1),
    required_capacity_kwh: round(required, 1),
    installed_capacity_kwh: installed,
    margin_kwh: round(installed - required, 1),
    meets_requirement: installed >= required,
    breakdown: loads.map((l) => ({ name: l.name, power_kw: l.power_kw,
                                   share_pct: totalKw ? round(100 * l.power_kw / totalKw, 1) : 0 })),
  };
}

// --------------------------------------------------------------------------
// Snapshot (what the dashboard reads)
// --------------------------------------------------------------------------
/** Compute the live picture and sync alerts. Safe to call repeatedly. */
function snapshot(d) {
  const cfg = getCfg(d);
  const last = d.prepare('SELECT * FROM energy_readings ORDER BY ts DESC, id DESC LIMIT 1').get();
  const solar = last ? last.solar_kw : 0;
  const wind = last ? last.wind_kw : 0;
  const stored = cfg.stored_kwh;
  const t = parseTs(cfg.sim_time);

  const plan = planLoads(cfg, listLoads(d), solar + wind, stored);
  const load = activeKw(plan);
  const proj = project(cfg, load, stored, t, protectedKw(plan));
  const bridge = bridgeStatus(d);

  syncAlerts(d, collectAlerts(plan, proj, bridge), cfg.sim_time);
  const alerts = getAlerts(d);

  let overall = 'SAFE';
  if (alerts.active.some((a) => a.severity === 'alarm')) overall = 'ALARM';
  else if (alerts.active.some((a) => a.severity === 'caution')) overall = 'WATCH';

  return {
    overall,
    sim: { time: cfg.sim_time, scenario: cfg.scenario, step: cfg.step,
           cloud_cover_pct: Math.round(cfg.cloud * 100), wind_ms: round(cfg.wind_ms, 1) },
    energy: {
      solar_kw: round(solar, 2), wind_kw: round(wind, 2), generation_kw: round(solar + wind, 2),
      load_kw: round(load, 2), net_kw: round(solar + wind - load, 2),
      stored_kwh: round(stored, 1), soc_pct: round(stored / cfg.battery_capacity_kwh * 100, 1),
      capacity_kwh: cfg.battery_capacity_kwh, deliverable_kwh: round(deliverableKwh(cfg, stored), 1),
    },
    reserve: { ...proj, required_hours: REQUIRED_HOURS, level: reserveLevel(proj.worst_case_hours) },
    loads: plan,
    bridge,
    shelter: shelterStatus(d),
    alerts,
    scenarios: Object.keys(SCENARIOS),
  };
}

// --------------------------------------------------------------------------
// Simulator (stands in for real sensors during a demo)
// --------------------------------------------------------------------------
function setScenario(d, name) {
  if (!SCENARIOS[name]) throw bad('Unknown scenario. Choose one of: ' + Object.keys(SCENARIOS).join(', '));
  setCfg(d, { scenario: name });
  return { scenario: name };
}

function simStep(d, minutes = 30) {
  if (!(minutes >= 1 && minutes <= 720)) throw bad('minutes must be between 1 and 720');
  const c = getCfg(d);
  const rng = makeRng(c.step * 7919 + 13);
  const sc = SCENARIOS[c.scenario];
  const t = addMinutes(parseTs(c.sim_time), minutes);
  const ts = fmtTs(t);

  const cloud = clamp(c.cloud + (sc.cloud - c.cloud) * 0.25 + rng.uniform(-0.03, 0.03), 0, 1);
  const windMs = Math.max(0, c.wind_ms + (sc.wind_ms - c.wind_ms) * 0.25 + rng.uniform(-0.6, 0.6));
  const water = Math.max(0.5, c.water_m + (sc.water_m - c.water_m) * 0.15 + rng.uniform(-0.05, 0.05));

  const solar = solarKw(c, t, cloud);
  const wind = windKw(c, windMs);
  const plan = planLoads(c, listLoads(d), solar + wind, c.stored_kwh);
  const load = activeKw(plan);
  const stored = applyEnergy(c, c.stored_kwh, solar + wind - load, minutes / 60);
  insertEnergy(d, c, ts, solar, wind, load, stored, 'sim');

  const vehicle = rng.choice(c.scenario === 'surge'
    ? [0, 0, 0, 0, 6, 9, 12, 14, 16] : [0, 0, 0, 0, 6, 9, 12, 14]);
  const tilt = Math.max(0, 0.12 + 0.16 * Math.max(0, water - 2) + rng.uniform(-0.04, 0.04));
  const vib = 1.2 + 0.8 * Math.max(0, water - 2) + vehicle * 0.15 + rng.uniform(0, 0.8);
  d.prepare("INSERT INTO bridge_readings(ts, water_level_m, tilt_deg, vibration_mm_s, vehicle_load_t, source) " +
            "VALUES(?, ?, ?, ?, ?, 'sim')").run(ts, round(water, 2), round(tilt, 3), round(vib, 2), vehicle);

  setCfg(d, { sim_time: ts, cloud, wind_ms: windMs, water_m: water, stored_kwh: stored, step: c.step + 1 });
  return snapshot(d);
}

module.exports = {
  HttpError, bad, run, initDb, snapshot, energyHistory, ingestEnergy, listLoads, addLoad, updateLoad,
  bridgeStatus, bridgeHistory, ingestBridge, shelterStatus, setOccupied, getAlerts, sizeBattery,
  simStep, setScenario, SCENARIOS, REQUIRED_HOURS,
};
