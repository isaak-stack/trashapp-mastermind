/**
 * core/gas-price.js — Live gas price from EIA
 * Fetches West Coast weekly retail regular grade and stores in Firestore.
 * Both rep-platform.html and quote.html read system_config/gas_price on load.
 */

const GAS_PRICE_FALLBACK = 4.60;
const EIA_SERIES_ID = 'EMM_EPM0_PTE_R50_DPG';
const EIA_API_KEY = process.env.EIA_API_KEY || 'DEMO';
const EIA_URL = `https://api.eia.gov/v2/petroleum/pri/gnd/data/?api_key=${EIA_API_KEY}&frequency=weekly&data[0]=value&facets[series][]=${EIA_SERIES_ID}&sort[0][column]=period&sort[0][direction]=desc&length=1&offset=0`;

async function fetchGasPrice() {
  try {
    const response = await fetch(EIA_URL);
    if (!response.ok) throw new Error(`EIA returned ${response.status}`);
    const json = await response.json();
    const latest = json?.response?.data?.[0];
    if (!latest?.value) throw new Error('No data in EIA response');
    const price = parseFloat(latest.value);
    if (isNaN(price) || price < 2 || price > 8) throw new Error(`Suspicious price: ${price}`);
    return { price, period: latest.period, source: 'EIA West Coast Weekly', fetched: new Date().toISOString() };
  } catch (err) {
    console.warn('[gas-price] Fetch failed:', err.message);
    return null;
  }
}

async function updateGasPrice(db, logger) {
  await logger.log('gas_price', 'INFO', 'Fetching gas price from EIA...');
  const result = await fetchGasPrice();
  if (!result) {
    await logger.log('gas_price', 'WARN', 'EIA fetch failed — price unchanged');
    return null;
  }
  try {
    await db.collection('system_config').doc('gas_price').set({
      value: result.price,
      period: result.period,
      source: result.source,
      fetchedAt: new Date(),
      updatedBy: 'mastermind_auto'
    });
    await logger.log('gas_price', 'SUCCESS', `Gas price updated: $${result.price}/gal (${result.period})`);
    return result.price;
  } catch (err) {
    await logger.log('gas_price', 'ERROR', `Firestore write failed: ${err.message}`);
    return null;
  }
}

module.exports = { fetchGasPrice, updateGasPrice, GAS_PRICE_FALLBACK };
