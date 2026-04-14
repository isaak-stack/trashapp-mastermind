/**
 * dispatch/sms-conversation.js — Inbound SMS conversation handler
 * Parses customer intent from SMS replies and routes through job state machine.
 * Conversation state stored in the job document itself.
 */

const { db } = require('../core/firestore');
const logger = require('../core/logger');
const { sendSMS } = require('../core/twilio');
const { createPaymentLink } = require('../core/stripe');

const ADMIN_PHONE = process.env.ADMIN_PHONE || '+15597744249';

// ─── CLAUDE API INTEGRATION ────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_AVAILABLE = !!ANTHROPIC_API_KEY;

if (CLAUDE_AVAILABLE) {
  console.log('✓ Claude API configured — SMS responses will use AI');
} else {
  console.log('ℹ SMS using keyword matching — add ANTHROPIC_API_KEY to enable AI responses');
}

// ─── INTENT PARSING ──────────────────────────────────────────

const INTENTS = {
  confirm: /\b(confirm|yes|ok|confirmed|yep|yeah|sure|book|do\s?it|let'?s?\s?go|sounds?\s?good)\b/i,
  cancel: /\b(cancel|no|stop|nevermind|nope|pass|don'?t|not\s?interested)\b/i,
  cash: /\b(cash)\b/i,
  check: /\b(check|cheque)\b/i,
  card: /\b(card|credit|debit|venmo|zelle|paypal|online|stripe)\b/i,
};

function parseIntent(text) {
  const cleaned = (text || '').trim().toLowerCase();
  if (INTENTS.confirm.test(cleaned)) return 'confirm';
  if (INTENTS.cancel.test(cleaned)) return 'cancel';
  if (INTENTS.cash.test(cleaned)) return 'cash';
  if (INTENTS.check.test(cleaned)) return 'check';
  if (INTENTS.card.test(cleaned)) return 'card';
  return 'unrecognized';
}

// ─── CLAUDE AI RESPONSE GENERATOR ───────────────────────────

/**
 * Generate a human-sounding SMS response using Claude API.
 * Falls back to null if Claude is not configured or API fails.
 */
async function generateHumanResponse(customerMessage, jobContext) {
  if (!CLAUDE_AVAILABLE) return null;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: `You are a friendly dispatcher texting for TrashApp Junk Removal in Fresno CA. Your name is Alex. A customer just texted back about their junk removal job.

Job context:
- Customer name: ${jobContext.customerName || 'there'}
- Address: ${jobContext.address || 'their location'}
- Quote range: ${jobContext.priceRange || 'pending'}
- Current job status: ${jobContext.status || 'quoted'}
- Scheduled time: ${jobContext.scheduledTime || 'TBD'}

Customer just texted: "${customerMessage}"

Determine their intent and write a natural, friendly reply under 160 characters. Never mention you are AI. Stay on topic — junk removal, scheduling, payment only. Respond ONLY with valid JSON: {"intent": "confirm|cancel|cash|check|card|question|unrecognized", "response": "your message here"}`
        }]
      })
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    console.warn('Claude API failed, falling back to keyword matching:', err.message);
    return null;
  }
}

// ─── MAIN HANDLER ────────────────────────────────────────────

/**
 * Handle an inbound SMS from a customer.
 *
 * @param {string} from    — Sender phone number (E.164)
 * @param {string} body    — SMS body text
 */
async function handleInboundSMS(from, body) {
  try {
    if (db._isMock) {
      console.log(`[SMS Mock] From: ${from}, Body: ${body}`);
      return;
    }

    // Find the most recent open job for this phone number
    const jobsSnap = await db.collection('jobs')
      .where('phone', '==', from)
      .where('status', 'in', ['QUOTE_SENT', 'CONFIRMED', 'AWAITING_PAYMENT'])
      .orderBy('created_at', 'desc')
      .limit(1)
      .get();

    if (jobsSnap.empty) {
      await logger.partial('sms', `Inbound SMS from unknown number: ${from}`, {
        type: 'sms_inbound_unknown',
        from,
        body_preview: body.substring(0, 80),
        icon: '📱',
      });
      return;
    }

    const jobDoc = jobsSnap.docs[0];
    const job = { id: jobDoc.id, ...jobDoc.data() };

    // Try Claude API first if available, fall back to keyword matching
    let intent, aiResponseText;
    const aiResult = await generateHumanResponse(body, {
      customerName: job.customer_name,
      address: job.address,
      priceRange: job.ai_priceRange,
      status: job.status,
      scheduledTime: job.scheduled_time,
    });

    if (aiResult) {
      intent = aiResult.intent;
      aiResponseText = aiResult.response;
    } else {
      // Existing keyword matching fallback
      intent = parseIntent(body);
      aiResponseText = null; // use existing template-based responses
    }

    await logger.log('sms', 'SUCCESS', `Inbound SMS from ${from}: "${body.substring(0, 40)}" → intent: ${intent}${aiResult ? ' (Claude)' : ' (keyword)'}`, {
      type: 'sms_inbound',
      from,
      jobId: job.id,
      intent,
      icon: '📱',
    });

    // Log conversation history on the job
    const conversationHistory = job.conversation_history || [];
    conversationHistory.push({
      direction: 'inbound',
      from,
      body,
      intent,
      timestamp: new Date().toISOString(),
    });
    await db.collection('jobs').doc(job.id).update({ conversation_history: conversationHistory });

    // Route by job status + intent
    switch (job.status) {
      case 'QUOTE_SENT':
        return handleQuoteSentReply(job, intent, from, body);
      case 'CONFIRMED':
        return handleConfirmedReply(job, intent, from, body);
      default:
        await logger.partial('sms', `Unhandled SMS for job ${job.id} in status ${job.status}`, {
          jobId: job.id,
          from,
          icon: '📱',
        });
    }
  } catch (err) {
    await logger.error('sms', `Inbound SMS handler error: ${err.message}`, {
      from,
      error: err.message,
    });
  }
}

// ─── STATUS-SPECIFIC HANDLERS ────────────────────────────────

async function handleQuoteSentReply(job, intent, from, body) {
  if (intent === 'confirm') {
    await db.collection('jobs').doc(job.id).update({
      status: 'CONFIRMED',
      confirmed_at: new Date().toISOString(),
    });
    // Pipeline watcher will pick up CONFIRMED and send payment SMS
  } else if (intent === 'cancel') {
    await db.collection('jobs').doc(job.id).update({
      status: 'CANCELLED',
      cancelled_at: new Date().toISOString(),
      cancel_reason: 'customer_sms',
    });
    // Pipeline watcher will handle the cancellation SMS and rep notification
  } else {
    await handleUnrecognized(job, from, body);
  }
}

async function handleConfirmedReply(job, intent, from, body) {
  if (intent === 'cash') {
    const amount = job.ai_midpoint || job.estimated_revenue || 0;
    await db.collection('jobs').doc(job.id).update({
      status: 'SCHEDULED',
      payment_method: 'cash',
      collect_on_site: true,
      payment_confirmed_at: new Date().toISOString(),
    });
    await sendSMS(from, formatCashCheckSMS(job, amount));
  } else if (intent === 'check') {
    const amount = job.ai_midpoint || job.estimated_revenue || 0;
    await db.collection('jobs').doc(job.id).update({
      status: 'SCHEDULED',
      payment_method: 'check',
      collect_on_site: true,
      payment_confirmed_at: new Date().toISOString(),
    });
    await sendSMS(from, formatCashCheckSMS(job, amount));
  } else if (intent === 'card') {
    const amount = job.ai_midpoint || job.estimated_revenue || 0;
    const stripeUrl = await createPaymentLink(amount, job.id, job.email);
    await db.collection('jobs').doc(job.id).update({
      status: 'AWAITING_PAYMENT',
      payment_method: 'card',
      stripePaymentLinkId: stripeUrl,
      payment_link_sent_at: new Date().toISOString(),
    });
    await sendSMS(from, formatCardSMS(stripeUrl));
  } else {
    await handleUnrecognized(job, from, body);
  }
}

/**
 * Handle unrecognized messages. After 2 unrecognized in a row,
 * notify admin.
 */
async function handleUnrecognized(job, from, body) {
  const unrecognizedCount = (job.unrecognized_count || 0) + 1;
  await db.collection('jobs').doc(job.id).update({
    unrecognized_count: unrecognizedCount,
  });

  // Send clarification
  const name = (job.customer_name || '').split(' ')[0] || '';
  let clarification;
  if (job.status === 'QUOTE_SENT') {
    clarification = `Hey${name ? ' ' + name : ''} — just wanted to make sure you saw the quote. Want us to get you on the schedule? Just say yes and we'll take care of it. Or if you're passing, no hard feelings. (559) 774-4249`;
  } else if (job.status === 'CONFIRMED') {
    clarification = `Hey${name ? ' ' + name : ''} — just need to know how you'd like to pay: cash, check, or card? Whichever is easiest for you. (559) 774-4249`;
  } else {
    clarification = `Hey${name ? ' ' + name : ''}, if you have any questions just give us a call — (559) 774-4249. Happy to help!`;
  }

  await sendSMS(from, clarification);

  if (unrecognizedCount >= 2) {
    await sendSMS(ADMIN_PHONE, `Customer ${from} sent a message we couldn't parse: '${body.substring(0, 60)}' — they're on the ${job.address || 'unknown'} job. Might want to jump in manually.`);
    await logger.partial('sms', `Admin notified: ${unrecognizedCount} unrecognized from ${from}`, {
      jobId: job.id,
      icon: '⚠️',
    });
  }
}

// ─── SMS TEMPLATES ───────────────────────────────────────────

function formatCashCheckSMS(job, amount) {
  const name = (job.customer_name || '').split(' ')[0] || '';
  const when = job.scheduled_date ? `See you ${job.scheduled_date}${job.scheduled_time ? ' around ' + job.scheduled_time : ''}` : 'We\'ll confirm the exact time soon';
  return `Sounds good! Our crew will take care of payment when they arrive — just have $${amount} ready. ${when} 🚛 Text us if anything comes up! (559) 774-4249`;
}

function formatCardSMS(stripeUrl) {
  return `Here's your payment link: ${stripeUrl} — go ahead and pay whenever you're ready, no rush. Once it goes through we'll send a confirmation and you're all set for pickup. Any questions just text back!`;
}

module.exports = { handleInboundSMS, parseIntent, generateHumanResponse };
