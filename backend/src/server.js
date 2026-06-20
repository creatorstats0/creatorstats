import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import cron from 'node-cron';

import bcrypt from 'bcryptjs';
import authRoutes from './routes/auth.js';
import videoRoutes from './routes/videos.js';
import eventRoutes from './routes/events.js';
import tradeRoutes from './routes/trades.js';
import moneyRoutes from './routes/money.js';
import ruleRoutes from './routes/rules.js';
import { fetchAllActiveVideoSnapshots } from './services/youtubeFetch.js';
import { query } from './db/pool.js';

dotenv.config();

const app = express();

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

// Health check - useful for cron-job.org to ping and keep Render awake
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ONE-TIME admin setup route (workaround for Render Shell being a paid feature).
// Visit this once in the browser to create your first admin account.
// Requires SETUP_SECRET env var to match the ?secret= query param, so randoms can't call it.
// Automatically refuses to run again once any admin account already exists.
app.get('/api/setup-admin', async (req, res) => {
  try {
    const providedSecret = req.query.secret;
    if (!process.env.SETUP_SECRET || providedSecret !== process.env.SETUP_SECRET) {
      return res.status(403).json({ error: 'Invalid or missing setup secret' });
    }

    const existingAdmin = await query("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
    if (existingAdmin.rows.length > 0) {
      return res.status(400).json({ error: 'An admin account already exists. This setup route is now disabled.' });
    }

    const name = process.env.SEED_ADMIN_NAME || 'Admin';
    const email = (process.env.SEED_ADMIN_EMAIL || 'admin@creatorstats.local').toLowerCase();
    const password = process.env.SEED_ADMIN_PASSWORD || 'changeme123';

    const passwordHash = await bcrypt.hash(password, 10);
    await query(
      `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, 'admin')`,
      [name, email, passwordHash]
    );

    res.json({
      success: true,
      message: 'Admin account created. You can now log in.',
      email,
      note: 'Change this password after your first login. This setup route will refuse to run again.'
    });
  } catch (err) {
    console.error('Setup admin error:', err);
    res.status(500).json({ error: 'Failed to create admin account' });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/videos', videoRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/trades', tradeRoutes);
app.use('/api/money', moneyRoutes);
app.use('/api/rules', ruleRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Error handler (catches anything thrown in routes that wasn't caught locally)
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`CreatorStats backend running on port ${PORT}`);
});

// Background job: fetch YouTube view counts every 5 minutes.
// This is what makes the data collection work WITHOUT needing the browser tab open.
cron.schedule('*/5 * * * *', () => {
  console.log('[cron] Running 5-minute view snapshot fetch...');
  fetchAllActiveVideoSnapshots();
});

// Run once immediately on startup so there's data right away
fetchAllActiveVideoSnapshots();
