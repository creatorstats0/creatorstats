import express from 'express';
import { query, pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { calculateEntryPnl, calculateTradeTotals } from '../services/calculations.js';

const router = express.Router();

// POST /api/trades - log a new trade with one or more entries
// Body: { event_id, event_question_snapshot, entries: [{ side, buy_price, sell_price, quantity }] }
router.post('/', requireAuth, async (req, res) => {
  const { event_id, event_question_snapshot, entries } = req.body;

  if (!Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ error: 'At least one trade entry is required' });
  }

  for (const e of entries) {
    if (!['yes', 'no'].includes(e.side) || e.buy_price == null || e.sell_price == null || e.quantity == null) {
      return res.status(400).json({ error: 'Each entry needs side, buy_price, sell_price, and quantity' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const entryPnls = entries.map(e => calculateEntryPnl(e.buy_price, e.sell_price, e.quantity));
    const { grossProfit, totalLosses, commission, netProfit } = calculateTradeTotals(entryPnls);

    const tradeResult = await client.query(
      `INSERT INTO trades (user_id, event_id, event_question_snapshot, gross_profit, total_losses, commission, net_profit)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.user.id, event_id || null, event_question_snapshot || null, grossProfit, totalLosses, commission, netProfit]
    );
    const trade = tradeResult.rows[0];

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      await client.query(
        `INSERT INTO trade_entries (trade_id, side, buy_price, sell_price, quantity, pnl)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [trade.id, e.side, e.buy_price, e.sell_price, e.quantity, entryPnls[i]]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ trade });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to log trade' });
  } finally {
    client.release();
  }
});

// GET /api/trades - personal trade history with entries (My trades tab)
router.get('/', requireAuth, async (req, res) => {
  try {
    const tradesResult = await query(
      'SELECT * FROM trades WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100',
      [req.user.id]
    );
    const trades = tradesResult.rows;

    const tradeIds = trades.map(t => t.id);
    let entriesByTrade = {};
    if (tradeIds.length > 0) {
      const entriesResult = await query(
        'SELECT * FROM trade_entries WHERE trade_id = ANY($1) ORDER BY created_at ASC',
        [tradeIds]
      );
      for (const entry of entriesResult.rows) {
        if (!entriesByTrade[entry.trade_id]) entriesByTrade[entry.trade_id] = [];
        entriesByTrade[entry.trade_id].push(entry);
      }
    }

    const tradesWithEntries = trades.map(t => ({
      ...t,
      entries: entriesByTrade[t.id] || []
    }));

    res.json({ trades: tradesWithEntries });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch trades' });
  }
});

// GET /api/trades/stats - aggregated stats for Stats tab
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const result = await query('SELECT * FROM trades WHERE user_id = $1 ORDER BY created_at ASC', [req.user.id]);
    const trades = result.rows;

    if (trades.length === 0) {
      return res.json({ stats: emptyStats() });
    }

    const wins = trades.filter(t => parseFloat(t.net_profit) > 0);
    const losses = trades.filter(t => parseFloat(t.net_profit) <= 0);

    const totalGross = trades.reduce((s, t) => s + parseFloat(t.gross_profit), 0);
    const totalCommission = trades.reduce((s, t) => s + parseFloat(t.commission), 0);
    const totalLosses = trades.reduce((s, t) => s + parseFloat(t.total_losses), 0);
    const totalNet = trades.reduce((s, t) => s + parseFloat(t.net_profit), 0);

    // current streak: count from most recent trade backwards while same win/loss state
    let currentStreak = 0;
    let streakType = null;
    for (let i = trades.length - 1; i >= 0; i--) {
      const isWin = parseFloat(trades[i].net_profit) > 0;
      if (streakType === null) {
        streakType = isWin;
        currentStreak = 1;
      } else if (isWin === streakType) {
        currentStreak++;
      } else {
        break;
      }
    }

    // best streak: longest run of wins
    let bestStreak = 0, runningStreak = 0;
    for (const t of trades) {
      if (parseFloat(t.net_profit) > 0) {
        runningStreak++;
        bestStreak = Math.max(bestStreak, runningStreak);
      } else {
        runningStreak = 0;
      }
    }

    const biggestWin = Math.max(...trades.map(t => parseFloat(t.net_profit)), 0);
    const biggestLoss = Math.min(...trades.map(t => parseFloat(t.net_profit)), 0);
    const profitFactor = Math.abs(totalLosses) > 0 ? totalGross / Math.abs(totalLosses) : totalGross > 0 ? Infinity : 0;

    res.json({
      stats: {
        net_profit: round2(totalNet),
        gross_profit: round2(totalGross),
        commission_paid: round2(totalCommission),
        total_losses: round2(totalLosses),
        win_rate: Math.round((wins.length / trades.length) * 100),
        total_trades: trades.length,
        winning_trades: wins.length,
        losing_trades: losses.length,
        current_streak: `${currentStreak} ${streakType ? 'W' : 'L'}`,
        best_streak: `${bestStreak} W`,
        avg_net_profit: round2(totalNet / trades.length),
        biggest_win: round2(biggestWin),
        biggest_loss: round2(biggestLoss),
        profit_factor: profitFactor === Infinity ? '∞' : profitFactor.toFixed(2)
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to compute stats' });
  }
});

function emptyStats() {
  return {
    net_profit: 0, gross_profit: 0, commission_paid: 0, total_losses: 0,
    win_rate: 0, total_trades: 0, winning_trades: 0, losing_trades: 0,
    current_streak: '0', best_streak: '0 W', avg_net_profit: 0,
    biggest_win: 0, biggest_loss: 0, profit_factor: '0.00'
  };
}
function round2(n) { return Math.round(n * 100) / 100; }

export default router;
