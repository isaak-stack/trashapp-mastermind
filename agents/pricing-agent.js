/**
 * agents/pricing-agent.js — Pricing AI Agent
 * Interval: 24 hours
 * Persona: Analytical, competitive, always looking for an edge.
 * Speaks in market data.
 */

const BaseAgent = require('./base-agent');
const { db } = require('../core/firestore');
const axios = require('axios');
const cheerio = require('cheerio');

class PricingAgent extends BaseAgent {
  constructor() {
    super({
      agentId: 'pricing',
      agentName: 'Pricing',
      emoji: '📊',
      color: '#E74C3C',
      intervalMs: 24 * 60 * 60 * 1000, // 24 hours
      systemPrompt: `You are the Pricing AI agent for TrashApp Junk Removal in Fresno, CA.
Your job: monitor competitor pricing and market rates to keep TrashApp competitive.
You are analytical, competitive, and always looking for an edge.
You speak in market data: ranges, averages, trends.
You scrape competitor prices from Craigslist and Google, then compare to our rates.
If the market has shifted significantly (>10%), you recommend a pricing adjustment.
Respond only in JSON. No preamble.`
    });
  }

  async runCycle() {
    // 1. Scrape Craigslist for junk removal pricing
    const craigslistPrices = await this.scrapeCraigslistPricing();

    // 2. Scrape Google results for competitor pricing mentions
    const googlePrices = await this.scrapeGooglePricing();

    // 3. Read current pricing config
    const pricing = require('../config/pricing.json');

    // 4. Read messages
    const messages = await this.readMessages({ limit: 5 });

    // 5. Think
    const analysis = await this.thinkJSON(`
      Today's date: ${new Date().toLocaleDateString()}

      CRAIGSLIST PRICING DATA:
      ${JSON.stringify(craigslistPrices, null, 2)}

      GOOGLE SEARCH PRICING DATA:
      ${JSON.stringify(googlePrices, null, 2)}

      OUR CURRENT PRICING:
      Base minimum: $175
      Target margin: 65%
      Full pricing config: ${JSON.stringify(pricing, null, 2)}

      MESSAGES:
      ${JSON.stringify(messages.slice(0,3), null, 2)}

      As Pricing analyst, analyze and return JSON:
      {
        "marketRates": {
          "low": number,
          "mid": number,
          "high": number,
          "sampleSize": number,
          "sources": [string]
        },
        "ourPosition": "below_market|at_market|above_market",
        "competitorData": [
          { "name": string, "priceRange": string, "source": string }
        ],
        "shiftDetected": boolean,
        "shiftPercent": number,
        "recommendation": string | null,
        "summary": "2-3 sentence market pricing summary"
      }
    `, { maxTokens: 1500 });

    if (!analysis) return;

    // 6. Write to pricing_intel collection
    const today = new Date().toISOString().split('T')[0];
    await db.collection('pricing_intel').doc(today).set({
      date: today,
      marketLow: analysis.marketRates?.low || 0,
      marketMid: analysis.marketRates?.mid || 0,
      marketHigh: analysis.marketRates?.high || 0,
      ourBasePrice: 175,
      competitorData: analysis.competitorData || [],
      recommendation: analysis.recommendation || ''
    });

    // 7. Write report
    await this.writeReport({
      summary: analysis.summary,
      findings: [
        `Market range: $${analysis.marketRates?.low}-$${analysis.marketRates?.high}`,
        `Our position: ${analysis.ourPosition}`,
        ...(analysis.competitorData || []).map(c => `${c.name}: ${c.priceRange}`)
      ],
      recommendations: analysis.recommendation ? [analysis.recommendation] : [],
      metricsSnapshot: analysis.marketRates || {}
    });

    // 8. Alert CEO if significant market shift
    if (analysis.shiftDetected && Math.abs(analysis.shiftPercent) > 10) {
      await this.sendMessage('ceo', 'recommendation', 'Market pricing shift detected',
        `Market has shifted ${analysis.shiftPercent}%. ${analysis.recommendation}`,
        { priority: 'high' }
      );
      await this.queueApproval(
        `Pricing adjustment: market shifted ${analysis.shiftPercent}%`,
        analysis.recommendation || 'Review pricing strategy',
        `Competitive positioning at stake`,
        { marketRates: analysis.marketRates, shiftPercent: analysis.shiftPercent }
      );
    }
  }

  async scrapeCraigslistPricing() {
    try {
      const res = await axios.get('https://fresno.craigslist.org/search/hss', {
        params: { query: 'junk removal' },
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });

      const $ = cheerio.load(res.data);
      const prices = [];

      $('li.cl-search-result').each((i, el) => {
        const title = $(el).find('.cl-search-result-title')?.text() || '';
        const priceMatch = title.match(/\$(\d+)/);
        if (priceMatch) {
          prices.push({
            price: parseInt(priceMatch[1]),
            title: title.substring(0, 80),
            source: 'craigslist'
          });
        }
      });

      return prices.slice(0, 15);
    } catch { return []; }
  }

  async scrapeGooglePricing() {
    try {
      const res = await axios.get(`https://www.google.com/search?q=${encodeURIComponent('junk removal fresno price cost')}`, {
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });

      const $ = cheerio.load(res.data);
      const prices = [];

      $('div.BNeawe').each((i, el) => {
        const text = $(el).text();
        const priceMatches = text.match(/\$(\d{2,4})/g);
        if (priceMatches) {
          priceMatches.forEach(p => {
            const val = parseInt(p.replace('$', ''));
            if (val >= 50 && val <= 2000) {
              prices.push({ price: val, snippet: text.substring(0, 60), source: 'google' });
            }
          });
        }
      });

      return prices.slice(0, 10);
    } catch { return []; }
  }

  async meetingTurn(weekId, context) {
    const today = new Date().toISOString().split('T')[0];
    let latestIntel;
    try {
      const doc = await db.collection('pricing_intel').doc(today).get();
      latestIntel = doc.exists ? doc.data() : null;
    } catch { latestIntel = null; }

    await this.sendMeetingMessage(weekId,
      latestIntel
        ? `Pricing: Market range $${latestIntel.marketLow}-$${latestIntel.marketHigh}, midpoint $${latestIntel.marketMid}.\n` +
          `Our base at $175. ${latestIntel.recommendation || 'No adjustment needed.'}`
        : `Pricing: Market data collection in progress. Will have full report by next cycle.`,
      { latestIntel }
    );
  }
}

module.exports = PricingAgent;
