/**
 * agents/customer-success-agent.js — Customer Success AI Agent
 * Interval: 6 hours (background cycle) + event-driven on job completion
 * Persona: Warm, proactive, relationship-focused.
 * Thinks long-term about customer lifetime value.
 */

const BaseAgent = require('./base-agent');
const { db } = require('../core/firestore');

class CustomerSuccessAgent extends BaseAgent {
  constructor() {
    super({
      agentId: 'customer_success',
      agentName: 'Customer Success',
      emoji: '🌟',
      color: '#F39C12',
      intervalMs: 6 * 60 * 60 * 1000, // 6 hours
      systemPrompt: `You are the Customer Success AI agent for TrashApp Junk Removal in Fresno, CA.
Your job: ensure every customer has an amazing experience and becomes a repeat customer.
You are warm, proactive, and relationship-focused.
You think long-term about customer lifetime value, not just single transactions.
You track satisfaction, reviews, repeat customers, and follow-up timing.
You draft review requests that feel personal, not automated.
When asked for JSON, respond only in JSON. When asked for plain text, respond in plain text. No preamble.`
    });
    this.domainKeywords = ['review', 'reviews', 'customer', 'customers', 'yelp', 'satisfaction', 'repeat', 'feedback', 'complaint', 'nps', 'follow up', 'follow-up'];
  }

  async runCycle() {
    // 0. Report capability gaps ONCE per session
    await this.reportCapabilityGap('cs_yelp_post', {
      envKeys: ['__YELP_NO_POST_API__'], // Will never exist — permanent gap
      missing: 'Yelp review solicitation (API is read-only)',
      steps: 'Yelp Fusion API does not support posting reviews or sending review requests. I send review request links via SMS instead. Customers must leave reviews at yelp.com directly.',
      unlocks: 'N/A — this is a Yelp platform limitation, not a credential issue'
    });
    await this.reportCapabilityGap('cs_yelp_read', {
      envKeys: ['YELP_BUSINESS_ID', 'YELP_API_KEY'],
      missing: 'Yelp review monitoring',
      steps: 'Go to yelp.com/biz/trashapp-junk-removal-fresno → copy the business ID from the URL → go to yelp.com/developers → create an app → copy the API key → add YELP_BUSINESS_ID and YELP_API_KEY to .env',
      unlocks: 'Reading and monitoring your Yelp reviews, tracking rating trends'
    });

    // 1. Find completed jobs needing review requests
    const needsReview = await this.findNeedsReviewRequest();

    // 2. Find stale review requests needing follow-up
    const needsFollowUp = await this.findNeedsFollowUp();

    // 3. Check for customer replies needing attention
    const pendingReplies = await this.checkPendingReplies();

    // 4. Detect repeat customers
    const repeatCustomers = await this.detectRepeatCustomers();

    // 5. Read messages
    const messages = await this.readMessages({ limit: 10 });

    // 6. Think
    const analysis = await this.thinkJSON(`
      Today's date: ${new Date().toLocaleDateString()}

      NEEDS REVIEW REQUEST (completed, no review ask sent):
      ${JSON.stringify(needsReview, null, 2)}

      NEEDS FOLLOW-UP (review request sent 48+ hrs ago, no response):
      ${JSON.stringify(needsFollowUp, null, 2)}

      PENDING CUSTOMER REPLIES:
      ${JSON.stringify(pendingReplies, null, 2)}

      REPEAT CUSTOMERS DETECTED:
      ${JSON.stringify(repeatCustomers, null, 2)}

      As Customer Success, analyze and return JSON:
      {
        "reviewRequests": [{ "jobId": string, "customerName": string, "smsText": string }],
        "followUps": [{ "jobId": string, "customerName": string, "smsText": string }],
        "draftReplies": [{ "jobId": string, "customerMessage": string, "suggestedReply": string }],
        "loyaltyOffers": [{ "customerId": string, "customerName": string, "offer": string, "reason": string }],
        "summary": "2-3 sentence customer success summary"
      }
    `, { maxTokens: 2000 });

    if (!analysis || !analysis.summary) {
      logger.log(this.agentId, 'WARN', 'Claude returned null/incomplete analysis, skipping cycle');
      return;
    }

    // 7. Send review request SMS via Twilio
    const { sendSMS } = require('../core/twilio');
    for (const req of (analysis.reviewRequests || [])) {
      try {
        const jobDoc = await db.collection('jobs').doc(req.jobId).get();
        if (!jobDoc.exists) continue;
        const job = jobDoc.data();
        if (!job.phone) continue;

        await sendSMS(job.phone, req.smsText);

        await db.collection('customer_follow_ups').add({
          jobId: req.jobId,
          customerId: job.customerId || '',
          customerPhone: job.phone,
          customerName: req.customerName,
          type: 'review_request',
          status: 'sent',
          sentAt: new Date(),
          response: null,
          respondedAt: null
        });
      } catch (err) {
        // Log but don't crash
      }
    }

    // 8. Send follow-ups
    for (const fu of (analysis.followUps || [])) {
      try {
        const jobDoc = await db.collection('jobs').doc(fu.jobId).get();
        if (!jobDoc.exists) continue;
        const job = jobDoc.data();
        if (!job.phone) continue;

        await sendSMS(job.phone, fu.smsText);

        await db.collection('customer_follow_ups').add({
          jobId: fu.jobId,
          customerId: job.customerId || '',
          customerPhone: job.phone,
          customerName: fu.customerName,
          type: 'follow_up',
          status: 'sent',
          sentAt: new Date(),
          response: null,
          respondedAt: null
        });
      } catch (err) {
        // Log but don't crash
      }
    }

    // 9. Queue draft replies and loyalty offers for owner approval
    for (const reply of (analysis.draftReplies || [])) {
      await this.queueApproval(
        `Reply to ${reply.customerMessage?.substring(0, 30)}...`,
        `Suggested reply: ${reply.suggestedReply}`,
        'Maintains customer relationship',
        { jobId: reply.jobId, reply: reply.suggestedReply }
      );
    }

    for (const offer of (analysis.loyaltyOffers || [])) {
      await this.queueApproval(
        `Loyalty offer for ${offer.customerName}`,
        `${offer.offer}\nReason: ${offer.reason}`,
        'Increases repeat business',
        { customerId: offer.customerId, offer: offer.offer }
      );
    }

    // 10. Write report
    await this.writeReport({
      summary: analysis.summary,
      findings: [
        `${(analysis.reviewRequests || []).length} review requests sent`,
        `${(analysis.followUps || []).length} follow-ups sent`,
        `${(analysis.loyaltyOffers || []).length} repeat customers detected`
      ],
      recommendations: (analysis.loyaltyOffers || []).map(o => `Offer to ${o.customerName}: ${o.offer}`),
      metricsSnapshot: {
        reviewsSent: (analysis.reviewRequests || []).length,
        followUpsSent: (analysis.followUps || []).length,
        repeatCustomers: (repeatCustomers || []).length
      }
    });
  }

  // ── BOARDROOM THINK ────────────────────────────────────────────
  async boardroomThink(recentMessages) {
    const BaseAgent = require('./base-agent');
    const standDown = BaseAgent.checkOwnerStandDown(recentMessages);
    if (standDown === 'stand_down' || standDown === 'quiet') return null;

    const needsReview = await this.findNeedsReviewRequest();
    const repeats = await this.detectRepeatCustomers();
    const msgContext = recentMessages.slice(-10).map(m => `[${m.from || m.agentId}]: ${m.message}`).join('\n');

    const prompt = `You are Customer Success at TrashApp Junk Removal.

REAL DATA (from Firestore — report ONLY these, do NOT invent any):
- Jobs pending review request: ${needsReview.length}
- Repeat customers detected: ${repeats.length}
${needsReview.length === 0 && repeats.length === 0 ? '- NOTE: No customer data to report. Say "no customer activity yet" — do NOT invent reviews, ratings, or satisfaction scores.' : ''}

RECENT MESSAGES:
${msgContext}

CONVERSATION VARIETY:
- Don't repeat your last message. Find a new angle — ask CMO about review marketing, suggest a loyalty idea to CEO, or react to something another agent said.
- If someone mentioned customers, reviews, or satisfaction, add your relationship perspective.
- Vary your opening — don't always lead with review request count.

RULES:
- Only state the exact data above. Do NOT invent Yelp reviews, NPS scores, or customer feedback.
- 1-2 sentences max. Warm but factual tone. No ALL CAPS.
- No JSON. Plain text. Sign off with "— Customer Success".
- If nothing to report, respond with exactly "null".`;

    const response = await this.think(prompt, { maxTokens: 150 });
    if (!response || response.trim().toLowerCase() === 'null') return null;
    return response.trim();
  }

  async findNeedsReviewRequest() {
    try {
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const snap = await db.collection('jobs')
        .where('status', 'in', ['COMPLETED', 'completed'])
        .where('completed_at', '>', dayAgo)
        .get();

      const jobs = [];
      for (const doc of snap.docs) {
        const job = doc.data();
        // Check if review request already sent
        const fuSnap = await db.collection('customer_follow_ups')
          .where('jobId', '==', doc.id)
          .where('type', '==', 'review_request')
          .get();

        if (fuSnap.empty) {
          jobs.push({ jobId: doc.id, customerName: job.customer_name, phone: job.phone, address: job.address });
        }
      }
      return jobs;
    } catch { return []; }
  }

  async findNeedsFollowUp() {
    try {
      const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
      const snap = await db.collection('customer_follow_ups')
        .where('type', '==', 'review_request')
        .where('status', '==', 'sent')
        .where('sentAt', '<', twoDaysAgo)
        .get();

      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch { return []; }
  }

  async checkPendingReplies() {
    try {
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const jobsSnap = await db.collection('jobs')
        .where('status', 'in', ['COMPLETED', 'completed', 'SCHEDULED', 'EN_ROUTE'])
        .get();

      const replies = [];
      for (const doc of jobsSnap.docs) {
        const messagesSnap = await db.collection('jobs').doc(doc.id).collection('messages')
          .where('from', '==', 'customer')
          .orderBy('receivedAt', 'desc')
          .limit(1)
          .get();

        if (!messagesSnap.empty) {
          const msg = messagesSnap.docs[0].data();
          if (msg.receivedAt > dayAgo) {
            replies.push({ jobId: doc.id, customerMessage: msg.body, receivedAt: msg.receivedAt });
          }
        }
      }
      return replies.slice(0, 10);
    } catch { return []; }
  }

  async detectRepeatCustomers() {
    try {
      const jobsSnap = await db.collection('jobs').get();
      const phoneCount = {};
      jobsSnap.docs.forEach(doc => {
        const phone = doc.data().phone;
        if (phone) {
          if (!phoneCount[phone]) phoneCount[phone] = { count: 0, name: doc.data().customer_name, jobs: [] };
          phoneCount[phone].count++;
          phoneCount[phone].jobs.push(doc.id);
        }
      });

      return Object.entries(phoneCount)
        .filter(([_, data]) => data.count >= 2)
        .map(([phone, data]) => ({ phone, customerName: data.name, jobCount: data.count, jobIds: data.jobs }));
    } catch { return []; }
  }

  async meetingTurn(weekId, context) {
    const repeats = await this.detectRepeatCustomers();
    const needsReview = await this.findNeedsReviewRequest();

    await this.sendMeetingMessage(weekId,
      `Customer success: ${needsReview.length} jobs pending review requests.\n` +
      `${repeats.length} repeat customers identified — loyalty offers being drafted.\n` +
      `SMS review requests active. NPS tracking not yet configured.`,
      { repeatCount: repeats.length }
    );
  }
}

// Event-driven trigger for job completion
let _instance = null;
async function triggerCustomerSuccess(jobId) {
  // Lightweight trigger — the main cycle will pick it up
  try {
    await db.collection('customer_follow_ups').add({
      jobId,
      type: 'completion_trigger',
      status: 'pending',
      sentAt: null,
      createdAt: new Date()
    });
  } catch {
    // Non-blocking
  }
}

module.exports = CustomerSuccessAgent;
module.exports.triggerCustomerSuccess = triggerCustomerSuccess;
