/**
 * webhooks/stripe.js — Stripe payment webhook receiver
 * POST /webhooks/stripe
 * Handles payment_intent.succeeded events.
 */

const { db } = require('../core/firestore');
const logger = require('../core/logger');
const { sendSMS } = require('../core/twilio');

const ADMIN_PHONE = process.env.ADMIN_PHONE || '+15597744249';

/**
 * Register Stripe webhook route on Express app.
 * Note: Stripe signature verification requires the raw body.
 */
function registerStripeWebhook(app) {
  app.post('/webhooks/stripe', async (req, res) => {
    try {
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

      let event;

      // Verify Stripe signature if secret is configured
      if (webhookSecret && process.env.STRIPE_SECRET_KEY) {
        try {
          const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
          const sig = req.headers['stripe-signature'];
          event = stripe.webhooks.constructEvent(req.rawBody || req.body, sig, webhookSecret);
        } catch (err) {
          await logger.error('stripe-webhook', `Signature verification failed: ${err.message}`);
          return res.status(400).json({ error: 'Invalid signature' });
        }
      } else {
        // No secret configured — accept raw payload
        event = req.body;
      }

      // Only process payment_intent.succeeded
      if (event.type !== 'payment_intent.succeeded' && event.type !== 'checkout.session.completed') {
        return res.status(200).json({ received: true, skipped: true });
      }

      const paymentData = event.data?.object || {};
      const jobId = paymentData.metadata?.jobId || '';
      const amountPaid = (paymentData.amount_total || paymentData.amount || 0) / 100;
      const customerEmail = paymentData.customer_email || paymentData.metadata?.customerEmail || '';

      if (!jobId) {
        await logger.partial('stripe-webhook', 'Payment received but no jobId in metadata', {
          type: 'payment_no_job',
          icon: '💰',
        });
        return res.status(200).json({ received: true, warning: 'no_job_id' });
      }

      if (!db._isMock) {
        // Update job to SCHEDULED
        const jobRef = db.collection('jobs').doc(jobId);
        const jobDoc = await jobRef.get();

        if (!jobDoc.exists) {
          await logger.error('stripe-webhook', `Payment for non-existent job: ${jobId}`);
          return res.status(200).json({ received: true, warning: 'job_not_found' });
        }

        const job = { id: jobId, ...jobDoc.data() };

        await jobRef.update({
          status: 'SCHEDULED',
          payment_status: 'paid',
          payment_amount: amountPaid,
          payment_method: 'card',
          stripe_payment_id: paymentData.id || paymentData.payment_intent,
          paid_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });

        // Write commission log
        if (job.assigned_rep_id) {
          const repDoc = await db.collection('reps').doc(job.assigned_rep_id).get();
          if (repDoc.exists) {
            const rep = repDoc.data();
            const commPct = rep.commission || 15;
            const commAmount = Math.round(amountPaid * (commPct / 100) * 100) / 100;

            await db.collection('commission_log').add({
              rep_id: job.assigned_rep_id,
              rep_name: rep.name || 'Unknown',
              job_id: jobId,
              deal_value: amountPaid,
              commission_percent: commPct,
              commission_amount: commAmount,
              status: 'PENDING',
              created_at: new Date().toISOString(),
            });

            // Notify rep
            if (rep.phone) {
              await sendSMS(rep.phone, `💰 Payment received for ${job.address}: $${amountPaid}. Commission: $${commAmount.toFixed(2)}. TrashApp`);
            }
          }
        }

        // Send receipt SMS
        if (job.phone) {
          await sendSMS(job.phone, `Payment received ✓ Thank you ${job.customer_name || ''}! Amount: $${amountPaid}. See you ${job.scheduled_date || 'soon'}. TrashApp Junk Removal (559) 774-4249`);
        }

        await logger.success('stripe-webhook', `Payment confirmed — Job ${jobId}: $${amountPaid}`, {
          type: 'payment_confirmed',
          jobId,
          amount: amountPaid,
          icon: '💰',
        });
      }

      res.status(200).json({ received: true });
    } catch (err) {
      await logger.error('stripe-webhook', `Webhook error: ${err.message}`, { error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}

module.exports = { registerStripeWebhook };
