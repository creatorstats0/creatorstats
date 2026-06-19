import express from 'express';
import { query } from '../db/pool.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { calculateSuggestedRisk, getCurrentTimeBias } from '../services/calculations.js';

const router = express.Router();

// GET /api/rules - all rules grouped by category (Rules tab)
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await query('SELECT * FROM rules ORDER BY category, sort_order ASC');
    const grouped = {
      golden_rule: [],
      risk_tier: [],
      time_slot: [],
      extra_rule: [],
      checklist_item: []
    };
    for (const row of result.rows) {
      grouped[row.category].push(row);
    }
    res.json({ rules: grouped });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch rules' });
  }
});

// GET /api/rules/risk-suggestion - balance-aware risk suggestion (used in Rules tab tool)
router.get('/risk-suggestion', requireAuth, async (req, res) => {
  try {
    const balanceResult = await query(
      `SELECT
        (SELECT COALESCE(SUM(CASE WHEN type='deposit' THEN amount ELSE -amount END), 0) FROM money_log WHERE user_id = $1) +
        (SELECT COALESCE(SUM(net_profit), 0) FROM trades WHERE user_id = $1) AS balance`,
      [req.user.id]
    );
    const balance = parseFloat(balanceResult.rows[0].balance);

    const tiersResult = await query(
      "SELECT * FROM rules WHERE category = 'risk_tier' ORDER BY sort_order ASC"
    );

    const timeBias = getCurrentTimeBias();
    const suggestion = calculateSuggestedRisk(balance, tiersResult.rows, timeBias.bias);

    res.json({ balance, time_bias: timeBias, suggestion });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to calculate risk suggestion' });
  }
});

// POST /api/rules - admin only, add a new rule item to a category
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  const { category, ...fields } = req.body;
  const validCategories = ['golden_rule', 'risk_tier', 'time_slot', 'extra_rule', 'checklist_item'];
  if (!validCategories.includes(category)) {
    return res.status(400).json({ error: `category must be one of: ${validCategories.join(', ')}` });
  }

  try {
    const sortResult = await query(
      'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM rules WHERE category = $1',
      [category]
    );
    const nextOrder = sortResult.rows[0].next_order;

    const result = await query(
      `INSERT INTO rules (category, sort_order, text_content, range_min, range_max, risk_min_pct, risk_max_pct, time_start, time_end, bias, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [
        category, nextOrder,
        fields.text_content || null,
        fields.range_min || null, fields.range_max || null,
        fields.risk_min_pct || null, fields.risk_max_pct || null,
        fields.time_start || null, fields.time_end || null,
        fields.bias || null,
        req.user.id
      ]
    );
    res.status(201).json({ rule: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add rule' });
  }
});

// PATCH /api/rules/:id - admin only, edit any rule item
router.patch('/:id', requireAuth, requireAdmin, async (req, res) => {
  const allowedFields = ['text_content', 'range_min', 'range_max', 'risk_min_pct', 'risk_max_pct', 'time_start', 'time_end', 'bias', 'sort_order'];
  const updates = [];
  const values = [];
  let paramIndex = 1;

  for (const field of allowedFields) {
    if (req.body[field] !== undefined) {
      updates.push(`${field} = $${paramIndex}`);
      values.push(req.body[field]);
      paramIndex++;
    }
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  updates.push(`updated_by = $${paramIndex}`);
  values.push(req.user.id);
  paramIndex++;
  updates.push(`updated_at = NOW()`);

  values.push(req.params.id);

  try {
    const result = await query(
      `UPDATE rules SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );
    res.json({ rule: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update rule' });
  }
});

// DELETE /api/rules/:id - admin only
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await query('DELETE FROM rules WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete rule' });
  }
});

export default router;
