/**
 * index.js — TrashApp Mastermind Entry Point
 *
 * Startup sequence:
 * 1. Load .env
 * 2. Initialize logger
 * 3. Connect Firebase (or log not configured)
 * 4. Connect Twilio (or log not configured)
 * 5. Connect Stripe (or log not configured)
 * 6. Generate PDF if it doesn't exist
 * 7. Start webhook receivers on Express
 * 8. Start pipeline Firestore watcher
 * 9. Start all scheduler cron jobs
 * 10. Start dashboard server
 * 11. Log startup summary
 * 12. Send startup SMS if Twilio configured
 */

// 1. Load environment variables
require('dotenv').config();

// 2. Initialize logger (must come before other modules that use it)
const logger = require('./core/logger');

// 3. Connect Firebase
const { db, admin: fbAdmin, isConfigured: fbConfigured, getCredentialMode: fbMode } = require('./core/firestore');

// 4. Connect Twilio
const twilio = require('./core/twilio');

// 5. Connect Stripe
const stripe = require('./core/stripe');

// 6. Generate PDF if needed
const { generatePDF } = require('./generate-pdf');
try {
  generatePDF();
} catch (err) {
  console.error('[PDF] Generation error:', err.message);
}

// 7. Start dashboard + webhook receivers
const { startDashboard, getApp } = require('./dashboard/server');
const PORT = parseInt(process.env.DASHBOARD_PORT) || 3000;
const { app, server, io } = startDashboard(PORT);

// Register webhook routes on the Express app
const { registerCalendlyWebhook } = require('./webhooks/calendly');
const { registerStripeWebhook } = require('./webhooks/stripe');
const { registerTwilioWebhook } = require('./webhooks/twilio');
const { registerTwilioInboundWebhook } = require('./webhooks/twilio-inbound');

const expressApp = getApp();
registerCalendlyWebhook(expressApp);
registerStripeWebhook(expressApp);
registerTwilioWebhook(expressApp);
registerTwilioInboundWebhook(expressApp);

// 8. Start pipeline Firestore watcher
const { startPipeline } = require('./dispatch/pipeline');
startPipeline();

// 8.5. Check gas price freshness on startup
(async () => {
  try {
    const { updateGasPrice } = require('./core/gas-price');
    if (db._isMock) return;
    const gasDoc = await db.collection('system_config').doc('gas_price').get();
    const lastFetch = gasDoc.exists ? gasDoc.data()?.fetchedAt?.toDate?.() : null;
    const hoursOld = lastFetch ? (Date.now() - lastFetch.getTime()) / 3600000 : 999;
    if (hoursOld > 24) {
      logger.log('startup', 'INFO', 'Gas price stale — refreshing from EIA...');
      await updateGasPrice(db, logger);
    } else {
      logger.log('startup', 'INFO', `Gas price current: $${gasDoc.data()?.value}/gal (${Math.round(hoursOld)}h old)`);
    }
  } catch(e) { logger.log('startup', 'WARN', 'Gas price check failed: ' + e.message); }
})();

// 9. Start scheduler cron jobs
const { startScheduler } = require('./dispatch/scheduler');
startScheduler();

// 10. Dashboard already started in step 7

// 11. Log startup summary
const services = {
  Firebase: fbConfigured()
    ? (fbMode && fbMode() === 'adc' ? 'ADC' : 'ACTIVE')
    : 'NOT CONFIGURED',
  Twilio: twilio.isConfigured() ? 'ACTIVE' : 'NOT CONFIGURED',
  Stripe: stripe.isConfigured() ? 'ACTIVE' : 'NOT CONFIGURED',
};

console.log('\n══════════════════════════════════════════════');
console.log('  TRASHAPP MASTERMIND — AI Dispatch Brain');
console.log('══════════════════════════════════════════════');
console.log(`  Dashboard:  http://localhost:${PORT}`);
console.log(`  Firebase:   ${services.Firebase}`);
console.log(`  Twilio:     ${services.Twilio}`);
console.log(`  Stripe:     ${services.Stripe}`);
console.log(`  Webhooks:   /webhooks/calendly, /webhooks/stripe, /webhooks/twilio`);
console.log(`  Health:     http://localhost:${PORT}/health`);
console.log('══════════════════════════════════════════════\n');

logger.success('startup', `TrashApp Mastermind started — Dashboard: localhost:${PORT}`, {
  services,
  port: PORT,
  icon: '🚀',
});

// 12. Send startup SMS if Twilio is configured
(async () => {
  if (twilio.isConfigured()) {
    const adminPhone = process.env.ADMIN_PHONE || '+15597744249';
    const serviceList = Object.entries(services)
      .map(([name, status]) => `${name}: ${status === 'ACTIVE' ? '✓' : '✗'}`)
      .join(', ');

    try {
      await twilio.sendSMS(
        adminPhone,
        `TrashApp Mastermind started ✓ Dashboard: localhost:${PORT} Services: ${serviceList}`
      );
    } catch (err) {
      console.error('[Startup SMS] Failed:', err.message);
    }
  }
})();

// ── 13. AI BOARDROOM ──────────────────────────────────────────────────────
const CEOAgent = require('./agents/ceo-agent');
const CFOAgent = require('./agents/cfo-agent');
const CMOAgent = require('./agents/cmo-agent');
const OperationsAgent = require('./agents/operations-agent');
const HRAgent = require('./agents/hr-agent');
const TrainingAgent = require('./agents/training-agent');
const CustomerSuccessAgent = require('./agents/customer-success-agent');
const LegalAgent = require('./agents/legal-agent');
const PricingAgent = require('./agents/pricing-agent');
const { runWeeklyMeeting } = require('./agents/meeting-runner');

// Instantiate all agents
const agents = {
  ceo: new CEOAgent(),
  cfo: new CFOAgent(),
  cmo: new CMOAgent(),
  operations: new OperationsAgent(),
  hr: new HRAgent(),
  training: new TrainingAgent(),
  customer_success: new CustomerSuccessAgent(),
  customersuccess: null, // alias set below
  legal: new LegalAgent(),
  pricing: new PricingAgent()
};
agents.customersuccess = agents.customer_success;

// Agent list for boardroom iteration (no aliases)
const agentList = [
  agents.ceo, agents.cfo, agents.cmo, agents.operations,
  agents.hr, agents.training, agents.customer_success,
  agents.legal, agents.pricing
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── BOARDROOM HELPERS ─────────────────────────────────────────────────────

/**
 * Read last N messages from agent_messages ordered by timestamp desc.
 */
async function getRecentMessages(n = 20) {
  try {
    const snap = await db.collection('agent_messages')
      .orderBy('timestamp', 'desc')
      .limit(n)
      .get();
    return snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .reverse(); // chronological order
  } catch (e) {
    logger.log('boardroom', 'WARN', 'getRecentMessages failed: ' + e.message);
    return [];
  }
}

/**
 * Determine if an agent should speak right now.
 * Returns true if:
 *  - Owner posted (type: owner_input) in last 5 messages
 *  - Another agent mentioned this agent by name in last 5 messages
 *  - CEO assigned this agent a task in last 5 messages
 *  - Agent hasn't spoken in 30+ minutes (keep conversation alive)
 *  - It's the CEO and 30 minutes have passed since last CEO summary
 */
function agentShouldRespond(agent, messages) {
  const last5 = messages.slice(-5);
  const agentId = agent.agentId;
  const agentName = agent.agentName.toLowerCase();

  // 1. Owner posted recently
  const ownerPosted = last5.some(m => m.type === 'owner_input');
  if (ownerPosted) return true;

  // 2. Another agent mentioned this agent by name
  const mentioned = last5.some(m =>
    m.agentId !== agentId &&
    m.message &&
    (m.message.toLowerCase().includes(agentName) || m.message.toLowerCase().includes(agentId))
  );
  if (mentioned) return true;

  // 3. CEO assigned this agent a task
  const ceoDirective = last5.some(m =>
    m.agentId === 'ceo' && m.message &&
    (m.message.toLowerCase().includes(agentName + ' please') ||
     m.message.toLowerCase().includes(agentId + ' please') ||
     m.message.toLowerCase().includes(`[${agentName}]`) ||
     m.message.toLowerCase().includes(`[${agentId}]`))
  );
  if (ceoDirective) return true;

  // 4. Agent hasn't spoken in 30+ minutes
  const lastSpoke = [...messages].reverse().find(m => m.agentId === agentId);
  if (lastSpoke && lastSpoke.timestamp) {
    const spokeAt = lastSpoke.timestamp.toDate ? lastSpoke.timestamp.toDate() : new Date(lastSpoke.timestamp);
    const minutesAgo = (Date.now() - spokeAt.getTime()) / 60000;
    if (minutesAgo >= 30) return true;
  } else {
    // Never spoken — should speak
    return true;
  }

  // 5. CEO's 30-minute summary turn
  if (agentId === 'ceo') {
    const lastCEO = [...messages].reverse().find(m => m.agentId === 'ceo');
    if (!lastCEO) return true;
    const ceoAt = lastCEO.timestamp?.toDate ? lastCEO.timestamp.toDate() : new Date(lastCEO.timestamp);
    if ((Date.now() - ceoAt.getTime()) / 60000 >= 30) return true;
  }

  return false;
}

/**
 * Extract plain-text message from Claude response.
 * Claude sometimes wraps replies in JSON or markdown code fences.
 */
function extractMessageText(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  let text = raw;
  try {
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    text = parsed.response || parsed.message || parsed.content || parsed.text || parsed.body || raw;
  } catch (_) {
    // Not JSON — use as-is
    text = raw;
  }
  return String(text).trim();
}

/**
 * Post a boardroom message to agent_messages.
 */
async function postMessage(agentId, name, emoji, text) {
  try {
    const cleanText = extractMessageText(text);
    if (!cleanText) return;
    await db.collection('agent_messages').add({
      from: name,
      agentId,
      emoji,
      message: cleanText,
      timestamp: fbAdmin.firestore ? fbAdmin.firestore.FieldValue.serverTimestamp() : new Date(),
      type: 'boardroom'
    });
    logger.log('boardroom', 'INFO', `${emoji} ${name}: ${cleanText.substring(0, 80)}...`);
  } catch (e) {
    logger.log('boardroom', 'ERROR', `postMessage failed for ${name}: ${e.message}`);
  }
}

/**
 * The continuous AI Boardroom loop.
 * Replaces scheduled agent cycles with a live, conversational flow.
 */
async function runBoardroom() {
  logger.log('boardroom', 'INFO', '🏛️ AI Boardroom starting — continuous mode');

  // Initial CEO opening message
  try {
    const metrics = await agents.ceo.pullMetrics();
    const openingMsg = `Good ${new Date().getHours() < 12 ? 'morning' : 'afternoon'} team. Boardroom is live. ` +
      `Current state: ${metrics.weeklyJobs || 0} jobs this week, ${agents.ceo.formatCurrency(metrics.weeklyRevenue || 0)} revenue, ` +
      `${metrics.activeReps || 0} active reps. Let's stay sharp. — CEO`;
    await postMessage('ceo', 'CEO', '🤖', openingMsg);
  } catch (e) {
    logger.log('boardroom', 'WARN', 'CEO opening failed: ' + e.message);
  }

  while (true) {
    for (const agent of agentList) {
      try {
        const recent = await getRecentMessages(20);
        const shouldRespond = agentShouldRespond(agent, recent);
        if (shouldRespond) {
          const response = await agent.boardroomThink(recent);
          if (response) {
            await postMessage(agent.agentId, agent.agentName, agent.emoji, response);
          }
        }
      } catch (e) {
        logger.log('boardroom', 'ERROR', `${agent.agentName} error: ${e.message}`);
      }
      await sleep(3000); // 3s between agents
    }
    await sleep(10000); // 10s between full cycles
  }
}

// Weekly staff meeting — every Monday 9am Pacific (still runs as formal meeting)
const agentCron = require('node-cron');
agentCron.schedule('0 9 * * 1', async () => {
  try {
    await runWeeklyMeeting(agents);
  } catch (err) {
    logger.log('meeting', 'ERROR', `Weekly meeting failed: ${err.message}`);
  }
}, { timezone: 'America/Los_Angeles' });

// Start the boardroom
logger.log('startup', 'INFO', 'Starting TrashApp AI Boardroom...');
runBoardroom().catch(err => {
  logger.log('boardroom', 'FATAL', `Boardroom loop crashed: ${err.message}`);
  // Restart after 30 seconds
  setTimeout(() => runBoardroom().catch(() => {}), 30000);
});

logger.log('startup', 'SUCCESS', '🏛️ TrashApp AI Boardroom operational — 9 agents in continuous loop');

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Shutdown] Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[Shutdown] Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  logger.error('system', `Uncaught exception: ${err.message}`, { error: err.message, stack: err.stack }).catch(() => {});
  // Don't exit — let the service manager handle restarts if needed
});

process.on('unhandledRejection', (reason) => {
  console.error('[WARNING] Unhandled promise rejection:', reason);
  logger.error('system', `Unhandled rejection: ${reason}`, { error: String(reason) }).catch(() => {});
});
