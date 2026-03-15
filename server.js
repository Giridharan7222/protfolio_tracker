require('dotenv').config();
const express = require('express');
const cors = require('cors');
const https = require('https');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS visits (
      id           SERIAL PRIMARY KEY,
      first_seen   TIMESTAMPTZ DEFAULT NOW(),
      last_seen    TIMESTAMPTZ DEFAULT NOW(),
      visit_count  INTEGER DEFAULT 1,
      ip           VARCHAR(50),
      city         VARCHAR(100),
      region       VARCHAR(100),
      country      VARCHAR(10),
      org          VARCHAR(200),
      timezone     VARCHAR(100),
      loc          VARCHAR(50),
      browser      TEXT,
      referrer     TEXT,
      page         VARCHAR(500),
      screen       VARCHAR(20),
      language     VARCHAR(20),
      UNIQUE (ip, browser)
    );
  `);
  console.log('DB ready — visits table ensured');
}

function getIPInfo(ip) {
  return new Promise((resolve) => {
    if (!ip || ip === '::1' || ip.startsWith('127.') || ip.startsWith('192.168.') || ip.startsWith('10.')) {
      return resolve({ ip, note: 'local/private IP' });
    }
    const token = process.env.IPINFO_TOKEN;
    https.get(`https://ipinfo.io/${ip}/json?token=${token}`, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ ip }); }
      });
    }).on('error', () => resolve({ ip }));
  });
}

app.post('/track', async (req, res) => {
  // Always respond with 1x1 transparent GIF immediately
  const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.set('Content-Type', 'image/gif');
  res.set('Cache-Control', 'no-store');
  res.send(pixel);

  // Save to DB in background — user already got response
  try {
    const forwarded = req.headers['x-forwarded-for'];
    const ip = forwarded ? forwarded.split(',')[0].trim() : req.socket.remoteAddress;
    const info = await getIPInfo(ip);

    const browser = req.body.userAgent || req.headers['user-agent'] || null;

    await pool.query(
      `INSERT INTO visits (ip, city, region, country, org, timezone, loc, browser, referrer, page, screen, language)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (ip, browser)
       DO UPDATE SET
         last_seen   = NOW(),
         visit_count = visits.visit_count + 1,
         page        = EXCLUDED.page,
         referrer    = EXCLUDED.referrer`,
      [
        ip,
        info.city || null,
        info.region || null,
        info.country || null,
        info.org || null,
        info.timezone || null,
        info.loc || null,
        browser,
        req.body.referrer || null,
        req.body.page || '/',
        req.body.screenResolution || null,
        req.body.language || null,
      ]
    );
  } catch (err) {
    console.error('Track insert error:', err.message);
  }
});

// Dashboard — view all visits
app.get('/dashboard', async (req, res) => {
  const { rows, rowCount } = await pool.query('SELECT * FROM visits ORDER BY timestamp DESC');
  res.json({ total: rowCount, visits: rows });
});

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Tracker running on http://localhost:${PORT}`);
    console.log(`Dashboard: http://localhost:${PORT}/dashboard`);
  });
}).catch((err) => {
  console.error('Failed to connect to DB:', err.message);
  process.exit(1);
});
