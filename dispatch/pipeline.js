/**
 * dispatch/pipeline.js — Job state machine
 * Watches the `jobs` Firestore collection in real time and routes
 * jobs through handlers based on status transitions.
 */

const { db } = require('../core/firestore');
const logger = require('../core/logger');
const { sendSMS } = require('../core/twilio');
const { createPaymentLink } = require('../core/stripe');
const { verifyQuote } = require('./ai-verify');
const pricing = require('../config/pricing.json');

const ADMIN_PHONE = process.env.ADMIN_PHONE || '+15597744249';

// Track previous job states to detect transitions
const jobStates = new Map();
let unsubscribe = null;

/**
 * Start watching the jobs collection for status changes.
 */
function startPipeline() {
  if (db._isMock) {
    console.log('[Pipeline] Firebase not configured — pipeline watcher disabled');
    return;
  }

  console.log('[Pipeline] Starting Firestore job watcher...');

  unsubscribe = db.collection('jobs').onSnapshot(
    (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        const job = { id: change.doc.id, ...change.doc.data() };

        if (change.type === 'added' || change.type === 'modified') {
          const prevStatus = jobStates.get(job.id);
          const newStatus = job.status;

          if (prevStatus !== newStatus) {
            jobStates.set(job.id, newStatus);
            handleStatusChange(job, prevStatus, newStatus).catch((err) => {
              logger.error('pipeline', `Handler error for Job ${job.id}: ${err.message}`, {
                jobId: job.id,
                prevStatus: prevStatus || 'unknown',
                newStatus,
                error: err.message,
              });
            });
          }
        }

        if (change.type === 'removed') {
          jobStates.delete(job.id);
        }
      });
    },
    (err) => {
      logger.error('pipeline', `Firestore watcher error: ${err.message}`, { error: err.message });
    }
  );

  logger.success('pipeline', 'Job pipeline watcher started');
}

/**
 * Route a job to the appropriate handler based on its new status.
 */
async function handleStatusChange(job, prevStatus, newStatus) {
  await logger.log('pipeline', 'SUCCESS', `Job ${job.id}: ${prevStatus || 'NEW'} → ${newStatus}`, {
    type: 'status_transition',
    jobId: job.id,
    prevStatus: prevStatus || 'unknown',
    newStatus,
    icon: '🔄',
  });

  switch (newStatus) {
    case 'QUOTED':
      return handleQuoted(job);
    case 'QUOTE_SENT':
      return handleQuoteSent(job);
    case 'CONFIRMED':
      return handleConfirmed(job);
    case 'AWAITING_PAYMENT':
      return handleAwaitingPayment(job);
    case 'SCHEDULED':
      return handleScheduled(job);
    case 'IN_PROGRESS':
      return handleInProgress(job);
    case 'COMPLETED':
      return handleCompleted(job);
    case 'CANCELLED':
      return handleCancelled(job);
    case 'DEAL_CLOSED':
      return handleDealClosed(job);
    default:
      // Log unknown statuses but don't crash
      await logger.partial('pipeline', `Job ${job.id}: Unknown status "${newStatus}"`, { jobId: job.id });
  }
}

// ─── STATUS HANDLERS ─────────────────────────────────────────

/**
 * QUOTED → Run AI re-verification, route by confidence.
 */
async function handleQuoted(job) {
  const result = await verifyQuote(job);

  if (result.action === 'auto_send') {
    // High confidence — send quote SMS automatically
    if (job.phone) {
      const sms = formatQuoteSMS(job, result);
      await sendSMS(job.phone, sms);
    }
    await db.collection('jobs').doc(job.id).update({
      status: 'QUOTE_SENT',
      ai_confidence: result.confidence,
      ai_priceRange: result.priceRange,
      ai_midpoint: result.midpoint,
      ai_negotiationFloor: result.negotiationFloor,
      ai_itemsSeen: result.itemsSeen,
      ai_notes: result.notes,
      quote_sent_at: new Date().toISOString(),
    });
  } else if (result.action === 'manual_review') {
    // Medium confidence — send to manual review
    await db.collection('manual_review').add({
      jobId: job.id,
      customer_name: job.customer_name,
      address: job.address,
      phone: job.phone,
      confidence: result.confidence,
      priceRange: result.priceRange,
      midpoint: result.midpoint,
      itemsSeen: result.itemsSeen,
      notes: result.notes,
      needs_photos: false,
      created_at: new Date().toISOString(),
    });
    await sendSMS(ADMIN_PHONE, formatLowConfidenceAdminSMS(job, result));
    await logger.partial('pipeline', `Job ${job.id} sent to manual review (confidence: ${(result.confidence * 100).toFixed(0)}%)`, {
      jobId: job.id,
      icon: '⚠️',
    });
  } else {
    // Low confidence — needs photos
    await db.collection('manual_review').add({
      jobId: job.id,
      customer_name: job.customer_name,
      address: job.address,
      phone: job.phone,
      confidence: result.confidence,
      priceRange: result.priceRange,
      needs_photos: true,
      created_at: new Date().toISOString(),
    });
    await sendSMS(ADMIN_PHONE, formatLowConfidenceAdminSMS(job, result));
    await logger.partial('pipeline', `Job ${job.id} flagged needs_photos (confidence: ${(result.confidence * 100).toFixed(0)}%)`, {
      jobId: job.id,
      icon: '📸',
    });
  }
}

/**
 * QUOTE_SENT → Waiting for customer SMS reply (handled by sms-conversation.js)
 */
async function handleQuoteSent(job) {
  await logger.success('pipeline', `Job ${job.id}: Quote sent, waiting for customer reply`, {
    jobId: job.id,
    icon: '📱',
  });
}

/**
 * CONFIRMED → Waiting for payment method selection
 */
async function handleConfirmed(job) {
  if (job.phone) {
    await sendSMS(job.phone, formatPaymentSMS());
  }
  await logger.success('pipeline', `Job ${job.id}: Confirmed, payment method SMS sent`, {
    jobId: job.id,
    icon: '✅',
  });
}

/**
 * AWAITING_PAYMENT → Waiting for Stripe webhook (handled by webhooks/stripe.js)
 */
async function handleAwaitingPayment(job) {
  await logger.success('pipeline', `Job ${job.id}: Awaiting Stripe payment`, {
    jobId: job.id,
    icon: '💳',
  });
}

/**
 * SCHEDULED → Ready for crew assignment
 */
async function handleScheduled(job) {
  if (job.assigned_crew_id && job.crew_phone) {
    // Send crew schedule SMS
    await sendSMS(job.crew_phone, `New job on the schedule: ${job.address}, ${job.scheduled_date} at ${job.scheduled_time}. Check the schedule for details 💪`);
  }
  await logger.success('pipeline', `Job ${job.id}: Scheduled${job.assigned_crew_id ? ' — crew notified' : ''}`, {
    jobId: job.id,
    icon: '📅',
  });
}

/**
 * IN_PROGRESS → Crew checked in, send customer ETA
 */
async function handleInProgress(job) {
  if (job.phone && job.eta_minutes) {
    await sendSMS(job.phone, formatETASMS(job));
  }
  await logger.success('pipeline', `Job ${job.id}: In progress`, {
    jobId: job.id,
    icon: '🚛',
  });
}

/**
 * COMPLETED → Final processing: payment, commission, receipts
 */
async function handleCompleted(job) {
  try {
    const actualRevenue = job.actual_revenue || job.estimated_revenue || 0;

    // Send receipt
    if (job.phone) {
      await sendSMS(job.phone, formatReceiptSMS(job, actualRevenue));
    }

    // Calculate and write commission
    if (job.assigned_rep_id) {
      const repDoc = await db.collection('reps').doc(job.assigned_rep_id).get();
      if (repDoc.exists) {
        const rep = repDoc.data();
        const commissionPct = rep.commission || 15;
        const commissionAmount = Math.round(actualRevenue * (commissionPct / 100) * 100) / 100;

        await db.collection('commission_log').add({
          rep_id: job.assigned_rep_id,
          rep_name: rep.name || 'Unknown',
          job_id: job.id,
          deal_value: actualRevenue,
          commission_percent: commissionPct,
          commission_amount: commissionAmount,
          status: 'PENDING',
          created_at: new Date().toISOString(),
        });

        // Notify rep
        if (rep.phone) {
          await sendSMS(rep.phone, `💰 Commission logged! $${commissionAmount.toFixed(2)} earned on the ${job.address} job. Great close — keep it up!`);
        }

        await logger.success('pipeline', `Job ${job.id}: Commission $${commissionAmount.toFixed(2)} logged for ${rep.name}`, {
          jobId: job.id,
          icon: '💰',
        });
      }
    }

    // Write to financials
    await db.collection('financials').add({
      job_id: job.id,
      date: new Date().toISOString().split('T')[0],
      gross_revenue: actualRevenue,
      customer_name: job.customer_name,
      address: job.address,
      payment_method: job.payment_method || 'unknown',
      created_at: new Date().toISOString(),
    });

    await logger.success('pipeline', `Job ${job.id}: Completed — Revenue: $${actualRevenue}`, {
      jobId: job.id,
      icon: '✅',
      revenue: actualRevenue,
    });
  } catch (err) {
    await logger.error('pipeline', `Job ${job.id}: Completion handler error: ${err.message}`, {
      jobId: job.id,
      error: err.message,
    });
  }
}

/**
 * DEAL_CLOSED → Same-day close from rep platform (skips SMS pipeline).
 * Rep already collected payment on-site. Log commission and financials.
 */
async function handleDealClosed(job) {
  try {
    const actualRevenue = job.actual_revenue || job.estimated_revenue || 0;

    // Calculate and write commission
    if (job.assigned_rep_id || job.repId) {
      const repId = job.assigned_rep_id || job.repId;
      const repDoc = await db.collection('reps').doc(repId).get();
      if (repDoc.exists) {
        const rep = repDoc.data();
        const commissionPct = rep.commission || 15;
        const commissionAmount = Math.round(actualRevenue * (commissionPct / 100) * 100) / 100;

        await db.collection('commission_log').add({
          rep_id: repId,
          rep_name: rep.name || 'Unknown',
          job_id: job.id,
          deal_value: actualRevenue,
          commission_percent: commissionPct,
          commission_amount: commissionAmount,
          status: 'PENDING',
          source: 'same_day_close',
          created_at: new Date().toISOString(),
        });

        await logger.success('pipeline', `Job ${job.id}: Same-day close — Commission $${commissionAmount.toFixed(2)} logged for ${rep.name}`, {
          jobId: job.id,
          icon: '🎉',
        });
      }
    }

    // Write to financials
    await db.collection('financials').add({
      job_id: job.id,
      date: new Date().toISOString().split('T')[0],
      gross_revenue: actualRevenue,
      customer_name: job.customer_name,
      address: job.address,
      payment_method: job.payment_method || 'cash',
      source: 'same_day_close',
      created_at: new Date().toISOString(),
    });

    // Send customer receipt if phone available
    if (job.phone) {
      const name = (job.customer_name || '').split(' ')[0] || '';
      await sendSMS(job.phone, `Got your payment, thank you${name ? ' ' + name : ''}! ✓ Our crew will take care of everything. Questions? (559) 774-4249`);
    }

    await logger.success('pipeline', `Job ${job.id}: Same-day close completed — Revenue: $${actualRevenue}`, {
      jobId: job.id,
      icon: '🎉',
      revenue: actualRevenue,
      source: 'rep_platform',
    });
  } catch (err) {
    await logger.error('pipeline', `Job ${job.id}: Deal closed handler error: ${err.message}`, {
      jobId: job.id,
      error: err.message,
    });
  }
}

/**
 * CANCELLED → Notify rep, log cancellation
 */
async function handleCancelled(job) {
  if (job.phone) {
    await sendSMS(job.phone, formatCancelSMS(job));
  }

  // Notify assigned rep
  if (job.assigned_rep_id) {
    const repDoc = await db.collection('reps').doc(job.assigned_rep_id).get();
    if (repDoc.exists && repDoc.data().phone) {
      await sendSMS(repDoc.data().phone, `Heads up — the customer at ${job.address} cancelled their booking. Happens sometimes, keep knocking! 💪`);
    }
  }

  await logger.success('pipeline', `Job ${job.id}: Cancelled`, {
    jobId: job.id,
    icon: '❌',
  });
}

// ─── SMS MESSAGE FORMATTERS ──────────────────────────────────

function formatQuoteSMS(job, result) {
  const name = (job.customer_name || '').split(' ')[0] || 'there';
  const dateInfo = job.scheduled_date ? `We have availability ${job.scheduled_date}${job.scheduled_time ? ' around ' + job.scheduled_time : ''}.` : 'We can usually get out there within a few days.';
  return `Hey ${name}! This is TrashApp — we got your junk removal request for ${job.address || 'your place'} 👍 We're looking at ${result.priceRange} for the haul. ${dateInfo} Does that work? Just reply YES and we'll lock it in, or reply NO if you need a different time. — TrashApp (559) 774-4249`;
}

function formatPaymentSMS() {
  return `Perfect, you're all set! Quick question — how would you like to pay when we show up? Reply CASH, CHECK, or CARD and we'll get everything ready on our end 🙌`;
}

function formatReceiptSMS(job, amount) {
  const name = (job.customer_name || '').split(' ')[0] || '';
  const dateInfo = job.scheduled_date || '';
  return `Got your payment, thank you${name ? ' ' + name : ''}! ✓ ${dateInfo ? `You're confirmed for ${dateInfo}. ` : ''}Our crew will take care of everything — see you then! Questions? (559) 774-4249`;
}

function formatCancelSMS(job) {
  const name = (job.customer_name || '').split(' ')[0] || '';
  return `No worries at all${name ? ' ' + name : ''}! We cancelled your appointment. Whenever you're ready to clear that stuff out, just reach back out — we're always around. (559) 774-4249 😊`;
}

function formatETASMS(job) {
  const name = (job.customer_name || '').split(' ')[0] || '';
  return `Hey${name ? ' ' + name : ''}! Your crew is on the way and should be there in about ${job.eta_minutes || '30'} minutes 🚛 They'll handle everything — no need to do anything except let them in. Text us if you need anything! (559) 774-4249`;
}

function formatLowConfidenceAdminSMS(job, result) {
  return `Hey — quick heads up. Job at ${job.address || '?'} needs your eyes on it. AI wasn't super confident (${(result.confidence * 100).toFixed(0)}%) so it didn't auto-send. Quote is sitting at ${result.priceRange || 'N/A'}. Check it out: admin.trashappjunkremoval.com`;
}

/**
 * Stop the pipeline watcher.
 */
function stopPipeline() {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
    console.log('[Pipeline] Firestore watcher stopped');
  }
}

module.exports = { startPipeline, stopPipeline };
