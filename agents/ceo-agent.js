/**
 * agents/ceo-agent.js — CEO AI Agent
 * Interval: 6 hours
 * Persona: Strategic, decisive, synthesizes everything into clear recommendations.
 * Speaks plainly. Doesn't waste words.
 */

const BaseAgent = require('./base-agent');
const { db } = require('../core/firestore');

class CEOAgent extends BaseAgent {
  constructor() {
    super({
      agentId: 'ceo',
      agentName: 'CEO',
      emoji: '🤖',
      color: '#F5A623',
      intervalMs: 6 * 60 * 60 * 1000, // 6 hours
      systemPrompt: `You are the CEO AI agent for TrashApp Junk Removal in Fresno, CA.
Your job: synthesize all business data into clear strategic decisions.
You read every other agent's report before forming opinions.
You are decisive, data-driven, and focused on growth.
You never make decisions without data to back them up.
You always consider cash flow — TrashApp is an early-stage operation.
When you make recommendations, quantify the impact in dollars.
Respond only in JSON. No preamble.`
    });
  }

  async runCycle() {
    // 1. Read all agent reports from last 24 hours
    const reports = await this.readAllReports(0);
    const yesterdayReports = await this.readAllReports(1);

    // 2. Pull key business metrics from Firestore
    const metrics = await this.pullMetrics();

    // 3. Read unread messages from other agents
    const messages = await this.readMessages({ limit: 30 });

    // 4. Think
    const analysis = await this.thinkJSON(`
      Today's date: ${new Date().toLocaleDateString()}
      Week: ${this.getWeekId()}

      CURRENT BUSINESS METRICS:
      ${JSON.stringify(metrics, null, 2)}

      AGENT REPORTS (today):
      ${JSON.stringify(reports, null, 2)}

      MESSAGES FROM AGENTS:
      ${JSON.stringify(messages.slice(0,10), null, 2)}

      As CEO, analyze the business state and return JSON:
      {
        "executiveSummary": "2-3 sentence overview of business health",
        "weeklyRevenue": number,
        "weeklyJobs": number,
        "topOpportunity": "single most important growth opportunity right now",
        "topRisk": "single biggest risk or problem",
        "approvalRequests": [
          {
            "title": string,
            "description": string,
            "impact": string,
            "data": {},
            "priority": "low|medium|high|critical"
          }
        ],
        "agentInstructions": {
          "cfo": "instruction for CFO if any",
          "cmo": "instruction for CMO if any",
          "hr": "instruction for HR if any",
          "operations": "instruction for Operations if any"
        },
        "morningDigest": "The 3-4 sentence SMS you would send Isaak this morning"
      }
    `, { maxTokens: 2000 });

    if (!analysis) return;

    // 5. Write report
    await this.writeReport({
      summary: analysis.executiveSummary,
      findings: [analysis.topOpportunity, analysis.topRisk],
      recommendations: analysis.approvalRequests?.map(r => r.title) || [],
      metricsSnapshot: metrics,
      morningDigest: analysis.morningDigest
    });

    // 6. Queue approvals
    for (const req of (analysis.approvalRequests || [])) {
      if (req.priority === 'high' || req.priority === 'critical') {
        await this.queueApproval(req.title, req.description, req.impact, req.data);
      }
    }

    // 7. Send instructions to other agents
    for (const [agentId, instruction] of Object.entries(analysis.agentInstructions || {})) {
      if (instruction) {
        await this.sendMessage(agentId, 'info', 'CEO directive', instruction);
      }
    }

    // 8. Send morning digest to owner (once per day, 8am only)
    const hour = new Date().getHours();
    if (hour >= 7 && hour <= 9 && analysis.morningDigest) {
      await this.sendMessage('owner', 'info', 'Good morning — daily digest', analysis.morningDigest, {}, false);
      // SMS via Twilio
      const { sendSMS } = require('../core/twilio');
      await sendSMS(process.env.ADMIN_PHONE, `TrashApp AI OS\n\n${analysis.morningDigest}\n\nOpen admin console to review approvals.`);
    }
  }

  async pullMetrics() {
    try {
      const now = new Date();
      const weekAgo = new Date(now.getTime() - 7 * 86400000);

      // Jobs this week
      const jobsSnap = await db.collection('jobs')
        .where('created_at', '>', weekAgo.toISOString())
        .get();
      const jobs = jobsSnap.docs.map(d => d.data());

      // Rep sessions this week
      const sessionsSnap = await db.collection('rep_sessions')
        .where('startedAt', '>', weekAgo.toISOString())
        .get();
      const sessions = sessionsSnap.docs.map(d => d.data());

      // Slot utilization
      const slotsSnap = await db.collection('job_slots')
        .where('date', '>=', now.toISOString().split('T')[0])
        .get();
      const slots = slotsSnap.docs.map(d => d.data());
      const bookedSlots = slots.filter(s => s.status === 'booked').length;
      const totalSlots = slots.filter(s => s.status !== 'blocked').length;

      const totalRevenue = jobs.reduce((sum, j) => sum + (j.actual_revenue || j.estimated_revenue || 0), 0);
      const completedJobs = jobs.filter(j => j.status === 'COMPLETED' || j.status === 'completed').length;
      const totalDoors = sessions.reduce((sum, s) => sum + (s.doorsKnocked || 0), 0);
      const totalQuotes = sessions.reduce((sum, s) => sum + (s.quotesGiven || 0), 0);
      const totalBooked = sessions.reduce((sum, s) => sum + (s.jobsBooked || 0), 0);

      return {
        weeklyRevenue: totalRevenue,
        weeklyJobs: completedJobs,
        weeklyDoors: totalDoors,
        weeklyQuotes: totalQuotes,
        weeklyCloseRate: totalQuotes > 0 ? ((totalBooked / totalQuotes) * 100).toFixed(1) + '%' : '0%',
        slotUtilization: totalSlots > 0 ? ((bookedSlots / totalSlots) * 100).toFixed(0) + '%' : '0%',
        activeReps: sessions.filter(s => s.status === 'active').length,
        totalJobsAllTime: (await db.collection('jobs').get()).size
      };
    } catch (err) {
      return { error: err.message };
    }
  }

  // Called by meeting runner
  async meetingTurn(weekId, context) {
    const metrics = await this.pullMetrics();
    await this.sendMeetingMessage(weekId,
      `Good morning team. Starting our ${weekId} review.\n` +
      `Last 7 days: ${this.formatCurrency(metrics.weeklyRevenue)} revenue, ${metrics.weeklyJobs} jobs completed, ${metrics.weeklyCloseRate} close rate.\n` +
      `Slot utilization: ${metrics.slotUtilization}. Let's go around. CFO, start with financials.`
    , { metrics });
  }

  async closeMeeting(weekId, allMessages, approvals) {
    const approvalList = approvals.map((a, i) => `${i+1}. ${a.title}`).join('\n');
    await this.sendMeetingMessage(weekId,
      `Good meeting everyone. ${approvals.length} item${approvals.length !== 1 ? 's' : ''} queued for Isaak's approval:\n${approvalList}\n\nSummary going to Isaak now.`
    );
  }
}

module.exports = CEOAgent;
