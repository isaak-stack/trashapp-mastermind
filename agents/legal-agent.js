/**
 * agents/legal-agent.js — Legal AI Agent
 * Interval: 168 hours (7 days)
 * Persona: Cautious, precise, protective. Never alarmist but never dismissive.
 * Always specific about deadlines.
 */

const BaseAgent = require('./base-agent');
const { db } = require('../core/firestore');

class LegalAgent extends BaseAgent {
  constructor() {
    super({
      agentId: 'legal',
      agentName: 'Legal',
      emoji: '⚖️',
      color: '#7F8C8D',
      intervalMs: 168 * 60 * 60 * 1000, // 7 days
      systemPrompt: `You are the Legal AI agent for TrashApp Junk Removal in Fresno, CA.
Your job: track legal deadlines, compliance requirements, and protect the business.
You are cautious, precise, and protective. Never alarmist but never dismissive.
You always specify exact deadlines and days remaining.
You check: business licenses, insurance expiry, DBA renewals, Statement of Information, permits.
When something is due within 30 days, you flag it immediately.
Respond only in JSON. No preamble.`
    });
  }

  async runCycle() {
    // 1. Read or initialize legal config
    const legalConfig = await this.getLegalConfig();

    // 2. Read messages
    const messages = await this.readMessages({ limit: 5 });

    // 3. Think
    const analysis = await this.thinkJSON(`
      Today's date: ${new Date().toLocaleDateString()}

      LEGAL CONFIGURATION:
      ${JSON.stringify(legalConfig, null, 2)}

      MESSAGES:
      ${JSON.stringify(messages.slice(0,3), null, 2)}

      As Legal agent, analyze and return JSON:
      {
        "complianceStatus": "compliant|attention_needed|urgent",
        "deadlines": [
          {
            "item": string,
            "dueDate": string | null,
            "daysRemaining": number | null,
            "status": "ok|due_soon|overdue|unknown",
            "action": string
          }
        ],
        "missingItems": [string],
        "recommendations": [string],
        "summary": "2-3 sentence legal summary"
      }
    `, { maxTokens: 1500 });

    if (!analysis) return;

    // 4. Write report
    await this.writeReport({
      summary: analysis.summary,
      findings: analysis.deadlines?.map(d => `${d.item}: ${d.status} (${d.daysRemaining}d)`) || [],
      recommendations: analysis.recommendations || [],
      metricsSnapshot: { complianceStatus: analysis.complianceStatus, deadlines: analysis.deadlines }
    });

    // 5. Alert on items due within 30 days
    for (const deadline of (analysis.deadlines || [])) {
      if (deadline.daysRemaining !== null && deadline.daysRemaining <= 30 && deadline.status !== 'ok') {
        await this.queueApproval(
          `Legal: ${deadline.item} due in ${deadline.daysRemaining} days`,
          deadline.action,
          `Risk: non-compliance if missed`,
          { deadline }
        );
      }
    }

    // 6. Flag missing items to owner
    for (const missing of (analysis.missingItems || [])) {
      await this.sendMessage('owner', 'alert', `Legal: Missing — ${missing}`,
        `The legal tracker shows "${missing}" is not yet recorded. Please provide this information.`,
        { priority: 'medium' }
      );
    }
  }

  async getLegalConfig() {
    try {
      const doc = await db.collection('system_config').doc('legal').get();
      if (doc.exists) return doc.data();

      // Initialize default legal config
      const defaultConfig = {
        businessName: 'TrashApp Junk Removal',
        legalEntity: 'Thammavong Holdings LLC',
        ein: null,
        filings: [
          { type: 'DBA', jurisdiction: 'Fresno County', filedDate: null, renewalDate: null, status: 'pending' },
          { type: 'Statement of Information', jurisdiction: 'California', filedDate: null, dueDate: null }
        ],
        insurance: { type: null, carrier: null, expiryDate: null, coverageAmount: null },
        licenses: [],
        notes: []
      };

      await db.collection('system_config').doc('legal').set(defaultConfig);
      return defaultConfig;
    } catch { return { error: 'Could not read legal config' }; }
  }

  async meetingTurn(weekId, context) {
    const legalConfig = await this.getLegalConfig();
    const upcoming = (legalConfig.filings || []).filter(f => {
      if (!f.renewalDate && !f.dueDate) return false;
      const due = new Date(f.renewalDate || f.dueDate);
      const daysLeft = Math.floor((due.getTime() - Date.now()) / 86400000);
      return daysLeft <= 60;
    });

    await this.sendMeetingMessage(weekId,
      upcoming.length > 0
        ? `Legal: ${upcoming.length} upcoming deadline(s). ${upcoming.map(f => f.type).join(', ')}. Details in my report.`
        : `Legal: No upcoming deadlines. Compliance status looks clean. Check my report for full details.`,
      {}
    );
  }
}

module.exports = LegalAgent;
