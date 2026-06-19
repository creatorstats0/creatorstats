// Run with: npm run seed
// Creates the first admin account so you can log in and start adding users.
// Edit the values below before running, or set them as environment variables.

import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { query, pool } from './pool.js';

dotenv.config();

const ADMIN_NAME = process.env.SEED_ADMIN_NAME || 'Admin';
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || 'admin@creatorstats.local';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'changeme123';

async function seed() {
  try {
    const existing = await query('SELECT id FROM users WHERE email = $1', [ADMIN_EMAIL]);
    if (existing.rows.length > 0) {
      console.log(`Admin account already exists for ${ADMIN_EMAIL}`);
      return;
    }

    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    await query(
      `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, 'admin')`,
      [ADMIN_NAME, ADMIN_EMAIL, passwordHash]
    );

    console.log('✅ Admin account created!');
    console.log(`   Email: ${ADMIN_EMAIL}`);
    console.log(`   Password: ${ADMIN_PASSWORD}`);
    console.log('   ⚠️  Log in and consider this your first account.');
  } catch (err) {
    console.error('Failed to seed admin account:', err);
  } finally {
    await pool.end();
  }
}

seed();
