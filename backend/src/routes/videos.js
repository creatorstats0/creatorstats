import express from 'express';
import { query } from '../db/pool.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { fetchViewCount } from '../services/youtubeFetch.js';

const router = express.Router();

// GET /api/videos/today - get today's active video with live view count
router.get('/today', requireAuth, async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM videos WHERE is_active = TRUE ORDER BY created_at DESC LIMIT 1'
    );
    const video = result.rows[0];
    if (!video) return res.json({ video: null });

    const latestSnapshot = await query(
      'SELECT views, fetched_at FROM view_snapshots WHERE video_id = $1 ORDER BY fetched_at DESC LIMIT 1',
      [video.id]
    );

    res.json({
      video: {
        ...video,
        current_views: latestSnapshot.rows[0]?.views ?? null,
        last_updated: latestSnapshot.rows[0]?.fetched_at ?? null
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch today\'s video' });
  }
});

// POST /api/videos - admin only, sets today's video (deactivates previous one)
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  const { youtube_video_id, title } = req.body;
  if (!youtube_video_id || !title) {
    return res.status(400).json({ error: 'youtube_video_id and title required' });
  }

  try {
    // Verify the video actually exists on YouTube before saving
    await fetchViewCount(youtube_video_id);

    // YouTube serves thumbnails at predictable URLs based on video ID - no extra API call needed.
    // maxresdefault is highest quality; not every video has one, so the frontend falls back
    // to hqdefault (which always exists) if maxresdefault fails to load.
    const thumbnailUrl = `https://i.ytimg.com/vi/${youtube_video_id}/maxresdefault.jpg`;

    await query('UPDATE videos SET is_active = FALSE WHERE is_active = TRUE');

    const result = await query(
      `INSERT INTO videos (youtube_video_id, title, thumbnail_url, created_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [youtube_video_id, title, thumbnailUrl, req.user.id]
    );

    // Take an immediate first snapshot so the dashboard isn't empty
    const views = await fetchViewCount(youtube_video_id);
    await query(
      'INSERT INTO view_snapshots (video_id, views) VALUES ($1, $2)',
      [result.rows[0].id, views]
    );

    res.status(201).json({ video: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to set today\'s video. Check the YouTube video ID is correct.' });
  }
});

// PATCH /api/videos/:id/rating - admin only, sets the daily admin rating
router.patch('/:id/rating', requireAuth, requireAdmin, async (req, res) => {
  const { rating } = req.body;
  const validRatings = ['bad', 'neutral', 'good', 'very_good'];
  if (!validRatings.includes(rating)) {
    return res.status(400).json({ error: `Rating must be one of: ${validRatings.join(', ')}` });
  }

  try {
    const result = await query(
      'UPDATE videos SET admin_rating = $1 WHERE id = $2 RETURNING *',
      [rating, req.params.id]
    );
    res.json({ video: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update rating' });
  }
});

// GET /api/videos/:id/snapshots - most recent raw snapshots for a video (Raw tab), newest first.
// Only returns rows where the view count actually CHANGED from the previous fetch -
// YouTube's public counter often doesn't tick every 10 seconds, so without this filter
// the Raw tab would be full of repeated "+0" rows that add noise without information.
router.get('/:id/snapshots', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `WITH labeled AS (
         SELECT
           views,
           fetched_at,
           LAG(views) OVER (ORDER BY fetched_at ASC) AS prev_views
         FROM view_snapshots
         WHERE video_id = $1
       )
       SELECT views, fetched_at, prev_views
       FROM labeled
       WHERE prev_views IS NULL OR views != prev_views
       ORDER BY fetched_at DESC
       LIMIT 200`,
      [req.params.id]
    );
    res.json({ snapshots: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch snapshots' });
  }
});

export default router;
