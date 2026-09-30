const lastSyncTime = new Map();

function getKvConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return {
    url: url.replace(/\/$/, ''),
    token
  };
}

function hasRemoteStorage() {
  return !!getKvConfig();
}

async function syncToRemote(db, batchId) {
  const config = getKvConfig();
  if (!config || !batchId) return;

  try {
    const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(batchId);
    if (!batch) return;

    const payments = db.prepare('SELECT * FROM payments WHERE batch_id = ?').all(batchId);
    const statusEvents = db.prepare('SELECT * FROM status_events WHERE batch_id = ?').all(batchId);
    const idempotencyKeys = db.prepare('SELECT * FROM idempotency_keys WHERE batch_id = ?').all(batchId);
    let batchTransactions = [];
    try {
      batchTransactions = db.prepare('SELECT * FROM batch_transactions WHERE batch_id = ?').all(batchId);
    } catch (_) {}

    const payload = {
      batch,
      payments,
      statusEvents,
      idempotencyKeys,
      batchTransactions,
      syncedAt: Date.now()
    };

    const res = await fetch(`${config.url}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(['SET', `batches:${batchId}`, JSON.stringify(payload)])
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      console.error(`[RemoteKV] Failed to sync batch ${batchId}: HTTP ${res.status} ${err}`);
    } else {
      lastSyncTime.set(batchId, Date.now());
    }
  } catch (error) {
    console.error(`[RemoteKV] Failed to syncToRemote for batch ${batchId}:`, error.message);
  }
}

async function syncFromRemote(db, batchId) {
  const config = getKvConfig();
  if (!config || !batchId) return false;

  try {
    const res = await fetch(`${config.url}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(['GET', `batches:${batchId}`])
    });

    if (!res.ok) {
      console.error(`[RemoteKV] Failed to fetch batch ${batchId}: HTTP ${res.status}`);
      return false;
    }

    const json = await res.json();
    if (!json || !json.result) return false;

    const data = typeof json.result === 'string' ? JSON.parse(json.result) : json.result;
    if (!data || !data.batch) return false;

    db.exec('BEGIN IMMEDIATE');
    try {
      // Upsert batch
      const b = data.batch;
      const bCols = Object.keys(b);
      const bPlaceholders = bCols.map(() => '?').join(', ');
      const bStmt = db.prepare(`
        INSERT OR REPLACE INTO batches (${bCols.join(', ')})
        VALUES (${bPlaceholders})
      `);
      bStmt.run(...bCols.map(c => b[c]));

      // Upsert payments
      if (Array.isArray(data.payments) && data.payments.length > 0) {
        for (const p of data.payments) {
          const pCols = Object.keys(p);
          const pPlaceholders = pCols.map(() => '?').join(', ');
          const pStmt = db.prepare(`
            INSERT OR REPLACE INTO payments (${pCols.join(', ')})
            VALUES (${pPlaceholders})
          `);
          pStmt.run(...pCols.map(c => p[c]));
        }
      }

      // Upsert statusEvents
      if (Array.isArray(data.statusEvents) && data.statusEvents.length > 0) {
        for (const ev of data.statusEvents) {
          const evCols = Object.keys(ev);
          const evPlaceholders = evCols.map(() => '?').join(', ');
          const evStmt = db.prepare(`
            INSERT OR REPLACE INTO status_events (${evCols.join(', ')})
            VALUES (${evPlaceholders})
          `);
          evStmt.run(...evCols.map(c => ev[c]));
        }
      }

      // Upsert idempotencyKeys
      if (Array.isArray(data.idempotencyKeys) && data.idempotencyKeys.length > 0) {
        for (const ik of data.idempotencyKeys) {
          const ikCols = Object.keys(ik);
          const ikPlaceholders = ikCols.map(() => '?').join(', ');
          const ikStmt = db.prepare(`
            INSERT OR REPLACE INTO idempotency_keys (${ikCols.join(', ')})
            VALUES (${ikPlaceholders})
          `);
          ikStmt.run(...ikCols.map(c => ik[c]));
        }
      }

      // Upsert batchTransactions
      if (Array.isArray(data.batchTransactions) && data.batchTransactions.length > 0) {
        for (const bt of data.batchTransactions) {
          db.prepare(`
            INSERT OR IGNORE INTO batch_transactions (batch_id, tx_id, kind)
            VALUES (?, ?, ?)
          `).run(bt.batch_id, bt.tx_id, bt.kind);
        }
      }

      db.exec('COMMIT');
      lastSyncTime.set(batchId, Date.now());
      return true;
    } catch (upsertError) {
      db.exec('ROLLBACK');
      console.error(`[RemoteKV] Upsert failed for batch ${batchId}:`, upsertError.message);
      return false;
    }
  } catch (error) {
    console.error(`[RemoteKV] Failed to syncFromRemote for batch ${batchId}:`, error.message);
    return false;
  }
}

async function ensureBatchSynced(db, batchId, force = false) {
  if (!hasRemoteStorage() || !batchId) return;
  const localBatch = db.prepare('SELECT id, status, updated_at FROM batches WHERE id = ?').get(batchId);
  const now = Date.now();
  const lastSync = lastSyncTime.get(batchId) || 0;

  // Not in local DB -> pull from remote KV!
  if (!localBatch) {
    await syncFromRemote(db, batchId);
    return;
  }

  // In local DB: if forced or still active and older than 1.5s -> refresh
  const isTerminal = ['SUCCESS', 'CONFIRMED', 'FAILED', 'REFUNDED'].includes(localBatch.status);
  if ((force || !isTerminal) && (now - lastSync > 1500)) {
    await syncFromRemote(db, batchId);
  }
}

module.exports = {
  hasRemoteStorage,
  syncToRemote,
  syncFromRemote,
  ensureBatchSynced
};
