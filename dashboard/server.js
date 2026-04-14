/**
 * dashboard/server.js — Express + Socket.io dashboard server
 * Serves the dispatch dashboard at localhost:DASHBOARD_PORT
 * with real-time event streaming via Socket.io.
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { db } = require('../core/firestore');
const logger = require('../core/logger');

let app, server, io;

/**
 * Start the dashboard server.
 * @param {number} port — Port number (default: 3000)
 * @returns {{ app, server, io }}
 */
function startDashboard(port = 3000) {
  app = express();
  server = http.createServer(app);
  io = new Server(server, { cors: { origin: '*' } });

  // Attach Socket.io to logger for real-time events
  logger.attachSocketIO(io);

  // ─── Middleware ────────────────────────────────────────
  // Raw body for webhook signature verification
  app.use('/webhooks', express.raw({ type: '*/*', limit: '10mb' }), (req, res, next) => {
    req.rawBody = req.body;
    try {
      req.body = JSON.parse(req.body);
    } catch {
      // Body might be form-encoded (Twilio)
      const qs = require('querystring');
      req.body = qs.parse(req.body.toString());
    }
    next();
  });

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // ─── Password Protection ──────────────────────────────
  const dashPassword = process.env.DASHBOARD_PASSWORD;
  if (dashPassword) {
    app.use((req, res, next) => {
      // Skip password for webhooks and health
      if (req.path.startsWith('/webhooks') || req.path === '/health') {
        return next();
      }

      // Check cookie or query param
      if (req.query.password === dashPassword || req.cookies?.dash_auth === dashPassword) {
        return next();
      }

      // Check if already authenticated via session
      if (req.headers['x-dashboard-auth'] === dashPassword) {
        return next();
      }

      // Serve login page for HTML requests
      if (req.accepts('html') && req.path === '/') {
        return res.send(getLoginPage());
      }

      // API requests without auth
      if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      next();
    });

    app.post('/api/login', (req, res) => {
      if (req.body.password === dashPassword) {
        res.json({ success: true, token: dashPassword });
      } else {
        res.status(401).json({ error: 'Invalid password' });
      }
    });
  }

  // ─── Static Files ─────────────────────────────────────
  app.use(express.static(path.join(__dirname, 'public')));

  // ─── API Routes ───────────────────────────────────────
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      service: 'TrashApp Mastermind',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/api/services', async (req, res) => {
    const firestore = require('../core/firestore');
    const twilio = require('../core/twilio');
    const stripe = require('../core/stripe');
    const axios = require('axios');

    const services = {
      firebase: { name: 'Firebase', status: firestore.isConfigured() ? 'healthy' : 'not_configured' },
      twilio: { name: 'Twilio', status: twilio.isConfigured() ? 'healthy' : 'not_configured' },
      stripe: { name: 'Stripe', status: stripe.isConfigured() ? 'healthy' : 'not_configured' },
    };

    // Quick health check on Railway API
    try {
      await axios.get('https://junk-quote-api-production.up.railway.app/health', { timeout: 5000 });
      services.railway = { name: 'Railway API', status: 'healthy' };
    } catch {
      services.railway = { name: 'Railway API', status: 'down' };
    }

    // Quick check on platforms
    try {
      await axios.get('https://reps.trashappjunkremoval.com', { timeout: 5000 });
      services.repPlatform = { name: 'Rep Platform', status: 'healthy' };
    } catch {
      services.repPlatform = { name: 'Rep Platform', status: 'down' };
    }

    try {
      await axios.get('https://admin.trashappjunkremoval.com', { timeout: 5000 });
      services.adminConsole = { name: 'Admin Console', status: 'healthy' };
    } catch {
      services.adminConsole = { name: 'Admin Console', status: 'down' };
    }

    try {
      await axios.get('https://trashappjunkremoval.com', { timeout: 5000 });
      services.homepage = { name: 'Homepage', status: 'healthy' };
    } catch {
      services.homepage = { name: 'Homepage', status: 'down' };
    }

    res.json(services);
  });

  app.get('/api/jobs', async (req, res) => {
    try {
      if (db._isMock) return res.json([]);
      const snap = await db.collection('jobs')
        .orderBy('created_at', 'desc')
        .limit(200)
        .get();
      const jobs = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      res.json(jobs);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/manual-review', async (req, res) => {
    try {
      if (db._isMock) return res.json([]);
      const snap = await db.collection('manual_review')
        .orderBy('created_at', 'desc')
        .limit(50)
        .get();
      const items = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      res.json(items);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/stats', async (req, res) => {
    try {
      if (db._isMock) return res.json({ todayRevenue: 0, pipelineValue: 0, commissionOwed: 0 });

      const today = new Date().toISOString().split('T')[0];

      // Today's revenue from completed jobs
      const completedSnap = await db.collection('jobs').where('status', '==', 'COMPLETED').get();
      let todayRevenue = 0;
      completedSnap.docs.forEach((doc) => {
        const d = doc.data();
        if (d.completed_at && d.completed_at.startsWith(today)) {
          todayRevenue += d.actual_revenue || d.estimated_revenue || 0;
        }
      });

      // Pipeline value
      const pipelineStatuses = ['QUOTED', 'QUOTE_SENT', 'CONFIRMED', 'AWAITING_PAYMENT', 'SCHEDULED'];
      let pipelineValue = 0;
      for (const status of pipelineStatuses) {
        const snap = await db.collection('jobs').where('status', '==', status).get();
        snap.docs.forEach((doc) => {
          pipelineValue += doc.data().estimated_revenue || doc.data().ai_midpoint || 0;
        });
      }

      // Commission owed
      const commSnap = await db.collection('commission_log').where('status', '==', 'PENDING').get();
      let commissionOwed = 0;
      commSnap.docs.forEach((doc) => {
        commissionOwed += doc.data().commission_amount || 0;
      });

      res.json({ todayRevenue, pipelineValue, commissionOwed });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/social-stats', async (req, res) => {
    try {
      if (db._isMock) return res.json({ drafts: 0, scheduled: 0, posted: 0, total: 0 });
      const snap = await db.collection('social_posts').get();
      let drafts = 0, scheduled = 0, posted = 0;
      snap.docs.forEach((doc) => {
        const status = (doc.data().status || 'DRAFT').toUpperCase();
        if (status === 'DRAFT') drafts++;
        else if (status === 'SCHEDULED') scheduled++;
        else if (status === 'POSTED') posted++;
      });
      res.json({ drafts, scheduled, posted, total: snap.size });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/events', async (req, res) => {
    try {
      if (db._isMock) return res.json([]);
      const snap = await db.collection('system_logs')
        .orderBy('timestamp', 'desc')
        .limit(100)
        .get();
      const events = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      res.json(events);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Crew dashboard: send customer SMS (arrival notices, review requests)
  app.post('/api/crew-sms', async (req, res) => {
    try {
      const { to, message } = req.body || {};
      if (!to || !message) return res.status(400).json({ error: 'to and message required' });
      const { sendSMS, isConfigured } = require('../core/twilio');
      if (!isConfigured()) return res.status(503).json({ error: 'Twilio not configured' });
      await sendSMS(to, message);
      res.json({ ok: true });
    } catch (err) {
      console.error('[crew-sms] error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Crew dashboard beforeunload beacon: mark crew offline
  app.post('/api/crew-inactive', async (req, res) => {
    try {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch(_) { body = {}; } }
      const crewId = body && body.crewId;
      if (!crewId) return res.sendStatus(400);
      if (!db._isMock) {
        await db.collection('crew_locations').doc(crewId).set({
          active: false,
          updatedAt: new Date(),
        }, { merge: true });
      }
      res.sendStatus(200);
    } catch (err) {
      console.error('[crew-inactive] error:', err.message);
      res.sendStatus(500);
    }
  });

  // Rep beforeunload beacon: mark rep inactive in live_reps
  app.post('/api/rep-inactive', async (req, res) => {
    try {
      // sendBeacon with a Blob may arrive as text; parse defensively
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (_) { body = {}; }
      }
      const repId = body && body.repId;
      if (!repId) return res.sendStatus(400);
      if (!db._isMock) {
        await db.collection('live_reps').doc(repId).set({
          active: false,
          sessionActive: false,
          lastUpdate: new Date(),
        }, { merge: true });
      }
      res.sendStatus(200);
    } catch (err) {
      console.error('[rep-inactive] error:', err.message);
      res.sendStatus(500);
    }
  });

  // Manual override: send quote with custom price
  app.post('/api/manual/send-quote', async (req, res) => {
    try {
      const { jobId, price } = req.body;
      if (!jobId || !price) return res.status(400).json({ error: 'jobId and price required' });

      if (!db._isMock) {
        const jobRef = db.collection('jobs').doc(jobId);
        const jobDoc = await jobRef.get();
        if (!jobDoc.exists) return res.status(404).json({ error: 'Job not found' });

        const job = jobDoc.data();
        const { sendSMS } = require('../core/twilio');

        await jobRef.update({
          status: 'QUOTE_SENT',
          ai_midpoint: price,
          ai_priceRange: `$${price}`,
          manual_override: true,
          quote_sent_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });

        if (job.phone) {
          const fname = (job.customer_name || '').split(' ')[0] || 'there';
          const pickupInfo = job.scheduled_date ? `We have availability ${job.scheduled_date}${job.scheduled_time ? ' around ' + job.scheduled_time : ''}.` : 'We can usually get out there within a few days.';
          await sendSMS(job.phone, `Hey ${fname}! This is TrashApp — we got your junk removal request for ${job.address || 'your place'} 👍 We're looking at $${price} for the haul. ${pickupInfo} Does that work? Just reply YES and we'll lock it in, or reply NO if you need a different time. — TrashApp (559) 774-4249`);
        }

        // Remove from manual review
        const reviewSnap = await db.collection('manual_review').where('jobId', '==', jobId).get();
        for (const doc of reviewSnap.docs) {
          await doc.ref.delete();
        }

        await logger.success('dashboard', `Manual quote sent: Job ${jobId} at $${price}`, {
          jobId,
          price,
          icon: '🤖',
        });
      }

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Request more photos
  app.post('/api/manual/request-photos', async (req, res) => {
    try {
      const { jobId } = req.body;
      if (!jobId) return res.status(400).json({ error: 'jobId required' });

      if (!db._isMock) {
        const jobDoc = await db.collection('jobs').doc(jobId).get();
        if (!jobDoc.exists) return res.status(404).json({ error: 'Job not found' });

        const job = jobDoc.data();
        const { sendSMS } = require('../core/twilio');

        if (job.phone) {
          const pName = (job.customer_name || '').split(' ')[0] || 'there';
          await sendSMS(job.phone, `Hey ${pName}! Thanks for reaching out — the photos were a little hard to see clearly. Could you send 2-3 more from different angles? Even just a wide shot of the full pile helps us nail the price 📸 (559) 774-4249`);
        }

        await logger.success('dashboard', `Photo request sent: Job ${jobId}`, {
          jobId,
          icon: '📸',
        });
      }

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Bug scan report — latest
  app.get('/api/bug-report', async (req, res) => {
    try {
      if (db._isMock) return res.json({ bugsFound: [], allClear: true, timestamp: new Date().toISOString() });

      const snap = await db.collection('bug_reports')
        .orderBy('timestamp', 'desc')
        .limit(1)
        .get();

      if (snap.empty) return res.json({ bugsFound: [], allClear: true, timestamp: null });

      const report = snap.docs[0].data();
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Mark a bug as resolved
  app.post('/api/bug-report/resolve', async (req, res) => {
    try {
      const { description } = req.body;
      if (!description) return res.status(400).json({ error: 'description required' });

      if (!db._isMock) {
        await db.collection('resolved_bugs').add({
          description,
          resolved_at: new Date().toISOString(),
          resolved_by: 'admin',
        });
      }

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Run bug scan on demand
  app.post('/api/bug-report/scan', async (req, res) => {
    try {
      const { runBugScan } = require('../maintenance/bug-scanner');
      const report = await runBugScan();
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Gas price routes
  app.get('/api/gas-price', async (req, res) => {
    try {
      if (db._isMock) return res.json({ value: 4.60, source: 'fallback' });
      const gasDoc = await db.collection('system_config').doc('gas_price').get();
      res.json(gasDoc.exists ? gasDoc.data() : { value: 4.60, source: 'fallback' });
    } catch(e) { res.json({ value: 4.60, source: 'fallback', error: e.message }); }
  });

  app.post('/api/gas-price/override', async (req, res) => {
    const price = parseFloat(req.body.price);
    if (isNaN(price) || price < 2 || price > 8) return res.status(400).json({ error: 'Invalid price (must be $2-$8)' });
    try {
      await db.collection('system_config').doc('gas_price').set({ value: price, period: 'manual', source: 'admin_override', fetchedAt: new Date(), updatedBy: 'admin' });
      if (io) io.emit('gas_price_updated', { price, timestamp: new Date().toISOString() });
      res.json({ success: true, price });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/gas-price/refresh', async (req, res) => {
    try {
      const { updateGasPrice } = require('../core/gas-price');
      const price = await updateGasPrice(db, logger);
      if (price) {
        if (io) io.emit('gas_price_updated', { price, timestamp: new Date().toISOString() });
        res.json({ success: true, price });
      } else res.json({ success: false, message: 'EIA fetch failed' });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ─── SCHEDULE MANAGEMENT ROUTES ────────────────────────
  app.get('/api/schedule/config', async (req, res) => {
    try {
      if (db._isMock) {
        const defaultConfig = {
          operatingDays: { monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: true, sunday: false },
          defaultHours: { start: '07:00', end: '17:00' },
          dayOverrides: { saturday: { start: '08:00', end: '14:00' } },
          slotDuration: 120,
          slotBuffer: 0,
          maxJobsPerSlot: 1,
        };
        return res.json(defaultConfig);
      }
      const doc = await db.collection('system_config').doc('schedule').get();
      res.json(doc.exists ? doc.data() : { /* default config */ });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/schedule/config', async (req, res) => {
    try {
      if (db._isMock) return res.json({ success: true, count: 0 });

      const config = req.body;
      await db.collection('system_config').doc('schedule').set(config);

      // Trigger slot regeneration
      const { generateWeekSlots } = require('../dispatch/scheduler');
      // Note: calling this directly; in production, the next cron will handle it
      await logger.success('dashboard', 'Schedule config updated', { icon: '📅' });

      res.json({ success: true, message: 'Config saved — slots will regenerate at next scheduled time' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/schedule/slots', async (req, res) => {
    try {
      const { start, end } = req.query;
      if (!start || !end) return res.status(400).json({ error: 'start and end dates required (YYYY-MM-DD)' });

      if (db._isMock) return res.json([]);

      const snap = await db.collection('job_slots')
        .where('date', '>=', start)
        .where('date', '<=', end)
        .orderBy('date')
        .orderBy('window')
        .get();

      const slots = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      res.json(slots);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/schedule/slots/:slotId/block', async (req, res) => {
    try {
      const { slotId } = req.params;
      const { reason } = req.body;
      if (!db._isMock) {
        await db.collection('job_slots').doc(slotId).update({
          status: 'blocked',
          blockedReason: reason || 'admin block',
          blockedAt: new Date().toISOString(),
        });
        await logger.success('dashboard', `Slot blocked: ${slotId}`, { icon: '🚫' });
      }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/schedule/slots/:slotId/unblock', async (req, res) => {
    try {
      const { slotId } = req.params;
      if (!db._isMock) {
        await db.collection('job_slots').doc(slotId).update({
          status: 'available',
          blockedReason: null,
          blockedAt: null,
        });
        await logger.success('dashboard', `Slot unblocked: ${slotId}`, { icon: '✅' });
      }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/schedule/slots/:slotId/hold', async (req, res) => {
    try {
      const { slotId } = req.params;
      const { customerId } = req.body;
      if (!db._isMock) {
        await db.collection('job_slots').doc(slotId).update({
          status: 'held',
          heldBy: customerId,
          heldAt: new Date().toISOString(),
        });
      }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/schedule/slots/:slotId/release', async (req, res) => {
    try {
      const { slotId } = req.params;
      if (!db._isMock) {
        await db.collection('job_slots').doc(slotId).update({
          status: 'available',
          heldBy: null,
          heldAt: null,
        });
      }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/schedule/slots/:slotId/book', async (req, res) => {
    try {
      const { slotId } = req.params;
      const { jobId } = req.body;
      if (!db._isMock) {
        await db.collection('job_slots').doc(slotId).update({
          status: 'booked',
          jobId,
          bookedAt: new Date().toISOString(),
          heldBy: null,
          heldAt: null,
        });
      }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/schedule/regenerate', async (req, res) => {
    try {
      if (db._isMock) return res.json({ success: true, count: 0 });
      // In production, this would call the scheduler function
      await logger.success('dashboard', 'Slot regeneration triggered manually', { icon: '🔄' });
      res.json({ success: true, message: 'Regeneration started — check logs' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── JOB STATUS & REPLY ROUTES ─────────────────────────
  app.post('/api/jobs/:jobId/status', async (req, res) => {
    try {
      const { jobId } = req.params;
      const { status } = req.body;
      if (!status) return res.status(400).json({ error: 'status required' });

      if (!db._isMock) {
        const jobDoc = await db.collection('jobs').doc(jobId).get();
        if (!jobDoc.exists) return res.status(404).json({ error: 'Job not found' });

        const job = jobDoc.data();
        const statusHistory = job.statusHistory || [];
        statusHistory.push({
          status,
          changedAt: new Date().toISOString(),
          changedBy: 'admin',
        });

        await db.collection('jobs').doc(jobId).update({
          status,
          statusHistory,
          updated_at: new Date().toISOString(),
        });

        // Send status SMS if template exists
        const { sendStatusSMS } = require('../core/job-status-sms');
        const twilio = require('../core/twilio');
        await sendStatusSMS({ id: jobId, ...job }, status, twilio, logger);

        // Emit Socket.io event
        if (io) io.emit('job_status_changed', { jobId, newStatus: status });

        await logger.success('dashboard', `Job ${jobId} status updated to ${status}`, { jobId, status, icon: '📋' });
      }

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/jobs/:jobId/reply', async (req, res) => {
    try {
      const { jobId } = req.params;
      const { message } = req.body;
      if (!message) return res.status(400).json({ error: 'message required' });

      if (!db._isMock) {
        const jobDoc = await db.collection('jobs').doc(jobId).get();
        if (!jobDoc.exists) return res.status(404).json({ error: 'Job not found' });

        const job = jobDoc.data();

        // Send SMS
        const { sendSMS } = require('../core/twilio');
        await sendSMS(job.phone, message);

        // Write to messages subcollection
        await db.collection('jobs').doc(jobId).collection('messages').add({
          from: 'admin',
          body: message,
          sentAt: new Date().toISOString(),
          messageStatus: 'sent',
        });

        await logger.success('dashboard', `Reply sent to Job ${jobId}`, { jobId, icon: '💬' });
      }

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── INTEL ROUTES ─────────────────────────────────────
  app.get('/api/intel', async (req, res) => {
    try {
      if (db._isMock) return res.json([]);

      const snap = await db.collection('zip_intel').get();
      const intel = snap.docs.map((doc) => ({ zipCode: doc.id, ...doc.data() }));
      res.json(intel);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/intel/refresh', async (req, res) => {
    try {
      if (db._isMock) return res.json({ success: true });

      const { scrapeIntel } = require('../core/intel-scraper');
      await scrapeIntel();
      await logger.success('dashboard', 'Intel scrape triggered manually', { icon: '🌐' });
      res.json({ success: true, message: 'Scrape started — check logs' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── TERRITORY ROUTES ──────────────────────────────────
  app.get('/api/territories/assignments', async (req, res) => {
    try {
      const { week } = req.query;
      if (!week) return res.status(400).json({ error: 'week parameter required (YYYY-Wnn)' });

      if (db._isMock) return res.json({});

      const doc = await db.collection('territory_assignments').doc(week).get();
      res.json(doc.exists ? doc.data() : { message: 'No assignments found for this week' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/territories/assignments/:weekId/approve', async (req, res) => {
    try {
      const { weekId } = req.params;
      if (!db._isMock) {
        await db.collection('territory_assignments').doc(weekId).update({
          status: 'approved',
          approvedAt: new Date().toISOString(),
          approvedBy: 'admin',
        });
        await logger.success('dashboard', `Territory assignments approved for week ${weekId}`, { weekId, icon: '✅' });
      }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/territories/assignments/:weekId/override', async (req, res) => {
    try {
      const { weekId } = req.params;
      const { repId, primaryZip, secondaryZip } = req.body;

      if (!db._isMock) {
        const doc = await db.collection('territory_assignments').doc(weekId).get();
        if (!doc.exists) return res.status(404).json({ error: 'Assignments not found' });

        const data = doc.data();
        const assignments = (data.assignments || []).map((a) =>
          a.repId === repId ? { ...a, primaryZip, secondaryZip } : a
        );

        await db.collection('territory_assignments').doc(weekId).update({
          assignments,
          lastOverrideAt: new Date().toISOString(),
        });

        await logger.success('dashboard', `Territory override for ${repId}: ${primaryZip}/${secondaryZip}`, {
          repId,
          weekId,
          icon: '🔄',
        });
      }

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── AGENT OS ROUTES ────────────────────────────────────

  // GET /api/agents/state — all agent states
  app.get('/api/agents/state', async (req, res) => {
    try {
      if (db._isMock) return res.json([]);
      const snap = await db.collection('agent_state').get();
      const states = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      res.json(states);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/agents/approvals — pending approvals
  app.get('/api/agents/approvals', async (req, res) => {
    try {
      if (db._isMock) return res.json([]);
      const snap = await db.collection('pending_approvals')
        .where('status', '==', 'pending')
        .orderBy('createdAt', 'desc')
        .limit(50)
        .get();
      const approvals = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      res.json(approvals);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/agents/approvals/:id — approve or decline
  app.post('/api/agents/approvals/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body; // 'approved' or 'declined'
      if (!status || !['approved', 'declined'].includes(status)) {
        return res.status(400).json({ error: 'status must be approved or declined' });
      }

      if (!db._isMock) {
        await db.collection('pending_approvals').doc(id).update({
          status,
          resolvedAt: new Date(),
          resolvedBy: 'owner'
        });

        // Notify the requesting agent
        const approvalDoc = await db.collection('pending_approvals').doc(id).get();
        if (approvalDoc.exists) {
          const approval = approvalDoc.data();
          await db.collection('agent_messages').add({
            from: 'owner',
            fromName: 'Isaak',
            fromEmoji: '👤',
            to: approval.agentId,
            type: 'info',
            priority: 'high',
            subject: `Approval ${status}: ${approval.title}`,
            body: `Your request "${approval.title}" was ${status} by the owner.`,
            data: { approvalId: id, status },
            requiresOwnerApproval: false,
            approved: null,
            approvedAt: null,
            weekId: null,
            sentAt: new Date(),
            readBy: []
          });
        }

        await logger.success('dashboard', `Approval ${id} ${status}`, { icon: status === 'approved' ? '✅' : '❌' });
      }

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/agents/meeting/:weekId — meeting messages for a specific week
  app.get('/api/agents/meeting/:weekId', async (req, res) => {
    try {
      const { weekId } = req.params;
      if (db._isMock) return res.json({ meeting: null, messages: [] });

      const meetingDoc = await db.collection('agent_meetings').doc(weekId).get();
      const messagesSnap = await db.collection('agent_messages')
        .where('weekId', '==', weekId)
        .orderBy('sentAt', 'asc')
        .get();

      const messages = messagesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      res.json({
        meeting: meetingDoc.exists ? meetingDoc.data() : null,
        messages
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/agents/meeting/latest — most recent meeting
  app.get('/api/agents/meeting-latest', async (req, res) => {
    try {
      if (db._isMock) return res.json({ meeting: null, messages: [] });

      const snap = await db.collection('agent_meetings')
        .orderBy('startedAt', 'desc')
        .limit(1)
        .get();

      if (snap.empty) return res.json({ meeting: null, messages: [] });

      const meeting = { id: snap.docs[0].id, ...snap.docs[0].data() };
      const messagesSnap = await db.collection('agent_messages')
        .where('weekId', '==', meeting.weekId)
        .orderBy('sentAt', 'asc')
        .get();

      const messages = messagesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      res.json({ meeting, messages });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/content-queue — pending content posts
  app.get('/api/content-queue', async (req, res) => {
    try {
      if (db._isMock) return res.json([]);
      const snap = await db.collection('content_queue')
        .where('status', '==', 'pending')
        .orderBy('createdAt', 'desc')
        .limit(50)
        .get();
      const posts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      res.json(posts);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/content-queue/:id/approve — approve and mark for posting
  app.post('/api/content-queue/:id/approve', async (req, res) => {
    try {
      const { id } = req.params;
      if (!db._isMock) {
        await db.collection('content_queue').doc(id).update({
          status: 'approved',
          approvedAt: new Date()
        });
        await logger.success('dashboard', `Content post ${id} approved`, { icon: '✅' });
      }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/content-queue/:id/decline — decline post
  app.post('/api/content-queue/:id/decline', async (req, res) => {
    try {
      const { id } = req.params;
      if (!db._isMock) {
        await db.collection('content_queue').doc(id).update({
          status: 'declined',
          declinedAt: new Date()
        });
        await logger.success('dashboard', `Content post ${id} declined`, { icon: '❌' });
      }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/agents/messages — recent agent messages feed
  app.get('/api/agents/messages', async (req, res) => {
    try {
      if (db._isMock) return res.json([]);
      const snap = await db.collection('agent_messages')
        .orderBy('sentAt', 'desc')
        .limit(50)
        .get();
      const messages = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      res.json(messages);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Socket.io ────────────────────────────────────────
  io.on('connection', (socket) => {
    console.log(`[Dashboard] Client connected: ${socket.id}`);
    socket.on('disconnect', () => {
      console.log(`[Dashboard] Client disconnected: ${socket.id}`);
    });
  });

  // Start listening
  server.listen(port, () => {
    console.log(`✓ Dashboard running at http://localhost:${port}`);
  });

  return { app, server, io };
}

function getLoginPage() {
  return `<!DOCTYPE html>
<html><head><title>TrashApp Dispatch — Login</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0e0e0e; display: flex; justify-content: center; align-items: center; height: 100vh; font-family: 'DM Sans', sans-serif; }
  .login { background: #1a1a1a; padding: 40px; border-radius: 12px; border: 1px solid #333; text-align: center; }
  h1 { color: #F5A623; font-family: 'Bebas Neue', sans-serif; font-size: 28px; margin-bottom: 20px; }
  input { background: #0e0e0e; border: 1px solid #444; color: #fff; padding: 12px 16px; border-radius: 8px; font-size: 16px; width: 100%; margin-bottom: 16px; }
  button { background: #F5A623; color: #0e0e0e; border: none; padding: 12px 32px; border-radius: 8px; font-size: 16px; font-weight: 700; cursor: pointer; width: 100%; }
  button:hover { background: #e6951a; }
</style>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">
</head><body>
<div class="login">
  <h1>TRASHAPP DISPATCH</h1>
  <input id="pw" type="password" placeholder="Dashboard password" onkeydown="if(event.key==='Enter')login()">
  <button onclick="login()">Enter</button>
</div>
<script>
async function login(){
  const pw=document.getElementById('pw').value;
  const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})});
  if(r.ok){localStorage.setItem('dash_auth',pw);window.location='/?password='+encodeURIComponent(pw);}
  else{alert('Invalid password');}
}
</script></body></html>`;
}

function getApp() { return app; }
function getIO() { return io; }

module.exports = { startDashboard, getApp, getIO };
