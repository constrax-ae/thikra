import type { Db } from '../db.ts';

/**
 * 0019: real payments through Stripe (test mode first).
 *  - subscriptions.stripe_customer / stripe_subscription   which Stripe objects a family's plan belongs to
 *  - payments        the ledger: one row per invoice paid, failed or refunded (amounts in cents), never card data
 *  - payment_events  every Stripe event id already handled, so a delivery repeated by Stripe changes nothing twice
 */
export function payments(db: Db) {
  for (const sql of ['ALTER TABLE subscriptions ADD COLUMN stripe_customer TEXT', 'ALTER TABLE subscriptions ADD COLUMN stripe_subscription TEXT']) {
    try { db.exec(sql); } catch { /* already there */ }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      circle_id INTEGER REFERENCES circles(id) ON DELETE SET NULL,
      status TEXT NOT NULL CHECK (status IN ('paid','failed','refunded')),
      amount_cents INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'usd',
      plan TEXT,
      stripe_invoice TEXT UNIQUE,
      stripe_payment_intent TEXT,
      period_end TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS payments_circle ON payments(circle_id, id);
    CREATE INDEX IF NOT EXISTS payments_intent ON payments(stripe_payment_intent);
    CREATE TABLE IF NOT EXISTS payment_events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}
