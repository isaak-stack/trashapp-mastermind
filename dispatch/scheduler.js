/**
 * dispatch/scheduler.js — Cron job scheduler
 * All scheduled tasks using node-cron. Runs health checks,
 * follow-ups, daily reports, crew scheduling, and nightly maintenance.
 */

const cron = require('node-cron');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { db } = require('../core/firestore');
const logger = require('../core/logger');
const { sendSMS } = require('../core/twilio');
const twilioService = require('../core/twilio');
const stripeService = require('../core/stripe');

const { runBugScan } = require('../maintenance/bug-scanner');
const { updateGasPrice } = require('../core/gas-price');

const ADMIN_PHONE = process.env.ADMIN_PHONE || '+15597744249';
const QUOTE_API = process.env.RAILWAY_QUOTE_API || 'https://junk-quote-api-production.up.railway.app/api/quote';
const OFFICE_LAT = 36.7765;
const OFFICE_LNG = -119.8420;

const HEALTH_URLS = [
  { name: 'Railway Quote API', url: 'https://junk-quote-api-production.up.railway.app/health' },
  { name: 'Rep Platform', url: 'https://reps.trashappjunkremoval.com' },
  { name: 'Admin Console', url: 'https://admin.trashappjunkremoval.com' },
  { name: 'Quote Page', url: 'https://quote.trashappjunkremoval.com' },
  { name: 'Homepage', url: 'https://trashappjunkremoval.com' },
];

let scheduledJobs = [];

/**
 * Start all cron jobs.
 */
function startScheduler() {
  console.log('[Scheduler] Starting cron jobs...');

  // ─── 6:00 AM — Daily crew scheduling ──────────────────
  scheduledJobs.push(
    cron.schedule('0 6 * * *', () => safeRun('daily_crew_schedule', dailyCrewSchedule), { timezone: 'America/Los_Angeles' })
  );

  // ─── Monday 6:00 AM — Weekly gas price update ────────────
  scheduledJobs.push(
    cron.schedule('5 6 * * 1', () => safeRun('gas_price_update', async () => {
      const price = await updateGasPrice(db, logger);
      if (price) {
        const { getIO } = require('../dashboard/server');
        const io = getIO();
        if (io) io.emit('gas_price_updated', { price, timestamp: new Date().toISOString() });
      }
    }), { timezone: 'America/Los_Angeles' })
  );

  // ─── 8:00 AM — Quote follow-ups ───────────────────────
  scheduledJobs.push(
    cron.schedule('0 8 * * *', () => safeRun('quote_followup', quoteFollowUp), { timezone: 'America/Los_Angeles' })
  );

  // ─── 12:00 PM — Leaderboard ───────────────────────────
  scheduledJobs.push(
    cron.schedule('0 12 * * *', () => safeRun('leaderboard', calculateLeaderboard), { timezone: 'America/Los_Angeles' })
  );

  // ─── 8:00 PM — Daily summary ──────────────────────────
  scheduledJobs.push(
    cron.schedule('0 20 * * *', () => safeRun('daily_summary', dailySummary), { timezone: 'America/Los_Angeles' })
  );

  // ─── Every hour — Health checks ───────────────────────
  scheduledJobs.push(
    cron.schedule('0 * * * *', () => safeRun('health_check', hourlyHealthCheck), { timezone: 'America/Los_Angeles' })
  );

  // ─── Every 30 min — ETA reminders (checks jobs 30min out) ─
  scheduledJobs.push(
    cron.schedule('*/30 * * * *', () => safeRun('eta_reminder', etaReminders), { timezone: 'America/Los_Angeles' })
  );

  // ─── NIGHTLY MAINTENANCE WINDOW ───────────────────────
  // 2:00 AM — Deep health check
  scheduledJobs.push(
    cron.schedule('0 2 * * *', () => safeRun('deep_health', deepHealthCheck), { timezone: 'America/Los_Angeles' })
  );

  // 2:30 AM — npm dependency check
  scheduledJobs.push(
    cron.schedule('30 2 * * *', () => safeRun('dep_check', dependencyCheck), { timezone: 'America/Los_Angeles' })
  );

  // 3:00 AM — Error log analysis
  scheduledJobs.push(
    cron.schedule('0 3 * * *', () => safeRun('error_analysis', errorLogAnalysis), { timezone: 'America/Los_Angeles' })
  );

  // 3:15 AM — Platform bug scan
  scheduledJobs.push(
    cron.schedule('15 3 * * *', () => safeRun('bug_scan', nightlyBugScan), { timezone: 'America/Los_Angeles' })
  );

  // 3:30 AM — Data integrity check
  scheduledJobs.push(
    cron.schedule('30 3 * * *', () => safeRun('data_integrity', dataIntegrityCheck), { timezone: 'America/Los_Angeles' })
  );

  // 4:00 AM — Performance report
  scheduledJobs.push(
    cron.schedule('0 4 * * *', () => safeRun('perf_report', performanceReport), { timezone: 'America/Los_Angeles' })
  );

  // 4:15 AM — GitHub backup check
  scheduledJobs.push(
    cron.schedule('15 4 * * *', () => safeRun('github_check', githubBackupCheck), { timezone: 'America/Los_Angeles' })
  );

  // 4:30 AM — Maintenance complete
  scheduledJobs.push(
    cron.schedule('30 4 * * *', () => safeRun('maint_complete', maintenanceComplete), { timezone: 'America/Los_Angeles' })
  );

  // ─── SLOT BOOKING SYSTEM ──────────────────────────────────
  // Sunday 11:00 PM — Generate slots for next 7 days
  scheduledJobs.push(
    cron.schedule('0 23 * * 0', () => safeRun('slot_generation', generateWeekSlots), { timezone: 'America/Los_Angeles' })
  );

  // Every 5 minutes — Release expired holds
  scheduledJobs.push(
    cron.schedule('*/5 * * * *', () => safeRun('hold_expiry', releaseExpiredHolds), { timezone: 'America/Los_Angeles' })
  );

  // ─── INTEL SCRAPER ────────────────────────────────────────
  // 2:15 AM — Scrape field sales intelligence
  scheduledJobs.push(
    cron.schedule('15 2 * * *', () => safeRun('intel_scrape', async () => {
      const { scrapeIntel } = require('../core/intel-scraper');
      await scrapeIntel();
    }), { timezone: 'America/Los_Angeles' })
  );

  // ─── TERRITORY ENGINE ─────────────────────────────────────
  // Sunday 10:00 PM — Generate territory assignments
  scheduledJobs.push(
    cron.schedule('0 22 * * 0', () => safeRun('territory_engine', async () => {
      const { runTerritoryEngine } = require('../dispatch/territory-engine');
      await runTerritoryEngine();
    }), { timezone: 'America/Los_Angeles' })
  );

  // Monday 7:00 AM — Send briefing SMS to reps
  scheduledJobs.push(
    cron.schedule('0 7 * * 1', () => safeRun('briefing_sms', async () => {
      const { sendBriefingSMS } = require('../dispatch/territory-engine');
      await sendBriefingSMS();
    }), { timezone: 'America/Los_Angeles' })
  );

  logger.success('scheduler', `All cron jobs started (${scheduledJobs.length} jobs)`);
}

/**
 * Wrap a scheduled task in error handling — never crash.
 */
async function safeRun(name, fn) {
  try {
    await fn();
  } catch (err) {
    await logger.error('scheduler', `Cron job "${name}" failed: ${err.message}`, {
      cronJob: name,
      error: err.message,
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// DAYTIME SCHEDULED TASKS
// ═══════════════════════════════════════════════════════════════

/**
 * 6:00 AM — Query today's SCHEDULED jobs, group by crew,
 * optimize route order, send crew schedule SMS.
 */
async function dailyCrewSchedule() {
  if (db._isMock) return;

  const today = new Date().toISOString().split('T')[0];
  const snap = await db.collection('jobs')
    .where('status', '==', 'SCHEDULED')
    .where('scheduled_date', '==', today)
    .get();

  if (snap.empty) {
    await logger.success('scheduler', 'No jobs scheduled for today');
    return;
  }

  // Group by crew
  const crewJobs = {};
  snap.docs.forEach((doc) => {
    const job = { id: doc.id, ...doc.data() };
    const crew = job.assigned_crew_id || 'unassigned';
    if (!crewJobs[crew]) crewJobs[crew] = [];
    crewJobs[crew].push(job);
  });

  // For each crew, sort jobs by nearest-neighbor from office
  for (const [crewId, jobs] of Object.entries(crewJobs)) {
    const sorted = nearestNeighborSort(jobs);

    // Build schedule SMS
    const jobsList = sorted.map((j, i) => `${i + 1}. ${j.address} (${j.scheduled_time || 'TBD'}) - ${j.customer_name}`).join('\n');
    const firstTime = sorted[0]?.scheduled_time || 'TBD';

    const scheduleMsg = `Morning! Here's your schedule for today ${today} 🚛\n\n${jobsList}\n\nFirst stop at ${firstTime}. Reply ARRIVED at each address so we can update the customer. Have a great day — let us know if anything comes up!`;

    // Find crew phone
    if (crewId !== 'unassigned') {
      const crewDoc = await db.collection('crews').doc(crewId).get();
      if (crewDoc.exists && crewDoc.data().phone) {
        await sendSMS(crewDoc.data().phone, scheduleMsg);
      }
    }

    // Write estimated arrival times
    for (const job of sorted) {
      await db.collection('jobs').doc(job.id).update({
        route_order: sorted.indexOf(job) + 1,
        estimated_arrival_time: job.scheduled_time,
      });
    }

    await logger.success('scheduler', `Crew ${crewId}: ${sorted.length} jobs scheduled, route optimized`, {
      crewId,
      jobCount: sorted.length,
      icon: '📅',
    });
  }
}

/**
 * Simple nearest-neighbor route optimization from office coordinates.
 */
function nearestNeighborSort(jobs) {
  if (jobs.length <= 1) return jobs;

  const remaining = [...jobs];
  const sorted = [];
  let currentLat = OFFICE_LAT;
  let currentLng = OFFICE_LNG;

  while (remaining.length > 0) {
    let nearestIdx = 0;
    let nearestDist = Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const job = remaining[i];
      const lat = job.lat || job.latitude || OFFICE_LAT;
      const lng = job.lng || job.longitude || OFFICE_LNG;
      const dist = haversine(currentLat, currentLng, lat, lng);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestIdx = i;
      }
    }

    const nearest = remaining.splice(nearestIdx, 1)[0];
    sorted.push(nearest);
    currentLat = nearest.lat || nearest.latitude || OFFICE_LAT;
    currentLng = nearest.lng || nearest.longitude || OFFICE_LNG;
  }

  return sorted;
}

/**
 * Haversine distance in miles.
 */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 3959; // Earth radius in miles
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * 8:00 AM — Follow up on stale QUOTED jobs (>2 hours, max 2 follow-ups).
 */
async function quoteFollowUp() {
  if (db._isMock) return;

  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const snap = await db.collection('jobs')
    .where('status', '==', 'QUOTE_SENT')
    .where('quote_sent_at', '<', twoHoursAgo)
    .get();

  let followUpCount = 0;
  for (const doc of snap.docs) {
    const job = { id: doc.id, ...doc.data() };
    const followUps = job.follow_up_count || 0;

    if (followUps >= 2) {
      // Max follow-ups reached — flag for manual review
      await db.collection('manual_review').add({
        jobId: job.id,
        customer_name: job.customer_name,
        address: job.address,
        phone: job.phone,
        reason: 'no_response_after_followups',
        created_at: new Date().toISOString(),
      });
      await db.collection('jobs').doc(job.id).update({ status: 'MANUAL_REVIEW' });
      continue;
    }

    // Re-send quote
    if (job.phone) {
      const fname = (job.customer_name || '').split(' ')[0] || 'there';
      await sendSMS(job.phone, `Hey ${fname}! Just checking in — did you get our message about the junk removal at ${job.address || 'your place'}? We quoted ${job.ai_priceRange || 'in the range we sent over'} and still have availability this week. No pressure, just let us know either way! (559) 774-4249`);
      await db.collection('jobs').doc(job.id).update({
        follow_up_count: followUps + 1,
        last_follow_up: new Date().toISOString(),
      });
      followUpCount++;
    }
  }

  await logger.success('scheduler', `Quote follow-ups: ${followUpCount} sent, ${snap.size - followUpCount} flagged`, {
    icon: '📱',
  });
}

/**
 * 12:00 PM — Calculate door-knocking leaderboard.
 */
async function calculateLeaderboard() {
  if (db._isMock) return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const doorsSnap = await db.collection('doors')
    .where('timestamp', '>=', today.toISOString())
    .get();

  const repStats = {};
  doorsSnap.docs.forEach((doc) => {
    const door = doc.data();
    const repId = door.repId || door.rep_id;
    if (!repId) return;
    if (!repStats[repId]) repStats[repId] = { doors: 0, deals: 0 };
    repStats[repId].doors++;
    if (['deal_closed', 'pending_dispatch', 'closed'].includes(door.status)) {
      repStats[repId].deals++;
    }
  });

  // Sort by doors knocked
  const leaderboard = Object.entries(repStats)
    .sort(([, a], [, b]) => b.doors - a.doors)
    .map(([repId, stats], idx) => ({
      rank: idx + 1,
      repId,
      doors: stats.doors,
      deals: stats.deals,
    }));

  await db.collection('daily_summary').doc(today.toISOString().split('T')[0]).set({
    leaderboard,
    totalDoors: doorsSnap.size,
    date: today.toISOString().split('T')[0],
    updated_at: new Date().toISOString(),
  }, { merge: true });

  await logger.success('scheduler', `Leaderboard calculated: ${leaderboard.length} reps, ${doorsSnap.size} doors today`, {
    icon: '🏆',
  });
}

/**
 * 8:00 PM — Daily financial summary.
 */
async function dailySummary() {
  if (db._isMock) return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dateStr = today.toISOString().split('T')[0];

  // Completed jobs today
  const completedSnap = await db.collection('jobs')
    .where('status', '==', 'COMPLETED')
    .get();

  const todayJobs = completedSnap.docs.filter((doc) => {
    const d = doc.data();
    return d.completed_at && d.completed_at.startsWith(dateStr);
  });

  let grossRevenue = 0;
  todayJobs.forEach((doc) => {
    grossRevenue += doc.data().actual_revenue || doc.data().estimated_revenue || 0;
  });

  // Commission owed
  const commSnap = await db.collection('commission_log')
    .where('status', '==', 'PENDING')
    .get();

  let commissionsOwed = 0;
  commSnap.docs.forEach((doc) => {
    commissionsOwed += doc.data().commission_amount || 0;
  });

  // Doors knocked today
  const doorsSnap = await db.collection('doors')
    .where('timestamp', '>=', today.toISOString())
    .get();

  // Pending dispatch
  const pendingSnap = await db.collection('jobs')
    .where('status', 'in', ['QUOTED', 'QUOTE_SENT', 'CONFIRMED', 'AWAITING_PAYMENT', 'SCHEDULED'])
    .get();

  // Get active rep names
  const liveSnap = await db.collection('live_reps')
    .where('sessionActive', '==', true)
    .get();

  const repNames = liveSnap.docs.map((doc) => doc.data().name || doc.id).join(', ') || 'None';

  // Estimate crew wages ($165/job) and net profit
  const crewWages = todayJobs.length * 165;
  const netProfit = grossRevenue - commissionsOwed - crewWages;

  // Write financials
  await db.collection('financials').doc(dateStr).set({
    date: dateStr,
    gross_revenue: grossRevenue,
    commissions_owed: commissionsOwed,
    crew_wages: crewWages,
    net_profit: netProfit,
    jobs_completed: todayJobs.length,
    doors_knocked: doorsSnap.size,
    jobs_pending: pendingSnap.size,
    updated_at: new Date().toISOString(),
  }, { merge: true });

  // Send summary SMS
  const summaryMsg = `Daily wrap ${dateStr} 📊\n${doorsSnap.size} doors knocked\n${todayJobs.length} jobs completed\n${pendingSnap.size} pending dispatch\nEst. revenue: $${grossRevenue.toFixed(0)}\nReps out today: ${repNames}\n\nGood work today 💪`;
  await sendSMS(ADMIN_PHONE, summaryMsg);

  await logger.success('scheduler', `Daily summary sent — Revenue: $${grossRevenue.toFixed(0)}, Jobs: ${todayJobs.length}`, {
    icon: '📊',
    grossRevenue,
    netProfit,
  });
}

/**
 * Every 30 min — Send ETA reminders for jobs starting soon.
 */
async function etaReminders() {
  if (db._isMock) return;

  const now = new Date();
  const thirtyMin = new Date(now.getTime() + 30 * 60 * 1000);
  const today = now.toISOString().split('T')[0];

  const snap = await db.collection('jobs')
    .where('status', '==', 'SCHEDULED')
    .where('scheduled_date', '==', today)
    .get();

  for (const doc of snap.docs) {
    const job = { id: doc.id, ...doc.data() };
    if (!job.scheduled_time || job.eta_sent) continue;

    // Parse scheduled time and check if within 30 min window
    const [hours, minutes] = (job.scheduled_time || '').split(':').map(Number);
    if (isNaN(hours)) continue;

    const jobTime = new Date(now);
    jobTime.setHours(hours, minutes || 0, 0, 0);

    if (jobTime > now && jobTime <= thirtyMin) {
      const minsOut = Math.round((jobTime - now) / 60000);
      if (job.phone) {
        const etaName = (job.customer_name || '').split(' ')[0] || '';
        await sendSMS(job.phone, `Hey${etaName ? ' ' + etaName : ''}! Your crew is on the way and should be there in about ${minsOut} minutes 🚛 They'll handle everything — no need to do anything except let them in. Text us if you need anything! (559) 774-4249`);
        await db.collection('jobs').doc(job.id).update({ eta_sent: true });
      }
    }
  }
}

/**
 * Every hour — Check health of all external services.
 */
async function hourlyHealthCheck() {
  const results = [];

  for (const svc of HEALTH_URLS) {
    try {
      const start = Date.now();
      const res = await axios.get(svc.url, { timeout: 10000 });
      const elapsed = Date.now() - start;
      results.push({ name: svc.name, status: 'healthy', code: res.status, ms: elapsed });
    } catch (err) {
      results.push({ name: svc.name, status: 'down', error: err.message });
      await sendSMS(ADMIN_PHONE, `⚠️ ALERT: ${svc.name} is DOWN! Error: ${err.message}. TrashApp Mastermind`);
    }
  }

  if (!db._isMock) {
    await db.collection('system_logs').add({
      workflow_name: 'health_check',
      status: results.every((r) => r.status === 'healthy') ? 'SUCCESS' : 'ERROR',
      message: `Health check: ${results.filter((r) => r.status === 'healthy').length}/${results.length} healthy`,
      results,
      timestamp: new Date().toISOString(),
    });
  }

  await logger.log('scheduler',
    results.every((r) => r.status === 'healthy') ? 'SUCCESS' : 'ERROR',
    `Health check: ${results.filter((r) => r.status === 'healthy').length}/${results.length} services healthy`,
    { icon: '🔧', results }
  );
}

// ═══════════════════════════════════════════════════════════════
// NIGHTLY MAINTENANCE WINDOW (2:00 AM — 4:30 AM)
// ═══════════════════════════════════════════════════════════════

/**
 * 2:00 AM — Deep health check of all services.
 */
async function deepHealthCheck() {
  await logger.success('scheduler', '🔧 Nightly maintenance window started', { icon: '🔧' });

  const checks = {};

  // Firebase read/write test
  try {
    if (!db._isMock) {
      const testRef = db.collection('system_test').doc('health_check');
      await testRef.set({ test: true, timestamp: new Date().toISOString() });
      const readBack = await testRef.get();
      if (readBack.exists) {
        await testRef.delete();
        checks.firebase = { status: 'pass', message: 'Read/write/delete cycle successful' };
      } else {
        checks.firebase = { status: 'fail', message: 'Read after write returned no data' };
      }
    } else {
      checks.firebase = { status: 'skip', message: 'Not configured' };
    }
  } catch (err) {
    checks.firebase = { status: 'fail', message: err.message };
  }

  // Twilio credential validation
  try {
    const result = await twilioService.validateCredentials();
    checks.twilio = result.valid
      ? { status: 'pass', message: `Account: ${result.friendlyName}` }
      : { status: result.reason === 'not_configured' ? 'skip' : 'fail', message: result.reason };
  } catch (err) {
    checks.twilio = { status: 'fail', message: err.message };
  }

  // Stripe credential validation
  try {
    const result = await stripeService.validateCredentials();
    checks.stripe = result.valid
      ? { status: 'pass', message: `Account: ${result.id}` }
      : { status: result.reason === 'not_configured' ? 'skip' : 'fail', message: result.reason };
  } catch (err) {
    checks.stripe = { status: 'fail', message: err.message };
  }

  // Railway Quote API
  try {
    const start = Date.now();
    const res = await axios.get('https://junk-quote-api-production.up.railway.app/health', { timeout: 15000 });
    checks.railway = { status: 'pass', message: `Response time: ${Date.now() - start}ms`, ms: Date.now() - start };
  } catch (err) {
    checks.railway = { status: 'fail', message: err.message };
  }

  // Netlify sites
  for (const svc of HEALTH_URLS.filter((s) => s.name !== 'Railway Quote API')) {
    try {
      const start = Date.now();
      const res = await axios.get(svc.url, { timeout: 3000 });
      const elapsed = Date.now() - start;
      checks[svc.name] = {
        status: res.status === 200 && elapsed < 3000 ? 'pass' : 'fail',
        message: `Status: ${res.status}, Time: ${elapsed}ms`,
        ms: elapsed,
      };
    } catch (err) {
      checks[svc.name] = { status: 'fail', message: err.message };
    }
  }

  // Write diagnostic
  if (!db._isMock) {
    await db.collection('system_health').add({
      checks,
      timestamp: new Date().toISOString(),
      all_pass: Object.values(checks).every((c) => c.status === 'pass' || c.status === 'skip'),
    });
  }

  // Alert on failures
  const failures = Object.entries(checks).filter(([, v]) => v.status === 'fail');
  if (failures.length > 0) {
    const failNames = failures.map(([k]) => k).join(', ');
    await sendSMS(ADMIN_PHONE, `⚠️ Deep health check FAILED: ${failNames}. Check system_health in Firestore. TrashApp Mastermind`);
  }

  await logger.log('scheduler',
    failures.length > 0 ? 'ERROR' : 'SUCCESS',
    `Deep health check: ${Object.values(checks).filter((c) => c.status === 'pass').length} pass, ${failures.length} fail`,
    { icon: '🔧', checks }
  );
}

/**
 * 2:30 AM — npm dependency check (detection only, no auto-install).
 */
async function dependencyCheck() {
  const { execSync } = require('child_process');
  const reportPath = path.join(__dirname, '..', 'DEPENDENCY_REPORT.md');

  try {
    let outdatedJson = '{}';
    try {
      outdatedJson = execSync('npm outdated --json 2>/dev/null', {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf-8',
        timeout: 60000,
      });
    } catch (e) {
      // npm outdated exits with code 1 when packages are outdated
      if (e.stdout) outdatedJson = e.stdout;
    }

    const outdated = JSON.parse(outdatedJson || '{}');

    let auditJson = '{}';
    try {
      auditJson = execSync('npm audit --json 2>/dev/null', {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf-8',
        timeout: 60000,
      });
    } catch (e) {
      if (e.stdout) auditJson = e.stdout;
    }

    let audit = {};
    try { audit = JSON.parse(auditJson || '{}'); } catch (_) {}

    const hasVulnerabilities = (audit.metadata?.vulnerabilities?.critical || 0) > 0 ||
      (audit.metadata?.vulnerabilities?.high || 0) > 0;

    // Write report
    const report = [
      `# Dependency Report`,
      `Generated: ${new Date().toISOString()}`,
      ``,
      `## Outdated Packages`,
      Object.keys(outdated).length === 0
        ? 'All packages are up to date.'
        : Object.entries(outdated).map(([pkg, info]) =>
            `- **${pkg}**: ${info.current} → ${info.latest} (wanted: ${info.wanted})`
          ).join('\n'),
      ``,
      `## Security Audit`,
      hasVulnerabilities
        ? `⚠️ CRITICAL/HIGH vulnerabilities found! Review npm audit output.`
        : `✓ No critical or high vulnerabilities detected.`,
      ``,
      `Vulnerabilities: ${JSON.stringify(audit.metadata?.vulnerabilities || 'N/A')}`,
      ``,
      `---`,
      `*Detection only — no packages were auto-installed or modified.*`,
    ].join('\n');

    fs.writeFileSync(reportPath, report);

    if (hasVulnerabilities) {
      await sendSMS(ADMIN_PHONE, `⚠️ npm audit: Critical security vulnerabilities found in trashapp-mastermind dependencies. Review DEPENDENCY_REPORT.md. No auto-install performed.`);
    }

    await logger.log('scheduler',
      hasVulnerabilities ? 'ERROR' : 'SUCCESS',
      `Dependency check: ${Object.keys(outdated).length} outdated, vulnerabilities: ${hasVulnerabilities}`,
      { icon: '🔧' }
    );
  } catch (err) {
    await logger.error('scheduler', `Dependency check failed: ${err.message}`, { error: err.message });
  }
}

/**
 * 3:00 AM — Error log analysis.
 */
async function errorLogAnalysis() {
  if (db._isMock) return;

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // Client errors
  const clientSnap = await db.collection('client_errors')
    .where('timestamp', '>=', yesterday)
    .get();

  // System errors
  const systemSnap = await db.collection('system_logs')
    .where('status', '==', 'ERROR')
    .where('timestamp', '>=', yesterday)
    .get();

  // Group errors by type
  const errorGroups = {};
  [...clientSnap.docs, ...systemSnap.docs].forEach((doc) => {
    const data = doc.data();
    const key = data.message || data.error || 'Unknown';
    const shortKey = key.substring(0, 100);
    if (!errorGroups[shortKey]) errorGroups[shortKey] = { count: 0, samples: [] };
    errorGroups[shortKey].count++;
    if (errorGroups[shortKey].samples.length < 3) {
      errorGroups[shortKey].samples.push({
        timestamp: data.timestamp,
        stack: data.stack || data.error || '',
      });
    }
  });

  // Find recurring (3+ occurrences)
  const recurring = Object.entries(errorGroups).filter(([, v]) => v.count >= 3);

  const analysis = {
    total_errors: clientSnap.size + systemSnap.size,
    client_errors: clientSnap.size,
    system_errors: systemSnap.size,
    recurring_errors: recurring.map(([msg, data]) => ({
      message: msg,
      count: data.count,
      samples: data.samples,
    })),
    date: new Date().toISOString().split('T')[0],
    analyzed_at: new Date().toISOString(),
  };

  await db.collection('daily_error_reports').add(analysis);

  if (recurring.length > 0) {
    const summary = recurring.map(([msg, d]) => `${d.count}x: ${msg.substring(0, 50)}`).join('; ');
    await sendSMS(ADMIN_PHONE, `⚠️ Recurring errors (24h): ${summary}. Total: ${analysis.total_errors}. TrashApp Mastermind`);
  }

  await logger.log('scheduler',
    recurring.length > 0 ? 'ERROR' : 'SUCCESS',
    `Error analysis: ${analysis.total_errors} total, ${recurring.length} recurring patterns`,
    { icon: '🔧' }
  );

  // Gas price freshness check
  try {
    if (!db._isMock) {
      const gasDoc = await db.collection('system_config').doc('gas_price').get();
      const fetchedAt = gasDoc.exists ? gasDoc.data()?.fetchedAt?.toDate?.() : null;
      const daysOld = fetchedAt ? (Date.now() - fetchedAt.getTime()) / 86400000 : 999;
      if (daysOld > 8) {
        await logger.log('maintenance', 'WARN', `Gas price is ${Math.round(daysOld)} days old — trying refresh`);
        await updateGasPrice(db, logger);
      } else {
        await logger.log('maintenance', 'SUCCESS', `Gas price ok: $${gasDoc.data()?.value}/gal (${Math.round(daysOld*10)/10}d old)`);
      }
    }
  } catch(e) { await logger.log('maintenance', 'WARN', 'Gas price freshness check failed: ' + e.message); }
}

/**
 * 3:15 AM — Platform bug scan.
 * Fetches all live sites and runs automated code/data/API checks.
 */
async function nightlyBugScan() {
  const bugScan = await runBugScan();

  await logger.log('scheduler', bugScan.allClear ? 'SUCCESS' : 'ERROR',
    `Bug scan complete: ${bugScan.bugsFound.length} issues found across ${bugScan.sitesChecked} sites (${bugScan.scanDurationMs}ms)`,
    { icon: '🔍', bugsFound: bugScan.bugsFound.length, scanDurationMs: bugScan.scanDurationMs }
  );

  if (!bugScan.allClear) {
    // Alert immediately on high severity bugs
    const highSeverity = bugScan.bugsFound.filter(b => b.severity === 'high');
    if (highSeverity.length > 0) {
      const bugList = highSeverity.slice(0, 3).map(b => `• ${b.description}`).join('\n');
      await sendSMS(ADMIN_PHONE,
        `🚨 ${highSeverity.length} high severity bug(s) detected:\n${bugList}\n\nFix: ${highSeverity[0].suggestedFix}\n\nFull report: admin.trashappjunkremoval.com`
      );
    }

    // Log medium/low for the daily summary
    const medLow = bugScan.bugsFound.filter(b => b.severity !== 'high');
    if (medLow.length > 0) {
      await logger.partial('scheduler', `Bug scan: ${medLow.length} non-critical issue(s) — review in dashboard`, {
        icon: '⚠️',
        bugs: medLow.map(b => ({ severity: b.severity, site: b.site, description: b.description })),
      });
    }
  }
}

/**
 * 3:30 AM — Data integrity check.
 */
async function dataIntegrityCheck() {
  if (db._isMock) return;

  const anomalies = [];

  // Check AWAITING_PAYMENT jobs have stripePaymentLinkId
  const awaitingSnap = await db.collection('jobs').where('status', '==', 'AWAITING_PAYMENT').get();
  awaitingSnap.docs.forEach((doc) => {
    if (!doc.data().stripePaymentLinkId) {
      anomalies.push(`Job ${doc.id}: AWAITING_PAYMENT but no stripePaymentLinkId`);
    }
  });

  // Check SCHEDULED jobs have assigned_crew_id
  const scheduledSnap = await db.collection('jobs').where('status', '==', 'SCHEDULED').get();
  scheduledSnap.docs.forEach((doc) => {
    if (!doc.data().assigned_crew_id) {
      anomalies.push(`Job ${doc.id}: SCHEDULED but no assigned_crew_id`);
    }
  });

  // Check commission_log entries link to valid jobs
  const commSnap = await db.collection('commission_log').get();
  for (const doc of commSnap.docs) {
    const jobId = doc.data().job_id;
    if (jobId) {
      const jobDoc = await db.collection('jobs').doc(jobId).get();
      if (!jobDoc.exists) {
        anomalies.push(`Commission ${doc.id}: references non-existent job ${jobId}`);
      }
    }
  }

  // Check for stuck jobs (same status >48 hours)
  const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const activeStatuses = ['QUOTED', 'QUOTE_SENT', 'CONFIRMED', 'AWAITING_PAYMENT', 'SCHEDULED', 'IN_PROGRESS'];
  for (const status of activeStatuses) {
    const stuckSnap = await db.collection('jobs')
      .where('status', '==', status)
      .get();
    stuckSnap.docs.forEach((doc) => {
      const data = doc.data();
      const lastUpdate = data.updated_at || data.created_at;
      if (lastUpdate && lastUpdate < twoDaysAgo) {
        anomalies.push(`Job ${doc.id}: Stuck in ${status} since ${lastUpdate}`);
      }
    });
  }

  if (anomalies.length > 0) {
    await sendSMS(ADMIN_PHONE, `⚠️ Data integrity: ${anomalies.length} anomalies found. Check system_logs. TrashApp Mastermind`);
  }

  if (!db._isMock) {
    await db.collection('system_logs').add({
      workflow_name: 'data_integrity',
      status: anomalies.length > 0 ? 'ERROR' : 'SUCCESS',
      message: `Data integrity check: ${anomalies.length} anomalies`,
      anomalies,
      timestamp: new Date().toISOString(),
    });
  }

  await logger.log('scheduler',
    anomalies.length > 0 ? 'ERROR' : 'SUCCESS',
    `Data integrity: ${anomalies.length} anomalies found`,
    { icon: '🔧', anomalies }
  );
}

/**
 * 4:00 AM — Performance report.
 */
async function performanceReport() {
  if (db._isMock) return;

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // Get health check response times from last 24h
  const healthSnap = await db.collection('system_logs')
    .where('workflow_name', '==', 'health_check')
    .where('timestamp', '>=', yesterday)
    .get();

  let railwayTimes = [];
  healthSnap.docs.forEach((doc) => {
    const results = doc.data().results || [];
    results.forEach((r) => {
      if (r.name === 'Railway Quote API' && r.ms) railwayTimes.push(r.ms);
    });
  });

  const avgRailway = railwayTimes.length > 0
    ? Math.round(railwayTimes.reduce((a, b) => a + b, 0) / railwayTimes.length)
    : null;

  // SMS count estimate
  const smsSnap = await db.collection('system_logs')
    .where('workflow_name', '==', 'twilio')
    .where('timestamp', '>=', yesterday)
    .get();

  const smsCost = smsSnap.size * 0.0075;

  const report = {
    date: new Date().toISOString().split('T')[0],
    avg_railway_response_ms: avgRailway,
    total_sms_sent: smsSnap.size,
    estimated_sms_cost: smsCost,
    health_checks_run: healthSnap.size,
    generated_at: new Date().toISOString(),
  };

  await db.collection('performance_reports').add(report);

  if (avgRailway && avgRailway > 5000) {
    await sendSMS(ADMIN_PHONE, `⚠️ Railway API avg response: ${avgRailway}ms (target: <5000ms). Performance degraded. TrashApp Mastermind`);
  }

  await logger.success('scheduler', `Performance report: Railway avg ${avgRailway || 'N/A'}ms, ${smsSnap.size} SMS ($${smsCost.toFixed(2)})`, {
    icon: '📊',
  });
}

/**
 * 4:15 AM — GitHub backup check.
 */
async function githubBackupCheck() {
  // This checks local git state since we don't have GitHub token
  const { execSync } = require('child_process');

  try {
    const lastCommit = execSync('git log -1 --format="%ci" 2>/dev/null', {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();

    const lastCommitDate = new Date(lastCommit);
    const daysSinceCommit = (Date.now() - lastCommitDate.getTime()) / (1000 * 60 * 60 * 24);

    if (daysSinceCommit > 7) {
      await logger.partial('scheduler', `GitHub: Last commit was ${Math.round(daysSinceCommit)} days ago — consider pushing updates`, {
        icon: '⚠️',
      });
    }

    // Check CONTEXT.md freshness
    const contextPath = path.join(__dirname, '..', 'CONTEXT.md');
    if (fs.existsSync(contextPath)) {
      const stats = fs.statSync(contextPath);
      const hoursSinceUpdate = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);
      if (hoursSinceUpdate > 24) {
        await logger.partial('scheduler', 'CONTEXT.md not updated in 24h — auto-updating', { icon: '🔧' });
        updateContextFile();
      }
    }
  } catch (err) {
    await logger.partial('scheduler', `GitHub check: ${err.message}`, { icon: '🔧' });
  }
}

/**
 * Auto-update CONTEXT.md with current system status.
 */
function updateContextFile() {
  const contextPath = path.join(__dirname, '..', 'CONTEXT.md');
  try {
    const content = fs.readFileSync(contextPath, 'utf-8');
    const updated = content.replace(
      /Last update:.*$/m,
      `Last update: ${new Date().toISOString()}`
    );
    fs.writeFileSync(contextPath, updated);
  } catch (_) {}
}

/**
 * 4:30 AM — Maintenance complete.
 */
async function maintenanceComplete() {
  await logger.success('scheduler', '🔧 Nightly maintenance window complete — resuming normal operations', {
    icon: '🔧',
    type: 'maintenance_complete',
  });
}

// ═══════════════════════════════════════════════════════════════
// SLOT BOOKING FUNCTIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Sunday 11:00 PM — Generate job slots for the next 7 days.
 */
async function generateWeekSlots() {
  if (db._isMock) return;

  try {
    const scheduleConfig = await db.collection('system_config').doc('schedule').get();
    const config = scheduleConfig.exists ? scheduleConfig.data() : getDefaultScheduleConfig();

    let created = 0;
    for (let dayOffset = 1; dayOffset <= 7; dayOffset++) {
      const date = new Date();
      date.setDate(date.getDate() + dayOffset);
      const dayName = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][date.getDay()];
      const dateStr = date.toISOString().split('T')[0];

      if (!config.operatingDays[dayName]) continue;

      const dateOverride = config.dateOverrides?.[dateStr];
      if (dateOverride?.closed) continue;

      const hours = dateOverride || config.dayOverrides?.[dayName] || config.defaultHours;
      const startMin = timeToMinutes(hours.start);
      const endMin = timeToMinutes(hours.end);
      const slotDuration = config.slotDuration || 120;
      const buffer = config.slotBuffer || 0;

      let current = startMin;
      while (current + slotDuration <= endMin) {
        const slotStart = minutesToTime(current);
        const slotEnd = minutesToTime(current + slotDuration);
        const slotId = `${dateStr}_${slotStart.replace(':', '-')}-${slotEnd.replace(':', '-')}`;
        const label = `${formatTime12(slotStart)}–${formatTime12(slotEnd)}`;

        const existing = await db.collection('job_slots').doc(slotId).get();
        if (!existing.exists) {
          await db.collection('job_slots').doc(slotId).set({
            slotId,
            date: dateStr,
            window: `${slotStart}-${slotEnd}`,
            label,
            status: 'available',
            maxJobs: config.maxJobsPerSlot || 1,
            heldBy: null,
            heldAt: null,
            jobId: null,
            bookedAt: null,
            blockedReason: null,
          });
          created++;
        }
        current += slotDuration + buffer;
      }
    }

    await logger.success('scheduler', `Slot generation: ${created} new slots created for next 7 days`, {
      icon: '📅',
      slotsCreated: created,
    });
  } catch (err) {
    await logger.error('scheduler', `Slot generation failed: ${err.message}`, { error: err.message });
  }
}

/**
 * Every 5 minutes — Release slots with expired holds (>5 minutes old).
 */
async function releaseExpiredHolds() {
  if (db._isMock) return;

  try {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const snap = await db.collection('job_slots')
      .where('status', '==', 'held')
      .where('heldAt', '<', fiveMinutesAgo)
      .get();

    if (snap.empty) return;

    let released = 0;
    for (const doc of snap.docs) {
      await doc.ref.update({
        status: 'available',
        heldBy: null,
        heldAt: null,
      });
      released++;
    }

    if (released > 0) {
      await logger.log('scheduler', 'SUCCESS', `Hold expiry: ${released} holds released`, {
        icon: '⏰',
        releasedCount: released,
      });
    }
  } catch (err) {
    await logger.error('scheduler', `Hold expiry check failed: ${err.message}`, { error: err.message });
  }
}

/**
 * Get default schedule configuration.
 */
function getDefaultScheduleConfig() {
  return {
    operatingDays: { monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: true, sunday: false },
    defaultHours: { start: '07:00', end: '17:00' },
    dayOverrides: { saturday: { start: '08:00', end: '14:00' } },
    slotDuration: 120,
    slotBuffer: 0,
    maxJobsPerSlot: 1,
    minBookingNotice: 60,
    maxBookingDays: 14,
    dateOverrides: {},
  };
}

/**
 * Convert time string HH:MM to minutes since midnight.
 */
function timeToMinutes(str) {
  const [h, m] = str.split(':').map(Number);
  return h * 60 + (m || 0);
}

/**
 * Convert minutes since midnight to HH:MM string.
 */
function minutesToTime(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Format time HH:MM to 12-hour format with AM/PM.
 */
function formatTime12(time) {
  const [h, m] = time.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const displayH = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return `${displayH}:${String(m).padStart(2, '0')} ${ampm}`;
}

/**
 * Stop all cron jobs.
 */
function stopScheduler() {
  scheduledJobs.forEach((job) => job.stop());
  scheduledJobs = [];
  console.log('[Scheduler] All cron jobs stopped');
}

module.exports = { startScheduler, stopScheduler };
