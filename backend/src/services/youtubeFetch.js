import axios from 'axios';
import { query } from '../db/pool.js';

const YOUTUBE_API_URL = 'https://www.googleapis.com/youtube/v3/videos';

// Fetches current view count for a single YouTube video ID.
// Uses only 1 API unit per call - well within the free 10,000/day quota.
export async function fetchViewCount(youtubeVideoId) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    throw new Error('YOUTUBE_API_KEY is not set in environment variables');
  }

  const response = await axios.get(YOUTUBE_API_URL, {
    params: {
      part: 'statistics',
      id: youtubeVideoId,
      key: apiKey
    }
  });

  const item = response.data.items?.[0];
  if (!item) {
    throw new Error(`No video found for YouTube ID: ${youtubeVideoId}`);
  }

  return parseInt(item.statistics.viewCount, 10);
}

// Runs every 5 minutes via cron. Fetches views for all active videos
// and stores a snapshot row. This is what makes the website NOT require
// the browser tab to stay open - data collection happens on the server.
export async function fetchAllActiveVideoSnapshots() {
  try {
    const activeVideos = await query('SELECT id, youtube_video_id, title FROM videos WHERE is_active = TRUE');

    for (const video of activeVideos.rows) {
      try {
        const views = await fetchViewCount(video.youtube_video_id);
        await query(
          'INSERT INTO view_snapshots (video_id, views, fetched_at) VALUES ($1, $2, NOW())',
          [video.id, views]
        );
        console.log(`[snapshot] ${video.title}: ${views.toLocaleString()} views`);
      } catch (err) {
        console.error(`[snapshot] Failed to fetch video ${video.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[snapshot] Failed to load active videos:', err.message);
  }
}
