import express from 'express';
import { query } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { calculateWithdrawalCommission } from '../services/calculations.js';

const router = express.Router();

// POST /api/money - add a deposit or withdrawal entry
router.post('/', requireAuth, async (req, res) => {
  const { type, amount } = req.body;
  if (!['deposit', 'withdrawal'].includes(type) || !amount || amount <= 0) {
    return res.status(400).json({ error: 'type must be deposit/withdrawal and amount must be > 0' });
  }

  try {
    const withdrawalCommission = type === 'withdrawal' ? calculateWithdrawalCommission(amount) : 0;

    const result = await query(
      `INSERT INTO money_log (user_id, type, amount, withdrawal_commission)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.user.id, type, amount, withdrawalCommission]
    );

    res.status(201).json({ entry: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add money entry' });
  }
});

// GET /api/money - log of all entries + overall profitability summary
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM money_log WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    const entries = result.rows;

    const totalDeposited = entries
      .filter(e => e.type === 'deposit')
      .reduce((s, e) => s + parseFloat(e.amount), 0);

    const totalWithdrawn = entries
      .filter(e => e.type === 'withdrawal')
      .reduce((s, e) => s + parseFloat(e.amount), 0);

    const totalWithdrawalCommission = entries
      .filter(e => e.type === 'withdrawal')
      .reduce((s, e) => s + parseFloat(e.withdrawal_commission), 0);

    const netPnl = totalWithdrawn - totalDeposited;
    const finalNet = netPnl - totalWithdrawalCommission;

    res.json({
      entries,
      summary: {
        total_deposited: round2(totalDeposited),
        total_withdrawn: round2(totalWithdrawn),
        net_pnl: round2(netPnl),
        withdrawal_commission: round2(totalWithdrawalCommission),
        final_net: round2(finalNet)
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch money log' });
  }
});

// GET /api/money/balance - current trading balance, used by the Rules tab risk calculator.
// Balance = deposits (money put in to trade with) - withdrawals (money taken out)
// + net trading profit/loss so far. This reflects what's actually available to trade with right now.
router.get('/balance', requireAuth, async (req, res) => {
  try {
    const moneyResult = await query('SELECT type, amount FROM money_log WHERE user_id = $1', [req.user.id]);
    const depositsMinusWithdrawals = moneyResult.rows.reduce((sum, e) => {
      return e.type === 'deposit' ? sum + parseFloat(e.amount) : sum - parseFloat(e.amount);
    }, 0);

    const tradesResult = await query('SELECT net_profit FROM trades WHERE user_id = $1', [req.user.id]);
    const netTradingPnl = tradesResult.rows.reduce((sum, t) => sum + parseFloat(t.net_profit), 0);

    const balance = depositsMinusWithdrawals + netTradingPnl;
    res.json({ balance: round2(balance) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to compute balance' });
  }
});

function round2(n) { return Math.round(n * 100) / 100; }

export default router;
