/**
 * core/logger.js — Centralized event logging
 * Every event is written to `system_logs` Firestore collection and
 * emitted via Socket.io in real time. Never crashes.
 */

const { db } = require('./firestore');

let io = null;

/**
 * Attach a Socket.io server instance so events stream to the dashboard.
 */
function attachSocketIO(socketIO) {
  io = socketIO;
}

/**
 * Log an event to Firestore and emit via Socket.io.
 *
 * @param {string} workflowName  — e.g. 'pipeline', 'sms', 'scheduler'
 * @param {string} status        — SUCCESS | ERROR | PARTIAL
 * @param {string} message       — Human-readable description
 * @param {object} [meta]        — Optional extra data
 */
async function log(workflowName, status, message, meta = {}) {
  const entry = {
    workflow_name: workflowName,
    status,
    message,
    timestamp: new Date().toISOString(),
    ...meta,
  };

  if (meta.error) {
    entry.error = typeof meta.error === 'string' ? meta.error : meta.error.message || String(meta.error);
  }

  // Console output
  const icon = status === 'ERROR' ? '✗' : status === 'PARTIAL' ? '⚠' : '✓';
  console.log(`[${icon}] [${workflowName}] ${message}`);

  // Emit to dashboard
  try {
    if (io) {
      io.emit('system_event', entry);
    }
  } catch (_) {
    // Never crash on Socket.io errors
  }

  // Write to Firestore
  try {
    if (!db._isMock) {
      await db.collection('system_logs').add(entry);
    }
  } catch (err) {
    console.error('Logger Firestore write failed:', err.message);
  }
}

/**
 * Shorthand helpers
 */
const success = (workflow, message, meta) => log(workflow, 'SUCCESS', message, meta);
const error = (workflow, message, meta) => log(workflow, 'ERROR', message, meta);
const partial = (workflow, message, meta) => log(workflow, 'PARTIAL', message, meta);

module.exports = { log, success, error, partial, attachSocketIO };
