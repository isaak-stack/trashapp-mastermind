/**
 * core/stripe.js — Stripe payment link service
 * Gracefully degrades to a mock when credentials are missing.
 * Every link created is logged to system_logs.
 */

const logger = require('./logger');

let stripe = null;
let isConfigured = false;

function initStripe() {
  const secretKey = process.env.STRIPE_SECRET_KEY;

  if (!secretKey) {
    console.log('SERVICE NOT CONFIGURED: Stripe');
    return;
  }

  try {
    stripe = require('stripe')(secretKey);
    isConfigured = true;
    console.log('✓ Stripe connected');
  } catch (err) {
    console.error('Stripe initialization failed:', err.message);
    console.log('SERVICE NOT CONFIGURED: Stripe (init error)');
  }
}

/**
 * Create a Stripe Payment Link for a job.
 * If Stripe is not configured, returns a placeholder URL.
 *
 * @param {number} amount        — Amount in dollars
 * @param {string} jobId         — Firestore job document ID
 * @param {string} customerEmail — Customer email (optional)
 * @returns {string}             — Payment link URL
 */
async function createPaymentLink(amount, jobId, customerEmail) {
  await logger.log('stripe', 'SUCCESS', `Payment link requested — Job: ${jobId}, Amount: $${amount}`, {
    type: 'payment_link_request',
    jobId,
    amount,
  });

  if (!isConfigured) {
    const placeholder = `https://pay.trashappjunkremoval.com/mock/${jobId}`;
    console.log(`[MOCK STRIPE] Payment link for $${amount}: ${placeholder}`);
    return placeholder;
  }

  try {
    // Create a Stripe Checkout Session as a payment link
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `TrashApp Junk Removal — Job ${jobId}`,
              description: 'Junk removal service',
            },
            unit_amount: Math.round(amount * 100), // cents
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      metadata: { jobId, customerEmail: customerEmail || '' },
      success_url: 'https://trashappjunkremoval.com/payment-success?job=' + jobId,
      cancel_url: 'https://trashappjunkremoval.com/payment-cancel?job=' + jobId,
      ...(customerEmail ? { customer_email: customerEmail } : {}),
    });

    await logger.success('stripe', `Payment link created — Job: ${jobId}, URL: ${session.url}`, {
      type: 'payment_link_created',
      jobId,
      amount,
      sessionId: session.id,
    });

    return session.url;
  } catch (err) {
    await logger.error('stripe', `Payment link failed — Job: ${jobId}: ${err.message}`, {
      type: 'payment_link_error',
      jobId,
      error: err.message,
    });
    throw err;
  }
}

/**
 * Validate Stripe credentials by retrieving account info.
 * Used during nightly health checks.
 */
async function validateCredentials() {
  if (!isConfigured) return { valid: false, reason: 'not_configured' };
  try {
    const account = await stripe.accounts.retrieve();
    return { valid: true, id: account.id };
  } catch (err) {
    return { valid: false, reason: err.message };
  }
}

async function createDepositSession({ amount, customerName, customerEmail, metadata }) {
  if (!stripe) throw new Error('Stripe not initialized');
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: {
          name: 'TrashApp Booking Deposit',
          description: '$25 deposit applied to your junk removal total'
        },
        unit_amount: amount || 2500
      },
      quantity: 1
    }],
    mode: 'payment',
    success_url: 'https://quote.trashappjunkremoval.com?deposit=success',
    cancel_url: 'https://quote.trashappjunkremoval.com?deposit=cancelled',
    customer_email: customerEmail || undefined,
    metadata: { ...metadata, customerName }
  });
  return session;
}

initStripe();

module.exports = { createPaymentLink, isConfigured: () => isConfigured, validateCredentials, createDepositSession };
