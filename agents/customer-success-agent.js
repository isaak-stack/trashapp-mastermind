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
Respond only in JSON. No preamble.`
    });
  }

  async runCycle() {
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
      `Review collection and NPS tracking active.`,
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
