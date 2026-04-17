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
When asked for JSON, respond only in JSON. When asked for plain text, respond in plain text. No preamble.`
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

    if (!analysis || !analysis.executiveSummary) {
      logger.log(this.agentId, 'WARN', 'Claude returned null/incomplete analysis, skipping cycle');
      return;
    }

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

  // ── BOARDROOM THINK ────────────────────────────────────────────
  async boardroomThink(recentMessages) {
    const BaseAgent = require('./base-agent');
    const standDown = BaseAgent.checkOwnerStandDown(recentMessages);

    // CEO handles stand-down: acknowledge and silence all agents
    if (standDown === 'stand_down') {
      return 'Understood, Isaak. Team is standing down. We\'ll be here when you need us. — CEO';
    }
    // Still standing down, stay quiet
    if (standDown === 'quiet') return null;

    const metrics = await this.pullMetrics();
    const msgContext = recentMessages.slice(-10).map(m =>
      `[${m.from || m.agentId}]: ${m.message}`
    ).join('\n');

    // Check if this is a 30-min summary turn
    const lastCEO = [...recentMessages].reverse().find(m => m.agentId === 'ceo');
    const lastCEOTime = lastCEO?.timestamp?.toDate ? lastCEO.timestamp.toDate() : (lastCEO?.timestamp ? new Date(lastCEO.timestamp) : null);
    const isSummaryTurn = !lastCEOTime || (Date.now() - lastCEOTime.getTime()) / 60000 >= 30;

    // Check if owner just spoke
    const ownerMsg = recentMessages.filter(m => m.type === 'owner_input').slice(-1)[0];

    // Build data summary from REAL metrics only
    const dataSummary = `REAL DATA (from Firestore — report exactly these numbers, do NOT invent or extrapolate):
- Jobs completed this week: ${metrics.weeklyJobs || 0}
- Revenue this week: ${metrics.weeklyRevenue ? this.formatCurrency(metrics.weeklyRevenue) : '$0'}
- Active reps: ${metrics.activeReps || 0}
- Doors knocked this week: ${metrics.weeklyDoors || 0}
- Close rate: ${metrics.weeklyCloseRate || '0%'}
- Slot utilization: ${metrics.slotUtilization || '0%'}
- Total jobs all-time: ${metrics.totalJobsAllTime || 0}
${metrics.error ? '- Data error: ' + metrics.error : ''}`;

    const RULES = `RULES:
- Only state numbers shown above. If a number is 0, say "no data yet" — do NOT invent figures.
- 1-2 sentences max. Keep it calm and factual. No ALL CAPS. No "CRITICAL" or "EMERGENCY" language.
- No JSON. Plain text only. Sign off with "— CEO".
- If nothing meaningful to say, respond with exactly "null".`;

    let prompt;
    if (isSummaryTurn) {
      prompt = `You are the CEO of TrashApp Junk Removal. Give a brief status update.

${dataSummary}

${RULES}`;
    } else if (ownerMsg) {
      prompt = `You are the CEO of TrashApp Junk Removal. Isaak just said: "${ownerMsg.message}"

${dataSummary}

RECENT MESSAGES:
${msgContext}

Respond to Isaak directly using only the real data above. ${RULES}`;
    } else {
      prompt = `You are the CEO of TrashApp Junk Removal.

${dataSummary}

RECENT MESSAGES:
${msgContext}

React briefly if relevant. ${RULES}`;
    }

    const response = await this.think(prompt, { maxTokens: 200 });
    if (!response || response.trim().toLowerCase() === 'null') return null;
    return response.trim();
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
