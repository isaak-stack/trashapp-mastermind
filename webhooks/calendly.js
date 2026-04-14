/**
 * webhooks/calendly.js — DEPRECATED
 * Calendly integration has been replaced with native Firestore-based slot booking.
 * This file is kept as a placeholder for backwards compatibility.
 */

/**
 * Register Calendly webhook route on Express app.
 * This is a no-op — Calendly webhooks are no longer processed.
 */
function registerCalendlyWebhook(app) {
  // Calendly removed — booking handled natively via Firestore job_slots
  // This file kept as placeholder for backwards compatibility
}

module.exports = { registerCalendlyWebhook };
