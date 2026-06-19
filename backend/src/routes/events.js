import express from 'express';
import { query } from '../db/pool.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import {
  calculateRequiredPerInterval,
  calculateActualFiveMinAvg,
  getCurrentTimeBias,
  getWeightedSide
} from '../services/calculations.js';

const router = express.Router();

// GET /api/events - list active events for today's video (home screen, no metrics)
router.get('/', requireAuth, async (req, res) => {
  try {
    const videoResult = await query(
      'SELECT id FROM videos WHERE is_active = TRUE ORDER BY created_at DESC LIMIT 1'
    );
    const video = videoResult.rows[0];
    if (!video) return res.json({ events: [] });

    const eventsResult = await query(
      'SELECT * FROM events WHERE video_id = $1 AND is_active = TRUE ORDER BY deadline ASC',
      [video.id]
    );

    const snapshotResult = await query(
      'SELECT views FROM view_snapshots WHERE video_id = $1 ORDER BY fetched_at DESC LIMIT 1',
      [video.id]
    );
    const currentViews = snapshotResult.rows[0]?.views ?? 0;

    const timeBias = getCurrentTimeBias();
    const weightedSide = getWeightedSide(timeBias.bias);

    // Home screen only gets minimal info: question, deadline, on-track status, weighted side
    const events = eventsResult.rows.map(event => {
      const { viewsNeeded, requiredPerInterval } = calculateRequiredPerInterval(
        currentViews, event.target_views, event.deadline
      );
      return {
        id: event.id,
        question: event.question,
        deadline: event.deadline,
        on_track: viewsNeeded <= 0 || requiredPerInterval <= 0,
        weighted_side: weightedSide
      };
    });

    res.json({ events, time_bias: timeBias });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

// GET /api/events/:id - full detail with all metrics (only loaded when tapped)
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const eventResult = await query('SELECT * FROM events WHERE id = $1', [req.params.id]);
    const event = eventResult.rows[0];
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const snapshotsResult = await query(
      'SELECT views, fetched_at FROM view_snapshots WHERE video_id = $1 ORDER BY fetched_at ASC',
      [event.video_id]
    );
    const snapshots = snapshotsResult.rows;
    const currentViews = snapshots.length ? snapshots[snapshots.length - 1].views : 0;

    const { viewsNeeded, minutesLeft, intervalsLeft, requiredPerInterval } =
      calculateRequiredPerInterval(currentViews, event.target_views, event.deadline);

    const actualFiveMinAvg = calculateActualFiveMinAvg(snapshots);
    const difference = actualFiveMinAvg - requiredPerInterval;

    res.json({
      event,
      metrics: {
        current_views: currentViews,
        target_views: event.target_views,
        views_needed: viewsNeeded,
        minutes_left: minutesLeft,
        intervals_left: intervalsLeft,
        required_per_interval: requiredPerInterval,
        actual_five_min_avg: actualFiveMinAvg,
        difference,
        status: difference >= 0 ? 'good' : 'bad'
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch event detail' });
  }
});

// GET /api/events/:id/intervals?type=5min|hourly - data table for sub-tabs
router.get('/:id/intervals', requireAuth, async (req, res) => {
  const type = req.query.type === 'hourly' ? 'hourly' : '5min';

  try {
    const eventResult = await query('SELECT video_id FROM events WHERE id = $1', [req.params.id]);
    const event = eventResult.rows[0];
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const snapshotsResult = await query(
      'SELECT views, fetched_at FROM view_snapshots WHERE video_id = $1 ORDER BY fetched_at ASC',
      [event.video_id]
    );
    const snapshots = snapshotsResult.rows;

    if (type === '5min') {
      // Each row IS a 5-min snapshot already (cron runs every 5 min), just compute deltas
      const rows = snapshots.map((s, i) => ({
        time: s.fetched_at,
        views: s.views,
        gained: i === 0 ? 0 : s.views - snapshots[i - 1].views
      }));
      return res.json({ intervals: rows });
    }

    // Hourly: bucket snapshots by hour, take first/last in each bucket
    const hourBuckets = {};
    for (const s of snapshots) {
      const hourKey = new Date(s.fetched_at).toISOString().slice(0, 13); // YYYY-MM-DDTHH
      if (!hourBuckets[hourKey]) hourBuckets[hourKey] = [];
      hourBuckets[hourKey].push(s);
    }
    const hourlyRows = Object.entries(hourBuckets).map(([hourKey, group], i, all) => {
      const lastInHour = group[group.length - 1];
      const prevGroup = i > 0 ? all[i - 1][1] : null;
      const prevLast = prevGroup ? prevGroup[prevGroup.length - 1] : null;
      return {
        hour: hourKey,
        views: lastInHour.views,
        gained: prevLast ? lastInHour.views - prevLast.views : 0
      };
    });

    res.json({ intervals: hourlyRows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch interval data' });
  }
});

// POST /api/events - admin only, add a new event
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  const { question, target_views, deadline } = req.body;
  if (!question || !target_views || !deadline) {
    return res.status(400).json({ error: 'question, target_views, and deadline are required' });
  }

  try {
    const videoResult = await query(
      'SELECT id FROM videos WHERE is_active = TRUE ORDER BY created_at DESC LIMIT 1'
    );
    const video = videoResult.rows[0];
    if (!video) return res.status(400).json({ error: 'No active video set. Add today\'s video first.' });

    const result = await query(
      `INSERT INTO events (video_id, question, target_views, deadline, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [video.id, question, target_views, deadline, req.user.id]
    );

    res.status(201).json({ event: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create event' });
  }
});

// DELETE /api/events/:id - admin only
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await query('UPDATE events SET is_active = FALSE WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete event' });
  }
});

export default router;
