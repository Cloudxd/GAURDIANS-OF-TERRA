# Camp Command (JavaScript / Node.js)

Dashboard, database and REST API for the 150-person emergency camp: solar + wind microgrid,
48 h battery reserve, bridge sensors, shelter occupancy.

**No `npm install` needed.** The server uses only Node's built-in `http` and SQLite modules.

## Run it (Windows PowerShell)

1. Check your Node version:
   ```powershell
   node --version
   ```
   It must be **v22.13 or newer**. If it's older or the command isn't found, install the
   current LTS from https://nodejs.org, then open a new PowerShell window.
2. Go to the unzipped folder and start the server:
   ```powershell
   cd "C:\Users\KIIT\Desktop\civil project\camp-command-js"
   node server.js
   ```
3. Open http://localhost:8000

Stop the server with `Ctrl + C`.

Optional settings:
```powershell
$env:PORT = 8001; node server.js          # different port
$env:HOST = "0.0.0.0"; node server.js     # let other devices on your Wi-Fi connect
```

## Files

| File | Purpose |
|---|---|
| `server.js` | HTTP server, routes, input validation, serves the dashboard |
| `engine.js` | SQLite schema, load shedding, reserve projection, alerts, simulator |
| `static/index.html` | The dashboard (plain HTML, CSS, JavaScript; works offline) |
| `camp.db` | Created on first run |

## Database tables

`config`, `loads`, `energy_readings`, `bridge_readings`, `alerts`.

## API

| Method and path | What it does |
|---|---|
| `GET /api/status` | Everything the dashboard shows |
| `GET /api/energy/history?hours=` | Solar, wind, load, battery readings |
| `POST /api/energy/readings` | Push `{solar_kw, wind_kw, soc_pct}` |
| `GET/POST /api/loads`, `PUT /api/loads/:id` | List, add, switch off/on, change power or priority |
| `GET /api/bridge`, `POST /api/bridge/readings` | Status and history; push `{water_level_m, tilt_deg, vibration_mm_s, vehicle_load_t}` |
| `GET/PUT /api/shelter` | Occupancy |
| `GET /api/alerts` | Active and recently resolved |
| `POST /api/sizing` | Battery sizing calculator |
| `POST /api/sim/step`, `/api/sim/scenario`, `/api/sim/reset` | Demo simulator |

Call it from JavaScript:
```js
const res = await fetch("http://localhost:8000/api/status");
const data = await res.json();
console.log(data.overall, data.reserve.worst_case_hours);

await fetch("http://localhost:8000/api/energy/readings", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ solar_kw: 1.5, wind_kw: 3.2, soc_pct: 62 }),
});
```

From PowerShell:
```powershell
Invoke-RestMethod http://localhost:8000/api/status
Invoke-RestMethod -Method Post -Uri http://localhost:8000/api/energy/readings `
  -ContentType "application/json" -Body '{"solar_kw":1.5,"wind_kw":3.2,"soc_pct":62}'
```

## How the 48 h reserve works

At every moment the battery alone (zero solar, zero wind) must carry the protected loads for 48 h.

1. Critical loads (priority 1) always run.
2. Other loads run only if the reserve still holds with them, or if current generation has spare
   power for them. Spare-power loads are not protected, so they never count against the reserve.
3. Everything else is shed, lowest priority first.

Usable energy = (stored kWh minus the depth-of-discharge floor) x efficiency.

## Before you present this

- Battery size (360 kWh), load list, solar and wind ratings are **placeholders**. Replace them
  with your electrical teammates' numbers in `DEFAULT_CONFIG` and `DEFAULT_LOADS` at the top of
  `engine.js`, then delete `camp.db`.
- Bridge warning limits (`BRIDGE_LIMITS` in `engine.js`) are **placeholders**. The structural
  team must set the real ones. The software only compares readings against them and does not
  decide whether the bridge is safe.
- The API has no login. Fine on a local network for a demo; don't expose it to the internet.
