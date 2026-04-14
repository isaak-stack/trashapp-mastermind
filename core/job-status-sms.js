/**
 * core/job-status-sms.js — Job status SMS notifications
 * Sends automated SMS to customers based on job status transitions.
 */

const STATUS_SMS = {
  scheduled: (job) => `TrashApp confirmed: your pickup is scheduled for ${job.slotLabel || job.scheduled_date}. We'll text you when we're on the way. Questions? Reply here.`,
  en_route: (job) => `Your TrashApp crew is on the way! Estimated arrival: 20-30 minutes. Address confirmed: ${job.address}. Reply if you need to reach us.`,
  on_site: (job) => `TrashApp crew has arrived at ${job.address}. See you in a sec!`,
  completed: (job) => `Job complete! Your space is cleared 🎉 Total: $${job.finalPrice || job.estimated_revenue}. ${job.paymentLink ? 'Payment link: ' + job.paymentLink : "We'll follow up on payment shortly."}. Mind leaving us a quick Google review? It helps a ton: https://g.page/r/trashapp/review`,
};

/**
 * Send a status transition SMS to a customer.
 *
 * @param {object} job         — Job document from Firestore
 * @param {string} newStatus   — Status key (scheduled, en_route, on_site, completed, etc.)
 * @param {object} twilio      — Twilio service module
 * @param {object} logger      — Logger service module
 */
async function sendStatusSMS(job, newStatus, twilio, logger) {
  const template = STATUS_SMS[newStatus];
  if (!template || !job.phone) return;

  const msg = template(job);
  try {
    await twilio.sendSMS(job.phone, msg);
    await logger.success('job-status-sms', `Sent ${newStatus} SMS to ${job.customer_name}`, {
      jobId: job.id,
      status: newStatus,
      icon: '📱',
    });
  } catch (err) {
    await logger.error('job-status-sms', `Failed ${newStatus} SMS: ${err.message}`, {
      jobId: job.id,
      status: newStatus,
      error: err.message,
    });
  }
}

module.exports = { sendStatusSMS, STATUS_SMS };
