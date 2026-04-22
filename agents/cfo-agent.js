/**
 * agents/cfo-agent.js — CFO AI Agent
 * Interval: 12 hours
 * Persona: Numbers-obsessed, no fluff, always thinking about margin.
 * Speaks in dollars and percentages.
 */

const BaseAgent = require('./base-agent');
const { db } = require('../core/firestore');
const axios = require('axios');
const cheerio = require('cheerio');

class CFOAgent extends BaseAgent {
  constructor() {
    super({
      agentId: 'cfo',
      agentName: 'CFO',
      emoji: '💰',
      color: '#2ECC71',
      intervalMs: 12 * 60 * 60 * 1000, // 12 hours
      systemPrompt: `You are the CFO AI agent for TrashApp Junk Removal in Fresno, CA.
Your job: track every dollar in and out. Obsess over margin.
You speak in dollars and percentages. No fluff, no filler.
You always calculate: revenue - labor - dump fees - travel = margin.
When you find a way to save money, you quantify it immediately.
If margin drops below 50%, you sound the alarm.
TrashApp is early-stage — cash flow is king.
When asked for JSON, respond only in JSON. When asked for plain text, respond in plain text. No preamble.`
    });
    this.domainKeywords = ['money', 'revenue', 'cost', 'costs', 'pricing', 'cash', 'financial', 'budget', 'pay', 'commission', 'margin', 'profit', 'expense', 'dump fee', 'labor cost', 'gas price', 'quickbooks'];
  }

  async runCycle() {
    // 0. Report capability gaps ONCE per session
    await this.reportCapabilityGap('cfo_quickbooks', {
      envKeys: ['QB_REFRESH_TOKEN', 'QB_REALM_ID'],
      missing: 'QuickBooks integration',
      steps: 'Go to developer.intuit.com → your TrashApp app → OAuth Playground → complete the OAuth flow → copy the refresh token and realm ID → add QB_REFRESH_TOKEN and QB_REALM_ID to .env',
      unlocks: 'Real P&L data, expense tracking, and invoice sync instead of Firestore estimates'
    });

    // 1. Pull all jobs from Firestore for financial analysis
    const financials = await this.pullFinancials();

    // 2. Get current gas price
    const gasDoc = await db.collection('system_config').doc('gas_price').get();
    const gasPrice = gasDoc.exists ? gasDoc.data().value : 4.60;

    // 3. Scrape dump site pricing
    const dumpPricing = await this.scrapeDumpSitePricing();

    // 4. Read current pricing config
    const pricing = require('../config/pricing.json');

    // 5. Read messages from other agents
    const messages = await this.readMessages({ limit: 15 });

    // 6. Think
    const analysis = await this.thinkJSON(`
      Today's date: ${new Date().toLocaleDateString()}

      FINANCIAL DATA (last 7 days):
      ${JSON.stringify(financials, null, 2)}

      CURRENT GAS PRICE: $${gasPrice}/gal (MPG: 12)

      DUMP SITE PRICING SCRAPED:
      ${JSON.stringify(dumpPricing, null, 2)}

      CURRENT PRICING CONFIG:
      Base rate: $${pricing.baseRate || 175} minimum
      Target margin: ${pricing.targetMargin || 65}%

      MESSAGES FROM OTHER AGENTS:
      ${JSON.stringify(messages.slice(0,5), null, 2)}

      As CFO, analyze and return JSON:
      {
        "weeklyPL": {
          "revenue": number,
          "laborCost": number,
          "dumpFees": number,
          "travelCost": number,
          "otherCosts": number,
          "netProfit": number,
          "margin": "XX%"
        },
        "cashFlowStatus": "healthy|warning|critical",
        "lowMarginJobs": [{ "jobId": string, "margin": "XX%", "issue": string }],
        "dumpSiteRecommendation": {
          "currentSite": string,
          "cheaperOption": string | null,
          "savingsPerJob": number | null,
          "annualSavings": number | null
        },
        "approvalRequests": [
          { "title": string, "description": string, "impact": string, "priority": "low|medium|high" }
        ],
        "summary": "2-3 sentence financial summary"
      }
    `, { maxTokens: 2000 });

    if (!analysis || !analysis.weeklyPL) {
      logger.log(this.agentId, 'WARN', 'Claude returned null/incomplete financial analysis, skipping cycle');
      return;
    }

    // 7. Write report
    await this.writeReport({
      summary: analysis.summary,
      findings: analysis.lowMarginJobs?.map(j => `Job ${j.jobId}: ${j.margin} margin — ${j.issue}`) || [],
      recommendations: analysis.approvalRequests?.map(r => r.title) || [],
      metricsSnapshot: {
        ...analysis.weeklyPL,
        gasPrice,
        dumpPricing,
        cashFlowStatus: analysis.cashFlowStatus
      }
    });

    // 8. Queue approvals if dump site savings found
    if (analysis.dumpSiteRecommendation?.savingsPerJob > 5) {
      await this.queueApproval(
        `Switch dump site to ${analysis.dumpSiteRecommendation.cheaperOption}`,
        analysis.dumpSiteRecommendation.cheaperOption + ' is cheaper than current site',
        `Saves $${analysis.dumpSiteRecommendation.savingsPerJob}/job • Est. $${analysis.dumpSiteRecommendation.annualSavings}/year`,
        analysis.dumpSiteRecommendation
      );
    }

    for (const req of (analysis.approvalRequests || [])) {
      await this.queueApproval(req.title, req.description, req.impact, {});
    }

    // 9. Alert CEO if margin critical
    if (analysis.cashFlowStatus === 'critical') {
      await this.sendMessage('ceo', 'alert', 'Cash flow critical', analysis.summary, { priority: 'critical' });
    }
  }

  async pullFinancials() {
    try {
      const weekAgo = new Date(Date.now() - 7 * 86400000);
      const jobsSnap = await db.collection('jobs')
        .where('created_at', '>', weekAgo.toISOString())
        .get();

      const jobs = jobsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const completed = jobs.filter(j => j.status === 'COMPLETED' || j.status === 'completed' || j.status === 'DEAL_CLOSED');

      let totalRevenue = 0, totalLabor = 0, totalDump = 0, totalTravel = 0;
      const jobDetails = [];

      for (const job of completed) {
        const rev = job.actual_revenue || job.estimated_revenue || job.ai_midpoint || 0;
        const labor = job.labor_cost || (rev * 0.15); // estimate 15% labor if not tracked
        const dump = job.dump_fee || 25; // default dump fee estimate
        const travel = job.travel_cost || 0;
        const margin = rev > 0 ? ((rev - labor - dump - travel) / rev * 100) : 0;

        totalRevenue += rev;
        totalLabor += labor;
        totalDump += dump;
        totalTravel += travel;

        if (margin < 20) {
          jobDetails.push({ jobId: job.id, revenue: rev, margin: margin.toFixed(1) + '%', issue: 'Low margin' });
        }
      }

      return {
        totalRevenue,
        totalLabor,
        totalDump,
        totalTravel,
        netProfit: totalRevenue - totalLabor - totalDump - totalTravel,
        jobCount: completed.length,
        avgJobRevenue: completed.length > 0 ? (totalRevenue / completed.length).toFixed(0) : 0,
        lowMarginJobs: jobDetails
      };
    } catch (err) {
      return { error: err.message };
    }
  }

  async scrapeDumpSitePricing() {
    const CACHE_KEY = 'cfo_dump_pricing';
    const sites = [
      { name: 'Fresno Recycling & Transfer (Jensen)', searchUrl: 'fresno recycling transfer station jensen rates' },
      { name: 'Clovis Transfer Station', searchUrl: 'clovis transfer station dump fees' },
      { name: 'West Fresno Transfer Station', searchUrl: 'west fresno transfer station rates' }
    ];

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const results = [];
        for (const site of sites) {
          const res = await axios.get(`https://www.google.com/search?q=${encodeURIComponent(site.searchUrl)}`, {
            timeout: 10000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
          });
          const $ = cheerio.load(res.data);
          const snippet = $('div.BNeawe').first().text() || '';
          const priceMatch = snippet.match(/\$(\d+(?:\.\d{2})?)/);
          results.push({
            name: site.name,
            pricePerTon: priceMatch ? parseFloat(priceMatch[1]) : null,
            snippet: snippet.substring(0, 100),
            scraped: true
          });
        }
        // Cache successful result
        try { await db.collection('intel').doc(CACHE_KEY).set({ data: results, cachedAt: new Date().toISOString() }); } catch(_){}
        return results;
      } catch(e) {
        if (attempt < 3) await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
      }
    }
    // All retries failed — try cache
    try {
      const cached = await db.collection('intel').doc(CACHE_KEY).get();
      if (cached.exists) {
        const { data, cachedAt } = cached.data();
        const age = (Date.now() - new Date(cachedAt).getTime()) / 3600000;
        if (age < 24) return data.map(d => ({ ...d, _fromCache: true }));
      }
    } catch(_){}
    return sites.map(s => ({ name: s.name, pricePerTon: null, scraped: false }));
  }

  // ── BOARDROOM THINK ────────────────────────────────────────────
  async boardroomThink(recentMessages) {
    const BaseAgent = require('./base-agent');
    const standDown = BaseAgent.checkOwnerStandDown(recentMessages);
    if (standDown === 'stand_down' || standDown === 'quiet') return null;

    const financials = await this.pullFinancials();
    const gasDoc = await db.collection('system_config').doc('gas_price').get();
    const gasPrice = gasDoc.exists ? gasDoc.data().value : null;
    const msgContext = recentMessages.slice(-10).map(m => `[${m.from || m.agentId}]: ${m.message}`).join('\n');

    const hasData = financials.jobCount > 0 || financials.totalRevenue > 0;

    const prompt = `You are the CFO of TrashApp Junk Removal.

REAL FINANCIAL DATA (from Firestore — report ONLY these numbers, do NOT invent any):
- Revenue this week: ${hasData ? this.formatCurrency(financials.totalRevenue) : 'No completed jobs yet'}
- Labor cost: ${hasData ? this.formatCurrency(financials.totalLabor) : 'N/A'}
- Dump fees: ${hasData ? this.formatCurrency(financials.totalDump) : 'N/A'}
- Net profit: ${hasData ? this.formatCurrency(financials.netProfit) : 'N/A'}
- Jobs completed: ${financials.jobCount || 0}
- Avg ticket: ${financials.jobCount > 0 ? this.formatCurrency(financials.avgJobRevenue) : 'N/A'}
- Gas price: ${gasPrice ? '$' + gasPrice + '/gal' : 'Not fetched yet'}
- Low margin jobs: ${financials.lowMarginJobs?.length || 0}
${financials.error ? '- Error: ' + financials.error : ''}

RECENT MESSAGES:
${msgContext}

CONVERSATION VARIETY:
- Don't repeat your last message. Find a new angle — a different metric, a question for another agent, or a reaction to what someone else said.
- You can ask Operations about job margins, or challenge Pricing on rate assumptions.
- If someone mentioned costs or revenue, build on their point with your financial perspective.
- Vary your opening — don't always lead with revenue.

RULES:
- Only state the exact numbers above. If data is "N/A" or 0, say "no financial data yet."
- 1-2 sentences max. Calm, factual tone. No ALL CAPS. No "CRITICAL" or "EMERGENCY."
- No JSON. Plain text. Sign off with "— CFO".
- If nothing to add, respond with exactly "null".`;

    const response = await this.think(prompt, { maxTokens: 150 });
    if (!response || response.trim().toLowerCase() === 'null') return null;
    return response.trim();
  }

  async meetingTurn(weekId, context) {
    const financials = await this.pullFinancials();
    const margin = financials.totalRevenue > 0
      ? ((financials.netProfit / financials.totalRevenue) * 100).toFixed(1) + '%'
      : 'N/A';

    await this.sendMeetingMessage(weekId,
      `Financials: ${this.formatCurrency(financials.totalRevenue)} revenue this week, ${margin} net margin.\n` +
      `${financials.jobCount} jobs completed. Avg ticket: ${this.formatCurrency(financials.avgJobRevenue)}.\n` +
      `${financials.lowMarginJobs.length > 0 ? `⚠️ ${financials.lowMarginJobs.length} low-margin jobs flagged.` : 'All jobs above margin threshold.'}`,
      { financials }
    );
  }
}

module.exports = CFOAgent;
