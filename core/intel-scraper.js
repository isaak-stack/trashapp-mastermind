/**
 * core/intel-scraper.js — Field sales intelligence scraper
 * Fetches signals from 5 sources: weather, estate sales, Craigslist (2x), and Fresno permits.
 * Uses Claude API to score and summarize signals by ZIP code.
 */

const axios = require('axios');
const cheerio = require('cheerio');
const { db } = require('./firestore');
const logger = require('./logger');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_AVAILABLE = !!ANTHROPIC_API_KEY;

if (CLAUDE_AVAILABLE) {
  console.log('✓ Claude API configured — intel scraper will use AI summaries');
} else {
  console.log('ℹ Intel scraper using simple scoring — add ANTHROPIC_API_KEY for AI analysis');
}

const FRESNO_ZIPS = [
  '93650', '93651', '93652', '93653', '93654', '93655', '93656', '93657', '93658', '93660',
  '93662', '93663', '93664', '93665', '93666', '93667', '93668', '93669', '93670', '93675',
];

/**
 * Main scraper function — fetch all signals and write to Firestore.
 */
async function scrapeIntel() {
  if (db._isMock) {
    await logger.log('intel-scraper', 'SUCCESS', 'Mock mode — skipping scrape', { icon: '🌐' });
    return;
  }

  try {
    const signals = {};

    // Initialize signals map for all Fresno ZIPs
    FRESNO_ZIPS.forEach((zip) => {
      signals[zip] = [];
    });

    await logger.log('intel-scraper', 'SUCCESS', 'Starting intel scrape...', { icon: '🌐' });

    // 1. Fetch weather
    try {
      const weather = await fetchOpenMeteoWeather();
      if (weather) {
        FRESNO_ZIPS.forEach((zip) => {
          signals[zip].push(...weather);
        });
      }
    } catch (err) {
      await logger.partial('intel-scraper', `Weather fetch failed: ${err.message}`, { error: err.message });
    }

    // 2. Fetch estate sales
    try {
      const estateSales = await fetchEstateSales();
      if (estateSales) {
        estateSales.forEach((sale) => {
          if (sale.zip && signals[sale.zip]) {
            signals[sale.zip].push(sale);
          }
        });
      }
    } catch (err) {
      await logger.partial('intel-scraper', `Estate sales fetch failed: ${err.message}`, { error: err.message });
    }

    // 3. Fetch Craigslist hauling/junk removal demand
    try {
      const craigslist = await fetchCraigslistHauling();
      if (craigslist) {
        FRESNO_ZIPS.forEach((zip) => {
          signals[zip].push(...craigslist);
        });
      }
    } catch (err) {
      await logger.partial('intel-scraper', `Craigslist hauling fetch failed: ${err.message}`, { error: err.message });
    }

    // 4. Fetch Craigslist free stuff
    try {
      const freeStuff = await fetchCraigslistFreeStuff();
      if (freeStuff) {
        FRESNO_ZIPS.forEach((zip) => {
          signals[zip].push(...freeStuff);
        });
      }
    } catch (err) {
      await logger.partial('intel-scraper', `Craigslist free stuff fetch failed: ${err.message}`, { error: err.message });
    }

    // 5. Fetch permits
    try {
      const permits = await fetchFresnoPermits();
      if (permits) {
        permits.forEach((permit) => {
          if (permit.zip && signals[permit.zip]) {
            signals[permit.zip].push(permit);
          }
        });
      }
    } catch (err) {
      await logger.partial('intel-scraper', `Fresno permits fetch failed: ${err.message}`, { error: err.message });
    }

    // Score and write to Firestore
    let written = 0;
    for (const [zip, zipSignals] of Object.entries(signals)) {
      if (zipSignals.length === 0) continue;

      let weekScore = 50; // Base score
      let rainDays = 0;
      let weatherDays = [];
      let topSignal = null;
      let claudeSummary = '';

      // Count signals and extract weather
      zipSignals.forEach((sig) => {
        if (sig.type === 'weather') {
          if (sig.rain) rainDays++;
          weatherDays.push(sig);
        } else if (sig.type === 'estate_sale') {
          weekScore += 5;
          if (!topSignal) topSignal = sig.address;
        } else if (sig.type === 'craigslist') {
          weekScore += 3;
        } else if (sig.type === 'permit') {
          weekScore += 2;
        }
      });

      weekScore -= rainDays * 10;
      weekScore = Math.max(0, Math.min(100, weekScore));

      // Call Claude API if available
      if (CLAUDE_AVAILABLE && zipSignals.length > 0) {
        try {
          const claudeResult = await callClaudeIntel(zip, zipSignals);
          if (claudeResult) {
            weekScore = claudeResult.weekScore;
            claudeSummary = claudeResult.claudeSummary;
            topSignal = claudeResult.topSignal;
          }
        } catch (err) {
          await logger.partial('intel-scraper', `Claude API failed for ZIP ${zip}: ${err.message}`, { error: err.message });
        }
      }

      // Write to Firestore
      await db.collection('zip_intel').doc(zip).set(
        {
          zipCode: zip,
          updatedAt: new Date().toISOString(),
          weekScore,
          weatherDays,
          rainDays,
          signals: zipSignals.slice(0, 20), // Limit to 20 signals per ZIP
          claudeSummary,
          topSignal,
          signalCount: zipSignals.length,
        },
        { merge: true }
      );

      written++;
    }

    await logger.success('intel-scraper', `Intel scrape complete — scored ${written} ZIPs`, {
      zipCount: written,
      icon: '🌐',
    });
  } catch (err) {
    await logger.error('intel-scraper', `Scrape error: ${err.message}`, { error: err.message });
  }
}

/**
 * Fetch 7-day weather forecast from Open-Meteo (free, no key required).
 */
async function fetchOpenMeteoWeather() {
  try {
    const res = await axios.get('https://api.open-meteo.com/v1/forecast', {
      params: {
        latitude: 36.7765,
        longitude: -119.8420,
        daily: 'precipitation,weather_code',
        forecast_days: 7,
        timezone: 'America/Los_Angeles',
      },
      timeout: 10000,
    });

    const data = res.data;
    if (!data.daily) return null;

    const signals = [];
    for (let i = 0; i < data.daily.precipitation.length; i++) {
      const rain = data.daily.precipitation[i] > 0;
      signals.push({
        type: 'weather',
        date: data.daily.time[i],
        precipitation: data.daily.precipitation[i],
        rain,
      });
    }

    return signals;
  } catch (err) {
    console.error('Open-Meteo fetch error:', err.message);
    return null;
  }
}

/**
 * Fetch estate sales from estatesales.net/CA/Fresno.
 */
async function fetchEstateSales() {
  try {
    const res = await axios.get('https://www.estatesales.net/CA/Fresno', {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    const $ = cheerio.load(res.data);
    const sales = [];

    $('div.sale-item, a.sale-link').each((i, elem) => {
      const title = $(elem).text() || $(elem).attr('title') || '';
      const address = title.split('|')[0]?.trim() || title;
      if (address && address.length > 5) {
        sales.push({
          type: 'estate_sale',
          address,
          zip: extractZipFromAddress(address),
          source: 'estatesales.net',
        });
      }
    });

    return sales.slice(0, 15); // Limit to 15 sales
  } catch (err) {
    console.error('Estate sales fetch error:', err.message);
    return null;
  }
}

/**
 * Fetch Craigslist hauling/junk removal posts.
 */
async function fetchCraigslistHauling() {
  try {
    const res = await axios.get('https://fresno.craigslist.org/search/hss', {
      params: { query: 'junk removal hauling' },
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    const $ = cheerio.load(res.data);
    const posts = [];

    $('li.cl-search-result').each((i, elem) => {
      const title = $(elem).find('.cl-search-result-title')?.text() || '';
      const location = $(elem).find('.cl-search-result-location')?.text() || '';
      if (title.length > 5) {
        posts.push({
          type: 'craigslist',
          title,
          location,
          source: 'craigslist_hauling',
        });
      }
    });

    return posts.slice(0, 10);
  } catch (err) {
    console.error('Craigslist hauling fetch error:', err.message);
    return null;
  }
}

/**
 * Fetch Craigslist "free stuff" posts (potential junk removal leads).
 */
async function fetchCraigslistFreeStuff() {
  try {
    const res = await axios.get('https://fresno.craigslist.org/search/zip', {
      params: { query: 'junk free' },
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    const $ = cheerio.load(res.data);
    const posts = [];

    $('li.cl-search-result').each((i, elem) => {
      const title = $(elem).find('.cl-search-result-title')?.text() || '';
      const location = $(elem).find('.cl-search-result-location')?.text() || '';
      if (title.length > 5) {
        posts.push({
          type: 'craigslist',
          title,
          location,
          source: 'craigslist_free',
        });
      }
    });

    return posts.slice(0, 10);
  } catch (err) {
    console.error('Craigslist free stuff fetch error:', err.message);
    return null;
  }
}

/**
 * Fetch permits from Fresno permit portal.
 */
async function fetchFresnoPermits() {
  try {
    const res = await axios.get('https://pdd.fresno.gov/permits/', {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    const $ = cheerio.load(res.data);
    const permits = [];

    $('tr').each((i, elem) => {
      const cells = $(elem).find('td');
      if (cells.length > 0) {
        const address = $(cells[0]).text()?.trim() || '';
        const type = $(cells[1])?.text()?.trim() || '';
        if (address.length > 5) {
          permits.push({
            type: 'permit',
            address,
            permitType: type,
            zip: extractZipFromAddress(address),
            source: 'fresno_permits',
          });
        }
      }
    });

    return permits.slice(0, 15);
  } catch (err) {
    console.error('Fresno permits fetch error:', err.message);
    return null;
  }
}

/**
 * Call Claude API to analyze signals and generate score + summary.
 */
async function callClaudeIntel(zipCode, signals) {
  try {
    const signalJson = JSON.stringify(signals.slice(0, 10));

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-1-20250805',
        max_tokens: 300,
        messages: [
          {
            role: 'user',
            content: `You are a field sales intelligence analyst for a junk removal company in Fresno, CA.

Given these signals for zip code ${zipCode} this week: ${signalJson}

Return ONLY valid JSON (no markdown, no explanation): { "weekScore": 0-100, "claudeSummary": "2 sentences max", "topSignal": "single most actionable lead text" }`,
          },
        ],
      }),
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || '{}';
    const clean = text.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);

    return {
      weekScore: Math.min(100, Math.max(0, result.weekScore || 50)),
      claudeSummary: (result.claudeSummary || '').substring(0, 200),
      topSignal: (result.topSignal || '').substring(0, 100),
    };
  } catch (err) {
    console.error('Claude API error:', err.message);
    return null;
  }
}

/**
 * Extract ZIP code from address string (naive implementation).
 */
function extractZipFromAddress(address) {
  const match = address.match(/\b9365\d\b/);
  return match ? match[0] : null;
}

module.exports = { scrapeIntel };
