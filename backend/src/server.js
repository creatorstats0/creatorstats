import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import cron from 'node-cron';

import authRoutes from './routes/auth.js';
import videoRoutes from './routes/videos.js';
import eventRoutes from './routes/events.js';
import tradeRoutes from './routes/trades.js';
import moneyRoutes from './routes/money.js';
import ruleRoutes from './routes/rules.js';
import { fetchAllActiveVideoSnapshots } from './services/youtubeFetch.js';

dotenv.config();

const app = express();

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

// Health check - useful for cron-job.org to ping and keep Render awake
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
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
