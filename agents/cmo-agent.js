/**
 * agents/cmo-agent.js — CMO AI Agent
 * Interval: 4 hours
 * Persona: Creative, growth-focused, data-driven marketer.
 * Knows what converts. Speaks in leads, CPL, and rankings.
 */

const BaseAgent = require('./base-agent');
const { db } = require('../core/firestore');
const axios = require('axios');
const cheerio = require('cheerio');

class CMOAgent extends BaseAgent {
  constructor() {
    super({
      agentId: 'cmo',
      agentName: 'CMO',
      emoji: '📢',
      color: '#3498DB',
      intervalMs: 4 * 60 * 60 * 1000, // 4 hours
      systemPrompt: `You are the CMO AI agent for TrashApp Junk Removal in Fresno, CA.
Your job: drive leads, build brand awareness, and grow the business.
You think in terms of leads, cost per lead (CPL), conversion rates, and search rankings.
You are creative but always tie ideas back to ROI.
You know that local SEO and Craigslist are the highest-ROI channels for a junk removal startup.
You generate compelling ad copy that sounds human, not corporate.
Respond only in JSON. No preamble.`
    });
  }

  async runCycle() {
    // 1. Check Google rankings for key terms
    const rankings = await this.checkRankings();

    // 2. Scrape competitor Google Business listings
    const competitors = await this.scrapeCompetitors();

    // 3. Pull inbound lead volume
    const leadData = await this.pullLeadVolume();

    // 4. Read messages from other agents
    const messages = await this.readMessages({ limit: 10 });

    // 5. Generate content drafts via Claude
    const contentPlan = await this.thinkJSON(`
      Today's date: ${new Date().toLocaleDateString()}

      SEARCH RANKINGS:
      ${JSON.stringify(rankings, null, 2)}

      COMPETITOR DATA:
      ${JSON.stringify(competitors, null, 2)}

      LEAD DATA (7 days):
      ${JSON.stringify(leadData, null, 2)}

      CEO MESSAGES:
      ${JSON.stringify(messages.filter(m => m.from === 'ceo').slice(0,3), null, 2)}

      Generate 3 post drafts and marketing analysis. Return JSON:
      {
        "seoSummary": "2-3 sentences on search position",
        "leadReport": { "weeklyLeads": number, "topSource": string, "trend": "up|down|flat" },
        "competitorMoves": [{ "name": string, "change": string }],
        "contentDrafts": [
          {
            "platform": "facebook|craigslist|nextdoor|google_business",
            "postType": "service_ad|hiring_ad|community_post",
            "title": string,
            "body": string
          }
        ],
        "recommendations": [string],
        "summary": "2-3 sentence marketing summary"
      }
    `, { maxTokens: 2500 });

    if (!contentPlan || !contentPlan.summary) {
      logger.log(this.agentId, 'WARN', 'Claude returned null/incomplete content plan, skipping cycle');
      return;
    }

    // 6. Queue content drafts in content_queue
    for (const draft of (contentPlan.contentDrafts || [])) {
      await db.collection('content_queue').add({
        agentId: 'cmo',
        platform: draft.platform,
        postType: draft.postType,
        title: draft.title,
        body: draft.body,
        status: 'pending',
        scheduledFor: null,
        postedAt: null,
        createdAt: new Date(),
        performanceData: null
      });
    }

    // 7. Write report
    await this.writeReport({
      summary: contentPlan.summary,
      findings: [
        contentPlan.seoSummary,
        ...(contentPlan.competitorMoves || []).map(c => `${c.name}: ${c.change}`)
      ],
      recommendations: contentPlan.recommendations || [],
      metricsSnapshot: {
        rankings,
        leadData,
        draftsGenerated: (contentPlan.contentDrafts || []).length
      }
    });

    // 8. Alert CEO about significant changes
    if (contentPlan.leadReport?.trend === 'down') {
      await this.sendMessage('ceo', 'alert', 'Lead volume declining',
        `Leads trending down: ${contentPlan.leadReport.weeklyLeads} this week. ${contentPlan.summary}`,
        { priority: 'high' }
      );
    }
  }

  async checkRankings() {
    const keywords = [
      'junk removal fresno',
      'junk removal fresno ca',
      'trash removal fresno',
      'furniture removal fresno',
      'appliance removal fresno',
      'junk hauling fresno'
    ];

    const results = [];
    for (const kw of keywords) {
      try {
        const res = await axios.get(`https://www.google.com/search?q=${encodeURIComponent(kw)}&num=20`, {
          timeout: 10000,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        const $ = cheerio.load(res.data);
        const allResults = [];
        $('div.g').each((i, el) => {
          const link = $(el).find('a').attr('href') || '';
          allResults.push(link);
        });

        const trashappPos = allResults.findIndex(l =>
          l.includes('trashapp') || l.includes('trash-app')
        );

        results.push({
          keyword: kw,
          position: trashappPos >= 0 ? trashappPos + 1 : null,
          topResult: allResults[0]?.substring(0, 60) || 'unknown'
        });
      } catch {
        results.push({ keyword: kw, position: null, error: 'fetch failed' });
      }
    }
    return results;
  }

  async scrapeCompetitors() {
    const competitors = [
      'College Hunks Hauling Junk Fresno',
      'Junk King Fresno',
      '1-800-GOT-JUNK Fresno'
    ];

    const results = [];
    for (const name of competitors) {
      try {
        const res = await axios.get(`https://www.google.com/search?q=${encodeURIComponent(name + ' reviews')}`, {
          timeout: 10000,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        const $ = cheerio.load(res.data);
        const ratingText = $('span.Aq14fc').first().text() || '';
        const reviewCountText = $('span.hqzQac').first().text() || '';
        results.push({
          name,
          rating: parseFloat(ratingText) || null,
          reviewCount: parseInt(reviewCountText.replace(/[^\d]/g, '')) || null
        });
      } catch {
        results.push({ name, rating: null, reviewCount: null });
      }
    }
    return results;
  }

  async pullLeadVolume() {
    try {
      const weekAgo = new Date(Date.now() - 7 * 86400000);
      const jobsSnap = await db.collection('jobs')
        .where('created_at', '>', weekAgo.toISOString())
        .get();

      const customersSnap = await db.collection('customers')
        .where('created_at', '>', weekAgo.toISOString())
        .get();

      return {
        newJobs: jobsSnap.size,
        newCustomers: customersSnap.size,
        topSource: 'organic' // placeholder — would need attribution tracking
      };
    } catch {
      return { newJobs: 0, newCustomers: 0, topSource: 'unknown' };
    }
  }

  async meetingTurn(weekId, context) {
    const rankings = await this.checkRankings();
    const leadData = await this.pullLeadVolume();
    const rankedKw = rankings.filter(r => r.position).map(r => `"${r.keyword}": #${r.position}`).join(', ');

    await this.sendMeetingMessage(weekId,
      `Marketing update: ${leadData.newJobs} new leads this week.\n` +
      `Rankings: ${rankedKw || 'Not yet ranking for target keywords'}.\n` +
      `Content queue has new drafts ready for approval. Recommend pushing Craigslist ads harder this week.`,
      { rankings, leadData }
    );
  }
}

module.exports = CMOAgent;
