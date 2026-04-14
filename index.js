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
const { db, isConfigured: fbConfigured, getCredentialMode: fbMode } = require('./core/firestore');

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

// ── 13. AGENT OS ──────────────────────────────────────────────────────────
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
agents.customersuccess = agents.customer_success; // alias for meeting runner lookup

// Start all agents as concurrent async processes
// They run independently — one crashing doesn't stop the others
logger.log('startup', 'INFO', 'Starting TrashApp AI Operating System...');

Object.entries(agents).forEach(([name, agent]) => {
  if (!agent || name === 'customersuccess') return; // skip alias
  agent.start().catch(err => {
    logger.log('startup', 'ERROR', `${name} agent crashed: ${err.message}`);
    // Restart after 60 seconds
    setTimeout(() => agent.start().catch(() => {}), 60000);
  });
  logger.log('startup', 'SUCCESS', `${agent.emoji} ${agent.agentName} Agent started`);
});

// Weekly staff meeting — every Monday 9am Pacific
const agentCron = require('node-cron');
agentCron.schedule('0 9 * * 1', async () => {
  try {
    await runWeeklyMeeting(agents);
  } catch (err) {
    logger.log('meeting', 'ERROR', `Weekly meeting failed: ${err.message}`);
  }
}, { timezone: 'America/Los_Angeles' });

logger.log('startup', 'SUCCESS', '🚀 TrashApp AI OS fully operational — 9 agents running');

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
