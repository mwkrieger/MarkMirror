# MarkMirror

A beautiful, real-time wall dashboard for home energy management, weather, crypto prices, and more.

## Features

- **Real-time Powerwall Monitoring** — Live solar production, battery state, grid flow, and self-powered percentage
- **Weather & Forecasts** — Current conditions with high/low temperatures for 5-day forecast
- **Crypto Prices** — BTC and ETH with 24h change indicators
- **Temperature Tiles** — Inside, basement, outside, and pool temps with color-coded status
- **24-Hour Power Flow Graph** — Load vs solar production over the last 24 hours
- **Sunrise/Sunset/Moonrise/Moonset** — Visual indicators for celestial events
- **Hot-Reload** — Auto-updates all connected kiosk screens when code changes
- **Admin Dashboard** — Countdown timers, historical data export, settings management

## Tech Stack

- **Backend:** Node.js + Express.js
- **Frontend:** Vanilla JavaScript (no framework overhead)
- **Real-time:** Server-Sent Events (SSE) for efficient Powerwall streaming
- **File Watching:** Chokidar for hot-reload on code changes
- **APIs:** 
  - OpenWeatherMap (weather)
  - CoinGecko (crypto, no API key needed)
  - Tesla Powerwall (local gateway API)
  - Ambient Weather (temperature sensors)

## Setup

### Requirements
- Node.js 18+
- Tesla Powerwall with local gateway access
- OpenWeatherMap API key (free tier)
- Ambient Weather API key (for temperature data)

### Installation

```bash
npm install
```

### Configuration

Edit `src/server.js` and update the CONFIG object with your:
- Powerwall IP and credentials
- OpenWeatherMap API key and location
- Ambient Weather API keys
- Your zip code (for weather)

### Running

```bash
npm start
```

Server runs on `http://localhost:3000`

## Dashboard Layout

- **Top Left:** Time, date, sunrise/sunset/moon times, countdown timers
- **Top Middle:** BTC & ETH prices with 24h changes
- **Top Right:** Current weather, 5-day forecast, temperature tiles (inside, basement, outside, pool)
- **Main:** Powerwall status (battery %, self-powered %, solar production, grid flow, load usage)
- **Charts:** 24-hour power flow (load vs solar)
- **Bottom:** Grid status and news ticker

## API Endpoints

- `GET /api/weather` — Current weather + 5-day daily highs/lows + sunrise/sunset/moon times
- `GET /api/temps` — Temperature data from Ambient Weather
- `GET /api/crypto` — BTC and ETH prices with 24h changes
- `GET /api/powerwall` — Powerwall data (solar, battery, load, grid, self-powered %)
- `GET /api/powerwall/stream` — Server-Sent Events stream (real-time updates)
- `GET /api/admin/timers` — Countdown timers
- `POST /api/admin/timers` — Create new timer
- `DELETE /api/admin/timers/:id` — Delete timer
- `GET /api/admin/history` — Historical power data (24h, 7d, 30d)

## Polling Intervals

- **Powerwall:** 10 seconds (via SSE, shared across all clients)
- **Weather:** 5 minutes
- **Crypto:** 1 minute
- **Temps:** 10 minutes

## Color-Coded Temperature Ranges

- 🔵 **Cold:** < 55°F (blue gradient)
- 🟠 **Warmer:** 55-70°F (amber/orange)
- 🟢 **Lovely:** 70-80°F (green)
- 🔴 **Hot:** > 80°F (red)

## Self-Powered Calculation

```
Self-Powered % = (Load - Grid Supplied) / Load * 100
```

- If grid is importing 980W and load is 990W → 1% self-powered
- If grid is exporting (-20W) and load is 990W → 100% self-powered

## License

MIT
