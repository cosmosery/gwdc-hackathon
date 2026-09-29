const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function initDb(dbPath = process.env.SQLITE_DB_PATH || path.join(__dirname, '../data/payout.db')) {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(dbPath);

  // WAL mode for concurrency
  if (dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS batches (
      id TEXT PRIMARY KEY,
      sender TEXT NOT NULL,
      token TEXT NOT NULL,
      batch_hash TEXT NOT NULL,
      merkle_root TEXT NOT NULL,
      total_amount TEXT NOT NULL,
      recipient_count INTEGER NOT NULL,
      executor_address TEXT,
      factory_address TEXT,
      expiry INTEGER NOT NULL,
      salt TEXT NOT NULL,
      status TEXT NOT NULL,
      trace_id TEXT,
      deposit_tx_id TEXT,
      provider_state TEXT,
      provider_raw_response TEXT,
      error_message TEXT,
      request_id TEXT,
      refund_tx_id TEXT,
      refund_amount TEXT,
      refund_state TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      recipient TEXT NOT NULL,
      amount TEXT NOT NULL,
      proof TEXT NOT NULL,
      status TEXT NOT NULL,
      tx_id TEXT,
      error_code TEXT,
      error_message TEXT,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (batch_id) REFERENCES batches(id)
    );

    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      response_json TEXT NOT NULL,
      request_hash TEXT,
      request_id TEXT,
      state TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_payments_batch ON payments(batch_id);
    CREATE INDEX IF NOT EXISTS idx_batches_status ON batches(status);
  `);

  // Existing SQLite files predate these columns. Keep their batches and permits.
  function ensureColumn(table, column, type) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
    if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  for (const [column, type] of [
    ['request_id', 'TEXT'], ['refund_tx_id', 'TEXT'],
    ['refund_amount', 'TEXT'], ['refund_state', 'TEXT']
  ]) ensureColumn('batches', column, type);
  for (const [column, type] of [
    ['request_hash', 'TEXT'], ['request_id', 'TEXT'], ['state', 'TEXT']
  ]) ensureColumn('idempotency_keys', column, type);

  return {
    db,
    saveBatch(batch) {
      const stmt = db.prepare(`
        INSERT INTO batches (
          id, sender, token, batch_hash, merkle_root, total_amount, recipient_count,
          executor_address, factory_address, expiry, salt, status,
          trace_id, deposit_tx_id, provider_state, provider_raw_response, error_message,
          created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `);
      stmt.run(
        batch.id, batch.sender, batch.token, batch.batchHash, batch.merkleRoot,
        batch.totalAmount, batch.recipientCount, batch.executorAddress || null,
        batch.factoryAddress || null, batch.expiry, batch.salt, batch.status,
        batch.traceId || null, batch.depositTxId || null, batch.providerState || null,
        batch.providerRawResponse || null, batch.errorMessage || null,
        batch.createdAt, batch.updatedAt
      );
    },

    updateBatchStatus(batchId, status, fields = {}) {
      const now = Date.now();
      const updates = ['status = ?', 'updated_at = ?'];
      const params = [status, now];

      if ('traceId' in fields) { updates.push('trace_id = ?'); params.push(fields.traceId); }
      if ('depositTxId' in fields) { updates.push('deposit_tx_id = ?'); params.push(fields.depositTxId); }
      if ('providerState' in fields) { updates.push('provider_state = ?'); params.push(fields.providerState); }
      if ('providerRawResponse' in fields) { updates.push('provider_raw_response = ?'); params.push(fields.providerRawResponse); }
      if ('errorMessage' in fields) { updates.push('error_message = ?'); params.push(fields.errorMessage); }
      if ('executorAddress' in fields) { updates.push('executor_address = ?'); params.push(fields.executorAddress); }
      if ('requestId' in fields) { updates.push('request_id = ?'); params.push(fields.requestId); }
      if ('refundTxId' in fields) { updates.push('refund_tx_id = ?'); params.push(fields.refundTxId); }
      if ('refundAmount' in fields) { updates.push('refund_amount = ?'); params.push(fields.refundAmount); }
      if ('refundState' in fields) { updates.push('refund_state = ?'); params.push(fields.refundState); }

      params.push(batchId);
      const stmt = db.prepare(`UPDATE batches SET ${updates.join(', ')} WHERE id = ?`);
      stmt.run(...params);
    },

    getBatch(batchId) {
      const stmt = db.prepare('SELECT * FROM batches WHERE id = ?');
      return stmt.get(batchId);
    },

    listBatchesByStatus(statuses) {
      if (!statuses.length) return [];
      const placeholders = statuses.map(() => '?').join(', ');
      return db.prepare(`SELECT * FROM batches WHERE status IN (${placeholders}) ORDER BY created_at ASC`).all(...statuses);
    },

    reserveExecution(key, batchId, requestHash, requestId) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = db.prepare('SELECT * FROM idempotency_keys WHERE key = ?').get(key);
        if (existing) {
          db.exec('COMMIT');
          if (existing.batch_id !== batchId || (existing.request_hash && existing.request_hash !== requestHash)) {
            return { conflict: true };
          }
          return { response: JSON.parse(existing.response_json) };
        }
        const batch = db.prepare('SELECT status FROM batches WHERE id = ?').get(batchId);
        if (!batch || batch.status !== 'READY') {
          db.exec('COMMIT');
          return { unavailable: batch?.status || 'NOT_FOUND' };
        }
        const response = { batchId, requestId, transactionIds: [], status: 'SUBMITTING' };
        db.prepare(`INSERT INTO idempotency_keys
          (key, batch_id, response_json, request_hash, request_id, state, created_at)
          VALUES (?, ?, ?, ?, ?, 'SUBMITTING', ?)`)
          .run(key, batchId, JSON.stringify(response), requestHash, requestId, Date.now());
        db.prepare(`UPDATE batches SET status = 'SUBMITTING', request_id = ?, updated_at = ? WHERE id = ?`)
          .run(requestId, Date.now(), batchId);
        db.exec('COMMIT');
        return { claimed: true, response };
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    finishExecutionClaim(key, response, state) {
      db.prepare(`UPDATE idempotency_keys SET response_json = ?, state = ? WHERE key = ?`)
        .run(JSON.stringify(response), state, key);
    },

    reconcileExecutionClaims(batch) {
      if (!batch.trace_id && batch.status !== 'SUBMISSION_UNKNOWN') return;
      const response = batch.trace_id
        ? { batchId: batch.id, requestId: batch.request_id, traceId: batch.trace_id,
            transactionIds: [], status: 'PROCESSING' }
        : { batchId: batch.id, requestId: batch.request_id, status: 'SUBMISSION_UNKNOWN' };
      db.prepare(`UPDATE idempotency_keys SET response_json = ?, state = ?
        WHERE batch_id = ? AND state = 'SUBMITTING'`)
        .run(JSON.stringify(response), response.status, batch.id);
    },

    completeSubmission(batchId, key, response, status, fields) {
      db.exec('BEGIN IMMEDIATE');
      try {
        this.updateBatchStatus(batchId, status, fields);
        this.finishExecutionClaim(key, response, status);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    reserveRefund(batchId) {
      const result = db.prepare(`UPDATE batches SET refund_state = 'SUBMITTING', updated_at = ?
        WHERE id = ? AND (refund_state IS NULL OR refund_state = 'FAILED')`)
        .run(Date.now(), batchId);
      return result.changes === 1;
    },

    savePayments(batchId, paymentsList) {
      const stmt = db.prepare(`
        INSERT INTO payments (id, batch_id, idx, recipient, amount, proof, status, tx_id, error_code, error_message, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const now = Date.now();
      for (const p of paymentsList) {
        stmt.run(
          p.id, batchId, p.idx, p.recipient, p.amount,
          JSON.stringify(p.proof), p.status, p.txId || null,
          p.errorCode || null, p.errorMessage || null, now
        );
      }
    },

    saveBatchWithPayments(batch, paymentsList) {
      db.exec('BEGIN IMMEDIATE');
      try {
        this.saveBatch(batch);
        this.savePayments(batch.id, paymentsList);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    getPayments(batchId) {
      const stmt = db.prepare('SELECT * FROM payments WHERE batch_id = ? ORDER BY idx ASC');
      return stmt.all(batchId).map(p => ({
        ...p,
        proof: JSON.parse(p.proof)
      }));
    },

    updatePaymentStatus(paymentId, status, fields = {}) {
      const now = Date.now();
      const updates = ['status = ?', 'updated_at = ?'];
      const params = [status, now];
      if ('txId' in fields) { updates.push('tx_id = ?'); params.push(fields.txId); }
      if ('errorCode' in fields) { updates.push('error_code = ?'); params.push(fields.errorCode); }
      if ('errorMessage' in fields) { updates.push('error_message = ?'); params.push(fields.errorMessage); }
      params.push(paymentId);
      const stmt = db.prepare(`UPDATE payments SET ${updates.join(', ')} WHERE id = ?`);
      stmt.run(...params);
    },

    getPaymentCounts(batchId) {
      const stmt = db.prepare(`
        SELECT status, COUNT(*) as count FROM payments WHERE batch_id = ? GROUP BY status
      `);
      const rows = stmt.all(batchId);
      const counts = { total: 0, pending: 0, submitting: 0, submitted: 0, confirmed: 0, failed: 0 };
      for (const r of rows) {
        const s = (r.status || '').toLowerCase();
        if (s in counts) counts[s] = r.count;
        counts.total += r.count;
      }
      return {
        total: counts.total,
        pending: counts.pending,
        submitted: counts.submitting + counts.submitted,
        success: counts.confirmed,
        failed: counts.failed
      };
    },

    getIdempotency(key) {
      const stmt = db.prepare('SELECT * FROM idempotency_keys WHERE key = ?');
      const row = stmt.get(key);
      return row ? JSON.parse(row.response_json) : null;
    },

    getIdempotencyClaim(key) {
      const row = db.prepare('SELECT * FROM idempotency_keys WHERE key = ?').get(key);
      return row ? { batchId: row.batch_id, requestHash: row.request_hash,
        response: JSON.parse(row.response_json) } : null;
    },

    saveIdempotency(key, batchId, responseObj) {
      const stmt = db.prepare(`
        INSERT INTO idempotency_keys (key, batch_id, response_json, created_at)
        VALUES (?, ?, ?, ?)
      `);
      stmt.run(key, batchId, JSON.stringify(responseObj), Date.now());
    }
  };
}

module.exports = { initDb };
