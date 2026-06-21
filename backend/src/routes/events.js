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

// GET /api/events/:id/intervals?type=5min|hourly - bucketed data tables for sub-tabs
router.get('/:id/intervals', requireAuth, async (req, res) => {
  const type = req.query.type === 'hourly' ? 'hourly' : '5min';

  try {
    const eventResult = await query('SELECT video_id FROM events WHERE id = $1', [req.params.id]);
    const event = eventResult.rows[0];
    if (!event) return res.status(404).json({ error: 'Event not found' });

    // Always fetch in chronological order first so delta math (gained = current - previous) is correct.
    const snapshotsResult = await query(
      'SELECT views, fetched_at FROM view_snapshots WHERE video_id = $1 ORDER BY fetched_at ASC',
      [event.video_id]
    );
    const snapshots = snapshotsResult.rows;

    const bucketMinutes = type === 'hourly' ? 60 : 5;
    const buckets = bucketByMinutes(snapshots, bucketMinutes);

    res.json({ intervals: buckets.reverse() }); // newest first for display
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch interval data' });
  }
});

// Groups snapshots into fixed-size time buckets (e.g. 5-min or 60-min windows).
// Each bucket reports the LAST views value seen in that window, and how much
// was gained since the previous bucket's last value. Returns full ISO timestamps
// (not truncated strings) so the frontend's `new Date(...)` always parses correctly -
// this is what fixes the "Invalid Date" bug in the Hourly tab.
function bucketByMinutes(snapshots, bucketMinutes) {
  if (snapshots.length === 0) return [];

  const bucketMs = bucketMinutes * 60 * 1000;
  const buckets = new Map(); // bucketStartMs -> array of snapshots

  for (const s of snapshots) {
    const t = new Date(s.fetched_at).getTime();
    const bucketStart = Math.floor(t / bucketMs) * bucketMs;
    if (!buckets.has(bucketStart)) buckets.set(bucketStart, []);
    buckets.get(bucketStart).push(s);
  }

  const orderedStarts = Array.from(buckets.keys()).sort((a, b) => a - b);
  const rows = [];
  let prevViews = null;

  for (const bucketStart of orderedStarts) {
    const group = buckets.get(bucketStart);
    const lastInBucket = group[group.length - 1];
    rows.push({
      bucket_start: new Date(bucketStart).toISOString(),
      bucket_end: new Date(bucketStart + bucketMs).toISOString(),
      views: lastInBucket.views,
      gained: prevViews !== null ? lastInBucket.views - prevViews : 0
    });
    prevViews = lastInBucket.views;
  }

  return rows;
}

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
