/**
 * webhooks/twilio.js — Twilio inbound SMS webhook receiver
 * POST /webhooks/twilio
 * Receives inbound SMS and routes to sms-conversation handler.
 */

const logger = require('../core/logger');
const { handleInboundSMS } = require('../dispatch/sms-conversation');

/**
 * Register Twilio webhook route on Express app.
 */
function registerTwilioWebhook(app) {
  app.post('/webhooks/twilio', async (req, res) => {
    try {
      const from = req.body.From || '';
      const body = req.body.Body || '';
      const messageSid = req.body.MessageSid || '';

      await logger.log('twilio-webhook', 'SUCCESS', `Inbound SMS from ${from}: "${body.substring(0, 40)}"`, {
        type: 'sms_inbound_webhook',
        from,
        messageSid,
        icon: '📱',
      });

      // Route to SMS conversation handler (non-blocking)
      handleInboundSMS(from, body).catch((err) => {
        logger.error('twilio-webhook', `SMS handler error: ${err.message}`, {
          from,
          error: err.message,
        });
      });

      // Return empty TwiML response immediately
      res.set('Content-Type', 'text/xml');
      res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    } catch (err) {
      await logger.error('twilio-webhook', `Webhook error: ${err.message}`, { error: err.message });
      res.set('Content-Type', 'text/xml');
      res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    }
  });
}

module.exports = { registerTwilioWebhook };
