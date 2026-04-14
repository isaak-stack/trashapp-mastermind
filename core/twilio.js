/**
 * core/twilio.js — Twilio SMS service
 * Gracefully degrades to a mock when credentials are missing.
 * Every send is logged to system_logs before transmission.
 */

const logger = require('./logger');

let client = null;
let fromNumber = null;
let isConfigured = false;

function initTwilio() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const phone = process.env.TWILIO_PHONE_NUMBER;

  if (!sid || !token || !phone) {
    console.log('SERVICE NOT CONFIGURED: Twilio');
    return;
  }

  try {
    const twilio = require('twilio');
    client = twilio(sid, token);
    fromNumber = phone;
    isConfigured = true;
    console.log(`✓ Twilio connected — from: ${phone}`);
  } catch (err) {
    console.error('Twilio initialization failed:', err.message);
    console.log('SERVICE NOT CONFIGURED: Twilio (init error)');
  }
}

/**
 * Send an SMS message. If Twilio is not configured, logs the
 * would-be message to console instead.
 *
 * @param {string} to      — Recipient phone number (E.164 format)
 * @param {string} message — SMS body text
 * @returns {object}       — Twilio message SID or mock response
 */
async function sendSMS(to, message) {
  // Log intent before sending
  await logger.log('twilio', 'SUCCESS', `SMS queued → ${to}`, {
    type: 'sms_outbound',
    to,
    body_preview: message.substring(0, 80),
  });

  if (!isConfigured) {
    console.log(`[MOCK SMS] To: ${to}`);
    console.log(`[MOCK SMS] Body: ${message}`);
    return { sid: 'MOCK-' + Date.now(), status: 'mock_sent' };
  }

  try {
    const result = await client.messages.create({
      body: message,
      from: fromNumber,
      to,
    });

    await logger.success('twilio', `SMS sent → ${to} (SID: ${result.sid})`, {
      type: 'sms_sent',
      sid: result.sid,
      to,
    });

    return result;
  } catch (err) {
    await logger.error('twilio', `SMS failed → ${to}: ${err.message}`, {
      type: 'sms_error',
      to,
      error: err.message,
    });
    throw err;
  }
}

/**
 * Validate Twilio credentials by calling the account lookup API.
 * Used during nightly health checks.
 */
async function validateCredentials() {
  if (!isConfigured) return { valid: false, reason: 'not_configured' };
  try {
    const account = await client.api.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();
    return { valid: true, friendlyName: account.friendlyName };
  } catch (err) {
    return { valid: false, reason: err.message };
  }
}

initTwilio();

module.exports = { sendSMS, isConfigured: () => isConfigured, validateCredentials };
