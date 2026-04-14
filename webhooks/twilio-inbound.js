/**
 * webhooks/twilio-inbound.js — Inbound customer SMS handler
 * Handles customer replies, logs conversations, and alerts admin.
 */

const { db } = require('../core/firestore');
const logger = require('../core/logger');
const { sendSMS } = require('../core/twilio');

const ADMIN_PHONE = process.env.ADMIN_PHONE || '+15597744249';

/**
 * Register twilio inbound webhook route on Express app.
 */
function registerTwilioInboundWebhook(app) {
  app.post('/webhooks/twilio-inbound', async (req, res) => {
    try {
      const from = req.body.From || '';
      const body = req.body.Body || '';
      const messageSid = req.body.MessageSid || '';

      await logger.log('twilio-inbound', 'SUCCESS', `Customer SMS: ${from} → "${body.substring(0, 40)}"`, {
        type: 'customer_sms_inbound',
        from,
        messageSid,
        icon: '💬',
      });

      // Route to handler (non-blocking)
      handleInboundCustomerSMS(from, body).catch((err) => {
        logger.error('twilio-inbound', `Handler error: ${err.message}`, {
          from,
          error: err.message,
        });
      });

      // Return empty TwiML response immediately
      res.set('Content-Type', 'text/xml');
      res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    } catch (err) {
      await logger.error('twilio-inbound', `Webhook error: ${err.message}`, { error: err.message });
      res.set('Content-Type', 'text/xml');
      res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    }
  });
}

/**
 * Handle inbound customer SMS.
 * 1. Find job by phone (most recent active job)
 * 2. Write to jobs/{jobId}/messages subcollection
 * 3. Alert admin
 * 4. Auto-reply to customer
 */
async function handleInboundCustomerSMS(from, body) {
  if (db._isMock) {
    console.log(`[Customer SMS] From: ${from}, Body: ${body}`);
    return;
  }

  try {
    // Find most recent job for this phone in active statuses
    const jobsSnap = await db.collection('jobs')
      .where('phone', '==', from)
      .where('status', 'in', ['QUOTE_SENT', 'CONFIRMED', 'AWAITING_PAYMENT', 'SCHEDULED', 'EN_ROUTE', 'ON_SITE'])
      .orderBy('created_at', 'desc')
      .limit(1)
      .get();

    if (jobsSnap.empty) {
      await logger.partial('twilio-inbound', `Inbound SMS from unknown number: ${from}`, {
        type: 'sms_unknown_number',
        from,
        icon: '❓',
      });

      // Send auto-reply
      await sendSMS(from, `Hi! We didn't find an active TrashApp job for this number. If you need help, call us at (559) 774-4249.`);
      return;
    }

    const jobDoc = jobsSnap.docs[0];
    const job = { id: jobDoc.id, ...jobDoc.data() };

    // Write message to subcollection
    await db.collection('jobs').doc(job.id).collection('messages').add({
      from: 'customer',
      body,
      phone: from,
      receivedAt: new Date().toISOString(),
      messageStatus: 'received',
    });

    await logger.success('twilio-inbound', `Message logged for Job ${job.id}: ${job.customer_name}`, {
      jobId: job.id,
      customerName: job.customer_name,
      icon: '📝',
    });

    // Alert admin
    const snippet = body.length > 40 ? body.substring(0, 37) + '...' : body;
    await sendSMS(ADMIN_PHONE, `Reply from ${job.customer_name} on ${job.address}: "${snippet}" Status: ${job.status}`);

    // Auto-reply to customer
    const name = (job.customer_name || '').split(' ')[0] || '';
    await sendSMS(from, `Got your message${name ? ' ' + name : ''}! A TrashApp team member will respond shortly. Thanks!`);

    await logger.success('twilio-inbound', `Auto-replies sent for Job ${job.id}`, {
      jobId: job.id,
      icon: '🤖',
    });
  } catch (err) {
    await logger.error('twilio-inbound', `Handler error: ${err.message}`, {
      from,
      error: err.message,
    });
  }
}

module.exports = { registerTwilioInboundWebhook };
