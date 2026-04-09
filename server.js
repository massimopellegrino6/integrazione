// MVP sync service: Elogy -> Shopify tracking updater
// Run with: node server.js
// Requires Node 18+
import 'dotenv/config';

import express from 'express';
import axios from 'axios';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE; // es: dd888q-k2.myshopify.com
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-04';

const ELOGY_BASE_URL = process.env.ELOGY_BASE_URL || 'https://api.elogy.io/api';
const ELOGY_TOKEN = process.env.ELOGY_TOKEN;
const ELOGY_AUTH_MODE = process.env.ELOGY_AUTH_MODE || 'raw'; // 'bearer' | 'raw'
const ELOGY_LOOKBACK_DAYS = Number(process.env.ELOGY_LOOKBACK_DAYS || 7);
const DRY_RUN = String(process.env.DRY_RUN || 'false').toLowerCase() === 'true';

if (!SHOPIFY_STORE || !SHOPIFY_TOKEN) {
  console.error('Missing SHOPIFY_STORE or SHOPIFY_TOKEN');
}

function shopifyHeaders() {
  return {
    'X-Shopify-Access-Token': SHOPIFY_TOKEN,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

function elogyHeaders() {
  if (!ELOGY_TOKEN) {
    throw new Error('Missing ELOGY_TOKEN');
  }
  return {
    Authorization: ELOGY_AUTH_MODE === 'bearer' ? `Bearer ${ELOGY_TOKEN}` : ELOGY_TOKEN,
    Accept: 'application/json',
  };
}

function isoDateDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function normalizeOrderName(input) {
  if (!input) return null;
  const s = String(input).trim();
  return s.startsWith('#') ? s : `#${s}`;
}

function extractShippingNumberFromUrl(url) {
  if (!url) return null;

  try {
    const parsed = new URL(url);
    const glsNum = parsed.searchParams.get('numsped');
    if (glsNum) return glsNum;

    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length > 0) return segments[segments.length - 1];
  } catch (_err) {
    const match = String(url).match(/(\d{8,})/);
    if (match) return match[1];
  }

  return null;
}

function normalizeCarrierName(carrier) {
  if (!carrier) return null;
  const c = String(carrier).trim().toLowerCase();
  if (c === 'gls') return 'GLS';
  if (c === 'liccardi') return 'Liccardi';
  return carrier;
}

async function getRecentShopifyOrders(limit = 50) {
  const url = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/orders.json`;
  const { data } = await axios.get(url, {
    headers: shopifyHeaders(),
    params: {
      status: 'any',
      limit,
      fields: 'id,name,fulfillment_status,fulfillments,created_at',
    },
    timeout: 30000,
  });
  return data.orders || [];
}

async function getShopifyOrderByName(orderName) {
  const wanted = normalizeOrderName(orderName);
  const orders = await getRecentShopifyOrders(250);
  return orders.find((o) => o.name === wanted) || null;
}

async function updateShopifyFulfillmentTracking(fulfillmentId, tracking) {
  const url = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/fulfillments/${fulfillmentId}/update_tracking.json`;
  const payload = {
    fulfillment: {
      notify_customer: false,
      tracking_info: {
        number: tracking.number,
        ...(tracking.company ? { company: tracking.company } : {}),
        ...(tracking.url ? { url: tracking.url } : {}),
      },
    },
  };

  if (DRY_RUN) {
    return { dryRun: true, fulfillmentId, payload };
  }

  const { data } = await axios.post(url, payload, {
    headers: shopifyHeaders(),
    timeout: 30000,
  });
  return data;
}

function extractTrackingFromShopifyFulfillment(fulfillment) {
  return {
    number: fulfillment?.tracking_number || null,
    company: fulfillment?.tracking_company || null,
    url: fulfillment?.tracking_url || null,
  };
}

function needsTrackingUpdate(fulfillment, elogyOrder) {
  const current = extractTrackingFromShopifyFulfillment(fulfillment);
  const desired = {
    number: elogyOrder.shippingNumber || extractShippingNumberFromUrl(elogyOrder.trackingUrl) || null,
    company: normalizeCarrierName(elogyOrder.carrier) || null,
    url: elogyOrder.trackingUrl || null,
  };

  if (!desired.number) return false;
  return (
    current.number !== desired.number ||
    current.company !== desired.company ||
    current.url !== desired.url
  );
}

// ---------------- ELOGY ----------------
// NOTE:
// This function uses the data shape that we verified manually in your tests.
// If Elogy returns a slightly different payload in production, adapt the mapping below.
async function getRecentElogyShippings() {
  const url = `${ELOGY_BASE_URL}/shipped`;
  const { data } = await axios.get(url, {
    headers: elogyHeaders(),
    params: {
      offset: 0,
      length: 100,
      from_date: isoDateDaysAgo(ELOGY_LOOKBACK_DAYS),
      to_date: '',
      from_created_at: '',
      to_created_at: '',
      gateway: '',
      text: '',
    },
    timeout: 30000,
  });

  console.log('ELOGY SHIPPED RAW RESPONSE:');
  console.dir(data, { depth: null });

  const rows = data?.data || data?.rows || data?.results || [];
  console.log('ELOGY SHIPPED ROWS COUNT:', rows.length);

  const normalized = rows
    .map((row) => {
      const orderNumber = normalizeOrderName(
        row.order_number || row.order_name || row.order?.order_number || row.number || row.orderNumber
      );

      const shippingNumber =
        row.ext_shipping_number ||
        row.shipment_id ||
        row.ddt_alpha ||
        row.shipping_number ||
        row.shippingNumber ||
        row.tracking_number ||
        extractShippingNumberFromUrl(row.tracking_link || row.trackingUrl) ||
        null;

      const trackingUrl = row.tracking_link || row.trackingUrl || null;
      const carrier = normalizeCarrierName(
        row.carrier?.name || row.carrier_name || row.carrier_slug || row.carrier || null
      );
      const trackingStatus = row.tracking_status || row.status || row.last_status || null;

      return {
        raw: row,
        orderNumber,
        shippingNumber,
        trackingUrl,
        carrier,
        trackingStatus,
        externalFulfillmentId: row.external_fulfillment_id || null,
        externalOrderId: row.external_id || null,
      };
    })
    .filter((row) => row.orderNumber && row.shippingNumber);

  return {
    raw: data,
    rowsCount: rows.length,
    normalized,
  };
}

async function syncRecentTrackings() {
  const elogy = await getRecentElogyShippings();
  const shippings = elogy.normalized || [];
  const results = [];

  for (const shipment of shippings) {
    const shippingNumber = shipment.shippingNumber || extractShippingNumberFromUrl(shipment.trackingUrl);
    const trackingUrl = shipment.trackingUrl;
    const carrier = normalizeCarrierName(shipment.carrier);

    console.log('SYNC CHECK', {
      orderNumber: shipment.orderNumber,
      shippingNumber,
      trackingUrl,
      carrier,
    });

    if (!shipment.orderNumber || !shippingNumber) {
      results.push({
        orderNumber: shipment.orderNumber,
        skipped: true,
        reason: 'missing_tracking_data',
      });
      continue;
    }

    const order = await getShopifyOrderByName(shipment.orderNumber);
    if (!order) {
      results.push({
        orderNumber: shipment.orderNumber,
        skipped: true,
        reason: 'shopify_order_not_found',
      });
      continue;
    }

    const fulfillment = order.fulfillments?.[0];
    if (!fulfillment) {
      results.push({
        orderNumber: shipment.orderNumber,
        shopifyOrderId: order.id,
        skipped: true,
        reason: 'no_fulfillment_found',
      });
      continue;
    }

    if (!needsTrackingUpdate(fulfillment, {
      shippingNumber,
      trackingUrl,
      carrier,
    })) {
      results.push({
        orderNumber: shipment.orderNumber,
        shopifyOrderId: order.id,
        fulfillmentId: fulfillment.id,
        skipped: true,
        reason: 'already_synced_or_incomplete',
      });
      continue;
    }

    const update = await updateShopifyFulfillmentTracking(fulfillment.id, {
      number: shippingNumber,
      company: carrier,
      url: trackingUrl,
    });

    results.push({
      orderNumber: shipment.orderNumber,
      shopifyOrderId: order.id,
      fulfillmentId: fulfillment.id,
      updated: true,
      trackingNumber: shippingNumber,
      trackingUrl,
      carrier,
      response: update,
    });
  }

  return results;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, dryRun: DRY_RUN });
});

app.post('/sync', async (_req, res) => {
  try {
    const results = await syncRecentTrackings();
    res.json({ ok: true, count: results.length, results });
  } catch (error) {
    console.error(error?.response?.data || error.message);
    res.status(500).json({
      ok: false,
      error: error.message,
      details: error?.response?.data || null,
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Elogy-Shopify sync listening on http://0.0.0.0:${PORT}`);
});
