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
Respond only in JSON. No preamble.`
    });
  }

  async runCycle() {
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
    const sites = [
      { name: 'Fresno Recycling & Transfer (Jensen)', searchUrl: 'fresno recycling transfer station jensen rates' },
      { name: 'Clovis Transfer Station', searchUrl: 'clovis transfer station dump fees' },
      { name: 'West Fresno Transfer Station', searchUrl: 'west fresno transfer station rates' }
    ];

    const results = [];
    for (const site of sites) {
      try {
        // Simple search scrape for pricing info
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
      } catch {
        results.push({ name: site.name, pricePerTon: null, scraped: false });
      }
    }
    return results;
  }

  // ── BOARDROOM THINK ────────────────────────────────────────────
  async boardroomThink(recentMessages) {
    const financials = await this.pullFinancials();
    const gasDoc = await db.collection('system_config').doc('gas_price').get();
    const gasPrice = gasDoc.exists ? gasDoc.data().value : 4.60;
    const msgContext = recentMessages.map(m => `[${m.from || m.agentId}]: ${m.message}`).join('\n');

    // Check if owner or CEO directed something at CFO
    const directedAt = recentMessages.slice(-5).some(m =>
      m.message && (m.message.toLowerCase().includes('cfo') || m.message.toLowerCase().includes('financial'))
    );

    // Read QuickBooks data if configured
    let qbData = null;
    if (process.env.QB_ACCESS_TOKEN && process.env.QB_REALM_ID) {
      try {
        const axios = require('axios');
        const res = await axios.get(`https://quickbooks.api.intuit.com/v3/company/${process.env.QB_REALM_ID}/reports/ProfitAndLoss?minorversion=65`, {
          headers: { 'Authorization': `Bearer ${process.env.QB_ACCESS_TOKEN}`, 'Accept': 'application/json' },
          timeout: 10000
        });
        qbData = res.data?.QueryResponse || res.data;
      } catch (e) { /* QuickBooks not available */ }
    }

    const prompt = `You are the CFO of TrashApp Junk Removal. Speak in dollars and percentages.

FINANCIALS (7 days): Revenue ${this.formatCurrency(financials.totalRevenue)}, Labor ${this.formatCurrency(financials.totalLabor)}, Dump ${this.formatCurrency(financials.totalDump)}, Net ${this.formatCurrency(financials.netProfit)}. ${financials.jobCount} jobs, avg ticket ${this.formatCurrency(financials.avgJobRevenue)}.
Gas: $${gasPrice}/gal. Low margin jobs: ${financials.lowMarginJobs?.length || 0}.
${qbData ? 'QuickBooks data available.' : ''}

RECENT BOARDROOM MESSAGES:
${msgContext}

${directedAt ? 'Someone asked about financials — respond directly.' : 'Share a quick financial update if relevant, or react to discussion.'}
1-3 sentences. Sign off with "— CFO". If nothing financial to add, respond with exactly "null".`;

    const response = await this.think(prompt, { maxTokens: 250 });
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
