#!/usr/bin/env node
/**
 * Wall Dashboard Server v5
 * Enhanced with: Real-time Alerts + Advanced Analytics
 */

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const chokidar = require('chokidar');
const https = require('https');
const Database = require("better-sqlite3");

// Try to load suncalc for moon calculations, fallback if not available
let SunCalc;
try {
  SunCalc = require('suncalc');
} catch (e) {
  console.warn('⚠️  suncalc not installed. Moon times will show as "--:--"');
}

const app = express();
const PORT = 3000;

// Configuration
const CONFIG = {
  openWeather: {
    apiKey: '6b0e39ae46f78e9f38c0dfa31e6758e0',
    lat: 41.48,
    lon: -75.18,
    location: 'Hawley, US'
  },
  ambientWeather: {
    appKey: '8af43253753d4b7a8022d211fe4e89687862491cb12b4038ac0ad1eca504d156',
    apiKey: 'cc4dc18efceb494684f374537433a8580fd90ee49302428a8aa4b54a2c51ce33'
  },
  powerwall: {
    host: '192.168.86.144',
    password: 'M.Kr13g3r'
  }
};

// Data files
const DATA_DIR = path.join(__dirname, 'data');
const TIMERS_FILE = path.join(DATA_DIR, 'timers.json');
const HISTORY_FILE = path.join(DATA_DIR, 'powerwall-history.json');
const ANALYTICS_FILE = path.join(DATA_DIR, 'powerwall-analytics.json');
const ALERTS_FILE = path.join(DATA_DIR, 'alerts.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const BASELINES_FILE = path.join(DATA_DIR, "energy-baselines.json");
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const INDEX_HTML = path.join(PUBLIC_DIR, 'index.html');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ═══ SQLite Energy History Database ═══
const DB_PATH = path.join(DATA_DIR, "energy-history.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

// Power samples: every 30s poll
db.exec(`CREATE TABLE IF NOT EXISTS power_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  solar_w REAL,
  battery_w REAL,
  grid_w REAL,
  load_w REAL,
  battery_soe REAL,
  battery_status TEXT
)`);

// Daily energy baselines: cumulative Wh snapshots at midnight
db.exec(`CREATE TABLE IF NOT EXISTS daily_baselines (
  date TEXT PRIMARY KEY,
  solar_exported_wh REAL,
  battery_exported_wh REAL,
  battery_imported_wh REAL,
  grid_imported_wh REAL,
  grid_exported_wh REAL,
  load_imported_wh REAL
)`);

// Indexes for fast queries
db.exec(`CREATE INDEX IF NOT EXISTS idx_power_ts ON power_samples(ts)`);

const insertSample = db.prepare(`INSERT INTO power_samples (ts, solar_w, battery_w, grid_w, load_w, battery_soe, battery_status) VALUES (?, ?, ?, ?, ?, ?, ?)`);
const insertBaseline = db.prepare(`INSERT OR REPLACE INTO daily_baselines (date, solar_exported_wh, battery_exported_wh, battery_imported_wh, grid_imported_wh, grid_exported_wh, load_imported_wh) VALUES (?, ?, ?, ?, ?, ?, ?)`);
const getBaseline = db.prepare(`SELECT * FROM daily_baselines WHERE date = ?`);

console.log("[SQLITE] Energy history database initialized:", DB_PATH);

// Load/initialize data files
function loadJSON(file, defaultValue = {}) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (error) {
    console.warn(`Warning loading ${file}:`, error.message);
  }
  return defaultValue;
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let timers = loadJSON(TIMERS_FILE, []);
let history = loadJSON(HISTORY_FILE, []);
let analytics = loadJSON(ANALYTICS_FILE, []);
let alerts = loadJSON(ALERTS_FILE, []);
let energyBaselines = loadJSON(BASELINES_FILE, {});
let settings = loadJSON(SETTINGS_FILE, {
  theme: 'dark',
  timezone: 'America/New_York',
  alerts: {
    batteryLow: 20,      // % SOE
    batteryHigh: 95,     // % SOE
    gridDown: true,      // Grid power = 0
    highLoad: 5000,      // W
    highTemp: 85,        // °F
    lowTemp: 50          // °F
  }
});

// Code version tracking
let codeVersion = {
  hash: '',
  timestamp: new Date().toISOString(),
  changed: false
};

function calculateCodeHash() {
  try {
    if (fs.existsSync(INDEX_HTML)) {
      const content = fs.readFileSync(INDEX_HTML, 'utf8');
      const hash = crypto.createHash('md5').update(content).digest('hex').substring(0, 8);
      return hash;
    }
  } catch (error) {
    console.error('Error calculating code hash:', error.message);
  }
  return '';
}

codeVersion.hash = calculateCodeHash();

const watcher = chokidar.watch(PUBLIC_DIR, {
  ignored: /(^|[\/\\])\.|node_modules/,
  persistent: true,
  ignoreInitial: true
});

watcher.on('change', (filePath) => {
  const newHash = calculateCodeHash();
  if (newHash !== codeVersion.hash) {
    codeVersion = {
      hash: newHash,
      timestamp: new Date().toISOString(),
      changed: true
    };
    console.log(`✨ Code changed detected! Hash: ${codeVersion.hash}`);
    broadcastUpdate({ type: 'code-update', hash: codeVersion.hash });
  }
});

// Data cache
let cachedData = {
  weather: null,
  temps: null,
  crypto: null,
  powerwall: null,
  lastUpdate: {},
  lastAlert: null
};

// SSE clients
const sseClients = [];

function broadcastUpdate(data) {
  sseClients.forEach((client, index) => {
    try {
      client.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (error) {
      sseClients.splice(index, 1);
    }
  });
}

// ─────────────────────────────────────
// ALERT DETECTION SYSTEM
// ─────────────────────────────────────

function checkAlerts(powerwallData, tempsData) {
  const newAlerts = [];
  const now = new Date().toISOString();

  // Battery alerts
  if (powerwallData.battery.soe <= settings.alerts.batteryLow) {
    newAlerts.push({
      id: 'battery-low',
      type: 'warning',
      severity: 'high',
      title: '🔋 Battery Low',
      message: `Battery at ${powerwallData.battery.soe}% (threshold: ${settings.alerts.batteryLow}%)`,
      timestamp: now
    });
  }

  if (powerwallData.battery.soe >= settings.alerts.batteryHigh) {
    newAlerts.push({
      id: 'battery-high',
      type: 'info',
      severity: 'low',
      title: '🔋 Battery Full',
      message: `Battery at ${powerwallData.battery.soe}% (threshold: ${settings.alerts.batteryHigh}%)`,
      timestamp: now
    });
  }

  // Grid alerts
  if (settings.alerts.gridDown && powerwallData.grid.power <= 0) {
    newAlerts.push({
      id: 'grid-down',
      type: 'error',
      severity: 'critical',
      title: '⚡ Grid Down',
      message: 'Grid power is off - running on battery/solar only',
      timestamp: now
    });
  }

  // Load alerts
  if (powerwallData.load.power >= settings.alerts.highLoad) {
    newAlerts.push({
      id: 'high-load',
      type: 'warning',
      severity: 'medium',
      title: '📊 High Load',
      message: `Load at ${powerwallData.load.power}W (threshold: ${settings.alerts.highLoad}W)`,
      timestamp: now
    });
  }

  // Temperature alerts
  if (tempsData) {
    if (tempsData.inside.temp >= settings.alerts.highTemp) {
      newAlerts.push({
        id: 'high-temp',
        type: 'warning',
        severity: 'high',
        title: '🌡️ High Temperature',
        message: `Inside temp at ${tempsData.inside.temp}°F (threshold: ${settings.alerts.highTemp}°F)`,
        timestamp: now
      });
    }

    if (tempsData.inside.temp <= settings.alerts.lowTemp) {
      newAlerts.push({
        id: 'low-temp',
        type: 'warning',
        severity: 'medium',
        title: '🌡️ Low Temperature',
        message: `Inside temp at ${tempsData.inside.temp}°F (threshold: ${settings.alerts.lowTemp}°F)`,
        timestamp: now
      });
    }
  }

  // Add new alerts to list
  newAlerts.forEach(alert => {
    if (!alerts.find(a => a.id === alert.id)) {
      alerts.push(alert);
      broadcastUpdate({ type: 'alert', data: alert });
    }
  });

  // Keep only last 100 alerts
  alerts = alerts.slice(-100);
  saveJSON(ALERTS_FILE, alerts);

  return newAlerts;
}

// ─────────────────────────────────────
// ANALYTICS ENGINE
// ─────────────────────────────────────

function calculateHourlyAnalytics() {
  const now = new Date();
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);

  const hourlyData = history.filter(h => {
    const timestamp = new Date(h.timestamp);
    return timestamp > hourAgo && timestamp <= now;
  });

  if (hourlyData.length === 0) return null;

  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const max = (arr) => Math.max(...arr);
  const min = (arr) => Math.min(...arr);

  const hour = now.toISOString();
  const analytics_entry = {
    hour,
    grid: {
      avg: Math.round(avg(hourlyData.map(h => h.grid))),
      max: Math.max(...hourlyData.map(h => h.grid)),
      min: Math.min(...hourlyData.map(h => h.grid)),
      samples: hourlyData.length
    },
    solar: {
      avg: Math.round(avg(hourlyData.map(h => h.solar))),
      max: Math.max(...hourlyData.map(h => h.solar)),
      min: Math.min(...hourlyData.map(h => h.solar)),
      total: hourlyData.reduce((sum, h) => sum + (h.solar / 3600 / 1000), 0) // kWh estimate
    },
    load: {
      avg: Math.round(avg(hourlyData.map(h => h.load))),
      max: Math.max(...hourlyData.map(h => h.load)),
      min: Math.min(...hourlyData.map(h => h.load)),
      total: hourlyData.reduce((sum, h) => sum + (h.load / 3600 / 1000), 0)  // kWh estimate
    },
    battery: {
      avgSoe: Math.round(avg(hourlyData.map(h => h.soe))),
      maxSoe: Math.max(...hourlyData.map(h => h.soe)),
      minSoe: Math.min(...hourlyData.map(h => h.soe))
    }
  };

  return analytics_entry;
}

// Save analytics every hour
setInterval(() => {
  const hourlyAnalytics = calculateHourlyAnalytics();
  if (hourlyAnalytics) {
    analytics.push(hourlyAnalytics);
    // Keep only last 30 days (720 hours)
    analytics = analytics.slice(-720);
    saveJSON(ANALYTICS_FILE, analytics);
    broadcastUpdate({ type: 'analytics', data: hourlyAnalytics });
    console.log(`📊 Hourly analytics saved: ${hourlyAnalytics.hour}`);
  }
}, 60 * 60 * 1000); // Every hour

// Middleware
app.use(express.json());
app.use(express.static('public'));

// ─────────────────────────────────────
// HOT RELOAD API
// ─────────────────────────────────────

app.get('/api/code-version', (req, res) => {
  res.json({
    hash: codeVersion.hash,
    timestamp: codeVersion.timestamp,
    changed: codeVersion.changed
  });
});

app.post('/api/code-version/ack', (req, res) => {
  codeVersion.changed = false;
  res.json({ success: true });
});

// ─────────────────────────────────────
// ALERTS API
// ─────────────────────────────────────

/**
 * Get all alerts
 */
app.get('/api/alerts', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  res.json(alerts.slice(-limit).reverse());
});

/**
 * Clear alert
 */
app.delete('/api/alerts/:id', (req, res) => {
  alerts = alerts.filter(a => a.id !== req.params.id);
  saveJSON(ALERTS_FILE, alerts);
  res.json({ success: true });
});

/**
 * Get alert settings
 */
app.get('/api/alerts/settings', (req, res) => {
  res.json(settings.alerts);
});

/**
 * Update alert settings
 */
app.put('/api/alerts/settings', (req, res) => {
  settings.alerts = { ...settings.alerts, ...req.body };
  saveJSON(SETTINGS_FILE, settings);
  res.json(settings.alerts);
});

// ─────────────────────────────────────
// ANALYTICS API
// ─────────────────────────────────────

/**
 * Get hourly analytics
 */
app.get('/api/analytics', (req, res) => {
  const range = req.query.range || '24h';
  let limit = 24; // Default 24 hours

  if (range === '7d') limit = 168;
  else if (range === '30d') limit = 720;

  res.json(analytics.slice(-limit));
});

/**
 * Get analytics summary
 */
app.get('/api/analytics/summary', (req, res) => {
  if (analytics.length === 0) {
    return res.json({ error: 'No analytics data yet' });
  }

  const last24h = analytics.slice(-24);
  const avgGrid = Math.round(last24h.reduce((sum, h) => sum + h.grid.avg, 0) / last24h.length);
  const avgSolar = Math.round(last24h.reduce((sum, h) => sum + h.solar.avg, 0) / last24h.length);
  const avgLoad = Math.round(last24h.reduce((sum, h) => sum + h.load.avg, 0) / last24h.length);
  const totalSolarGen = last24h.reduce((sum, h) => sum + h.solar.total, 0);
  const totalLoadUsed = last24h.reduce((sum, h) => sum + h.load.total, 0);

  res.json({
    period: '24h',
    grid: { avg: avgGrid },
    solar: { avg: avgSolar, total: totalSolarGen.toFixed(2) },
    load: { avg: avgLoad, total: totalLoadUsed.toFixed(2) },
    trend: avgSolar > avgLoad ? 'surplus' : 'deficit',
    peakLoad: Math.max(...last24h.map(h => h.load.max)),
    peakSolar: Math.max(...last24h.map(h => h.solar.max))
  });
});

// ─────────────────────────────────────
// LIVE STREAMING API
// ─────────────────────────────────────

app.get('/api/powerwall/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  sseClients.push(res);
  console.log(`📡 SSE client connected. Total clients: ${sseClients.length}`);

  if (cachedData.powerwall) {
    res.write(`data: ${JSON.stringify({ type: 'powerwall', data: cachedData.powerwall })}\n\n`);
  }

  req.on('close', () => {
    const index = sseClients.indexOf(res);
    if (index !== -1) {
      sseClients.splice(index, 1);
    }
    console.log(`📡 SSE client disconnected. Total clients: ${sseClients.length}`);
  });
});

// ─────────────────────────────────────
// Admin API Routes
// ─────────────────────────────────────

app.get('/api/admin/timers', (req, res) => {
  res.json(timers);
});

app.post('/api/admin/timers', (req, res) => {
  const { name, targetTime, color } = req.body;
  const timer = {
    id: Date.now().toString(),
    name: name || 'Timer',
    targetTime,
    color: color || '#4caf50',
    createdAt: new Date().toISOString()
  };
  timers.push(timer);
  saveJSON(TIMERS_FILE, timers);
  res.json(timer);
});

app.delete('/api/admin/timers/:id', (req, res) => {
  timers = timers.filter(t => t.id !== req.params.id);
  saveJSON(TIMERS_FILE, timers);
  res.json({ success: true });
});

app.get('/api/admin/settings', (req, res) => {
  res.json(settings);
});

app.put('/api/admin/settings', (req, res) => {
  settings = { ...settings, ...req.body };
  saveJSON(SETTINGS_FILE, settings);
  res.json(settings);
});

app.get('/api/admin/history', (req, res) => {
  const range = req.query.range || '24h';
  const now = Date.now();
  let cutoff;

  if (range === '7d') cutoff = now - 7 * 24 * 60 * 60 * 1000;
  else if (range === '30d') cutoff = now - 30 * 24 * 60 * 60 * 1000;
  else cutoff = now - 24 * 60 * 60 * 1000;

  const filtered = history.filter(h => new Date(h.timestamp).getTime() > cutoff);
  res.json(filtered);
});

// SQLite-backed energy history
app.get("/api/energy/history", (req, res) => {
  const days = parseInt(req.query.days) || 1;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const rows = db.prepare("SELECT * FROM power_samples WHERE ts > ? ORDER BY ts").all(cutoff);
  res.json(rows);
});

app.get("/api/energy/daily", (req, res) => {
  const rows = db.prepare("SELECT * FROM daily_baselines ORDER BY date DESC LIMIT 90").all();
  res.json(rows);
});

// ─────────────────────────────────────
// Dashboard API Routes
// ─────────────────────────────────────

app.get('/api/weather', async (req, res) => {
  try {
    const now = Date.now();
    if (cachedData.weather && now - cachedData.lastUpdate.weather < 300000) {
      return res.json(cachedData.weather);
    }

    const currentUrl = `https://api.openweathermap.org/data/2.5/weather?lat=${CONFIG.openWeather.lat}&lon=${CONFIG.openWeather.lon}&units=imperial&appid=${CONFIG.openWeather.apiKey}`;
    const forecastUrl = `https://api.openweathermap.org/data/2.5/forecast?lat=${CONFIG.openWeather.lat}&lon=${CONFIG.openWeather.lon}&units=imperial&appid=${CONFIG.openWeather.apiKey}`;

    const [currentRes, forecastRes] = await Promise.all([
      axios.get(currentUrl),
      axios.get(forecastUrl)
    ]);

    // Calculate moon times if suncalc is available
    let moonTimes = { moonrise: null, moonset: null };
    if (SunCalc) {
      try {
        const moonData = SunCalc.getMoonTimes(new Date(), CONFIG.openWeather.lat, CONFIG.openWeather.lon);
        if (moonData.rise) moonTimes.moonrise = new Date(moonData.rise);
        if (moonData.set) moonTimes.moonset = new Date(moonData.set);
      } catch (e) {
        console.warn('⚠️  Moon calculation error:', e.message);
      }
    }

    // Calculate daily highs/lows from hourly forecast
    const dailyForecasts = {};
    forecastRes.data.list.forEach(f => {
      const date = new Date(f.dt * 1000);
      const dateStr = date.toISOString().split('T')[0];
      
      if (!dailyForecasts[dateStr]) {
        dailyForecasts[dateStr] = {
          date: dateStr,
          high: Math.round(f.main.temp),
          low: Math.round(f.main.temp),
          description: f.weather[0].main,
          icon: f.weather[0].icon
        };
      } else {
        dailyForecasts[dateStr].high = Math.max(dailyForecasts[dateStr].high, Math.round(f.main.temp));
        dailyForecasts[dateStr].low = Math.min(dailyForecasts[dateStr].low, Math.round(f.main.temp));
      }
    });

    // Get unique daily forecasts (up to 5 days)
    const dailyArray = Object.values(dailyForecasts).slice(0, 5);

    cachedData.weather = {
      current: {
        temp: Math.round(currentRes.data.main.temp),
        feelsLike: Math.round(currentRes.data.main.feels_like),
        description: currentRes.data.weather[0].main,
        icon: currentRes.data.weather[0].icon,
        humidity: currentRes.data.main.humidity,
        windSpeed: Math.round(currentRes.data.wind.speed),
        pressure: currentRes.data.main.pressure,
        cloudiness: currentRes.data.clouds.all
      },
      sunrise: new Date(currentRes.data.sys.sunrise * 1000),
      sunset: new Date(currentRes.data.sys.sunset * 1000),
      moonrise: moonTimes.moonrise,
      moonset: moonTimes.moonset,
      forecast: forecastRes.data.list.slice(0, 40).map(f => ({
        time: new Date(f.dt * 1000),
        temp: Math.round(f.main.temp),
        description: f.weather[0].main,
        icon: f.weather[0].icon,
        precipitation: f.rain?.['3h'] || 0,
        precipitationProb: f.pop * 100
      })),
      dailyForecast: dailyArray,
      location: CONFIG.openWeather.location
    };

    cachedData.lastUpdate.weather = now;
    res.json(cachedData.weather);
  } catch (error) {
    console.error('Weather API error:', error.message);
    res.status(500).json({ error: 'Weather data unavailable' });
  }
});

app.get('/api/temps', async (req, res) => {
  try {
    const now = Date.now();
    if (cachedData.temps && now - cachedData.lastUpdate.temps < 600000) {
      return res.json(cachedData.temps);
    }

    const url = `https://rt.ambientweather.net/v1/devices?applicationKey=${CONFIG.ambientWeather.appKey}&apiKey=${CONFIG.ambientWeather.apiKey}`;
    const response = await axios.get(url);

    if (!response.data || response.data.length === 0) {
      throw new Error('No Ambient Weather devices found');
    }

    const data = response.data[0].lastData;

    cachedData.temps = {
      inside: { temp: Math.round(data.tempinf), humidity: data.humidityin },
      basement: { temp: Math.round(data.temp2f), humidity: data.humidity2 },
      outside: { temp: Math.round(data.tempf), humidity: data.humidity },
      pool: { temp: Math.round(data.temp1f) },
      spa: { temp: Math.round(data.temp3f) }
    };

    cachedData.lastUpdate.temps = now;
    res.json(cachedData.temps);
  } catch (error) {
    console.error('Temps API error:', error.message);
    res.status(500).json({ error: 'Temperature data unavailable' });
  }
});

app.get('/api/crypto', async (req, res) => {
  try {
    const now = Date.now();
    if (cachedData.crypto && now - cachedData.lastUpdate.crypto < 60000) {
      return res.json(cachedData.crypto);
    }

    // Fetch from CoinGecko (free, no API key needed)
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true`;
    
    const response = await axios.get(url);
    const btc = response.data.bitcoin;
    const eth = response.data.ethereum;

    cachedData.crypto = {
      btc: {
        price: btc.usd,
        change24h: btc.usd_24h_change.toFixed(2)
      },
      eth: {
        price: eth.usd,
        change24h: eth.usd_24h_change.toFixed(2)
      }
    };

    cachedData.lastUpdate.crypto = now;
    res.json(cachedData.crypto);
  } catch (error) {
    console.error('Crypto error:', error.message);
    res.status(500).json({ error: 'Crypto data unavailable' });
  }
});

async function fetchPowerwallData() {
  try {
    const baseUrl = `https://${CONFIG.powerwall.host}`;

    const loginRes = await axios.post(`${baseUrl}/api/login/Basic`, {
      username: 'customer',
      password: CONFIG.powerwall.password,
      force_sm_off: false
    }, { httpsAgent: new https.Agent({ rejectUnauthorized: false }), timeout: 5000 });

    const token = loginRes.data.token;
    const cookie = `AuthCookie=${token}`;

    const aggregatesRes = await axios.get(`${baseUrl}/api/meters/aggregates`, {
      headers: { Cookie: cookie },
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      timeout: 5000
    });

    const soeRes = await axios.get(`${baseUrl}/api/system_status/soe`, {
      headers: { Cookie: cookie },
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      timeout: 5000
    });

    const agg = aggregatesRes.data;
    const soe = soeRes.data.percentage;

    // Calculate self-powered percentage
    const solarPower = Math.round(agg.solar.instant_power);
    const batteryPower = Math.round(agg.battery.instant_power);
    const loadPower = Math.round(agg.load.instant_power);
    const gridPower = Math.round(agg.site.instant_power);

    // Self-powered % = (load - grid supplied) / load
    // Positive grid = importing from grid
    // Negative grid = exporting to grid
    let selfPoweredPercent = 0;
    let batteryStatus = '';
    
    if (loadPower > 0) {
      // Grid power positive = importing, so self-powered = 100 - (grid/load)
      // Grid power negative = exporting, so self-powered = 100
      const gridSupplied = Math.max(0, gridPower); // Only count positive grid as imported
      selfPoweredPercent = Math.round(((loadPower - gridSupplied) / loadPower) * 100);
      selfPoweredPercent = Math.max(0, Math.min(100, selfPoweredPercent)); // Clamp 0-100
    }

    // Determine battery status
    if (batteryPower > 10) {
      batteryStatus = 'discharging';
    } else if (batteryPower < -10) {
      batteryStatus = 'charging';
    } else {
      batteryStatus = 'standby';
    }

    // Calculate DAILY energy breakdown from cumulative Wh baselines
    const cumSolar = agg.solar.energy_exported;
    const cumBatteryOut = agg.battery.energy_exported;
    const cumBatteryIn = agg.battery.energy_imported;
    const cumGridIn = agg.site.energy_imported;
    const cumGridOut = agg.site.energy_exported;
    const cumLoad = agg.load.energy_imported;

    // Track midnight baselines in SQLite
    const todayKey = new Date().toISOString().slice(0, 10);
    let baseline = getBaseline.get(todayKey);
    if (!baseline) {
      insertBaseline.run(todayKey, cumSolar, cumBatteryOut, cumBatteryIn, cumGridIn, cumGridOut, cumLoad);
      baseline = getBaseline.get(todayKey);
      console.log("[SQLITE] New daily baseline set for", todayKey);
    }

    const daySolar = Math.max(0, cumSolar - (baseline.solar_exported_wh || 0));
    const dayBattery = Math.max(0, cumBatteryOut - (baseline.battery_exported_wh || 0));
    const dayGrid = Math.max(0, cumGridIn - (baseline.grid_imported_wh || 0));
    const dayLoad = Math.max(0, cumLoad - (baseline.load_imported_wh || 0));

    let dailySelfPowered = selfPoweredPercent;
    let dailyBreakdown = { solarPct: 0, batteryPct: 0, gridPct: 0, solarKwh: 0, batteryKwh: 0, gridKwh: 0, loadKwh: 0 };
    if (dayLoad > 0) {
      dailyBreakdown.solarPct = Math.round((daySolar / dayLoad) * 100);
      dailyBreakdown.batteryPct = Math.round((dayBattery / dayLoad) * 100);
      dailyBreakdown.gridPct = Math.round((dayGrid / dayLoad) * 100);
      dailyBreakdown.solarKwh = (daySolar / 1e6).toFixed(1);
      dailyBreakdown.batteryKwh = (dayBattery / 1e6).toFixed(1);
      dailyBreakdown.gridKwh = (dayGrid / 1e6).toFixed(1);
      dailyBreakdown.loadKwh = (dayLoad / 1e6).toFixed(1);
      dailySelfPowered = Math.round(((daySolar + dayBattery) / dayLoad) * 100);
      dailySelfPowered = Math.max(0, Math.min(100, dailySelfPowered));
    }



















    const powerwallData = {
      timestamp: new Date().toISOString(),
      grid: {
        power: gridPower,
        voltage: agg.site.instant_average_voltage,
        current: agg.site.instant_average_current,
        energyExported: (agg.site.energy_exported / 1e6).toFixed(1),
        energyImported: (agg.site.energy_imported / 1e6).toFixed(1),
        isSupplying: gridPower < -100  // Negative = exporting to grid
      },
      battery: {
        power: batteryPower,
        soe: soe,
        voltage: agg.battery.instant_average_voltage,
        current: agg.battery.instant_average_current,
        energyExported: (agg.battery.energy_exported / 1e6).toFixed(1),
        energyImported: (agg.battery.energy_imported / 1e6).toFixed(1),
        status: batteryStatus
      },
      load: {
        power: loadPower,
        voltage: agg.load.instant_average_voltage,
        current: agg.load.instant_average_current,
        energyImported: (agg.load.energy_imported / 1e6).toFixed(1)
      },
      solar: {
        power: solarPower,
        voltage: agg.solar.instant_average_voltage,
        energyExported: (agg.solar.energy_exported / 1e6).toFixed(1)
      },
      selfPoweredPercent: dailySelfPowered,
      dailyBreakdown: dailyBreakdown
    };

    return powerwallData;
  } catch (error) {
    console.error('Powerwall fetch error:', error.message);
    return null;
  }
}

app.get('/api/powerwall', async (req, res) => {
  try {
    const now = Date.now();
    if (cachedData.powerwall && now - cachedData.lastUpdate.powerwall < 15000) {
      return res.json(cachedData.powerwall);
    }

    const powerwallData = await fetchPowerwallData();
    if (!powerwallData) {
      return res.status(500).json({ error: 'Powerwall data unavailable' });
    }

    cachedData.powerwall = powerwallData;
    cachedData.lastUpdate.powerwall = now;

    history.push({
      timestamp: powerwallData.timestamp,
      grid: powerwallData.grid.power,
      battery: powerwallData.battery.power,
      solar: powerwallData.solar.power,
      load: powerwallData.load.power,
      soe: powerwallData.battery.soe
    });

    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    history = history.filter(h => new Date(h.timestamp).getTime() > cutoff);
    saveJSON(HISTORY_FILE, history);

    // Log to SQLite
    try {
      console.log("[SQLITE] Inserting sample..."); insertSample.run(powerwallData.timestamp, powerwallData.solar.power, powerwallData.battery.power, powerwallData.grid.power, powerwallData.load.power, powerwallData.battery.soe, powerwallData.battery.status);
    } catch (e) { console.error("[SQLITE] Insert error:", e.message); }

    // Check alerts
    const tempsData = cachedData.temps;
    checkAlerts(powerwallData, tempsData);

    broadcastUpdate({ type: 'powerwall', data: cachedData.powerwall });

    res.json(cachedData.powerwall);
  } catch (error) {
    console.error('Powerwall API error:', error.message);
    res.status(500).json({ error: 'Powerwall data unavailable' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date(),
    ssClients: sseClients.length,
    powerwallCache: cachedData.powerwall ? 'cached' : 'empty',
    history: `${history.length} points`,
    analytics: `${analytics.length} hours`,
    alerts: `${alerts.length} total`,
    activeAlerts: alerts.filter(a => a.severity === 'critical' || a.severity === 'high').length
  });
});

// Polling for SSE broadcast
setInterval(async () => {
  if (sseClients.length > 0) {
    const data = await fetchPowerwallData();
    if (data) {
      cachedData.powerwall = data;
      history.push({
        timestamp: data.timestamp,
        grid: data.grid.power,
        battery: data.battery.power,
        solar: data.solar.power,
        load: data.load.power,
        soe: data.battery.soe
      });
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      history = history.filter(h => new Date(h.timestamp).getTime() > cutoff);
      
      saveJSON(HISTORY_FILE, history);
      // Log to SQLite
      try { insertSample.run(data.timestamp, data.solar.power, data.battery.power, data.grid.power, data.load.power, data.battery.soe, data.battery.status); } catch(e) { console.error("[SQLITE] Insert error:", e.message); }
      // Check for alerts
      checkAlerts(data, cachedData.temps);
      
      broadcastUpdate({ type: 'powerwall', data });
    }
  }
}, 10000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎯 Wall Dashboard v5 (Alerts + Analytics) running on http://0.0.0.0:${PORT}`);
  console.log(`✨ Hot-reload enabled`);
  console.log(`📡 Live Powerwall streaming`);
  console.log(`🚨 Real-time Alerts active`);
  console.log(`📊 Analytics engine running`);
  console.log(`⚡ Powerwall: ${CONFIG.powerwall.host}`);
});

process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down gracefully...');
  watcher.close();
  db.close();
  console.log("[SQLITE] Database closed.");
  process.exit(0);
});

// Force refresh endpoint (for remote refreshing wall displays)
app.post('/api/force-refresh', (req, res) => {
  console.log('[REFRESH] 🔄 Force refresh triggered from API');
  
  // Update code version to trigger browser refresh
  codeVersion.changed = true;
  codeVersion.hash = Date.now().toString(36);
  codeVersion.timestamp = new Date().toISOString();
  
  // Broadcast to all SSE clients
  ssClients.forEach(client => {
    client.write('data: {"command": "refresh"}\n\n');
  });
  
  res.json({ 
    success: true, 
    message: 'Refresh command sent to all clients',
    clientsNotified: ssClients.length
  });
});
