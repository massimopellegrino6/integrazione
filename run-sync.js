import 'dotenv/config';
import axios from 'axios';

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-04';

const ELOGY_BASE_URL = process.env.ELOGY_BASE_URL || 'https://api.elogy.io/api';
const ELOGY_TOKEN = process.env.ELOGY_TOKEN;
const ELOGY_AUTH_MODE = process.env.ELOGY_AUTH_MODE || 'raw';
const DRY_RUN = String(process.env.DRY_RUN || 'false').toLowerCase() === 'true';

if (!SHOPIFY_STORE || !SHOPIFY_TOKEN) {
  throw new Error('Missing SHOPIFY_STORE or SHOPIFY_TOKEN');
}

if (!ELOGY_TOKEN) {
  throw new Error('Missing ELOGY_TOKEN');
}

function shopifyHeaders() {
  return {
    'X-Shopify-Access-Token': SHOPIFY_TOKEN,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

function elogyHeaders() {
  return {
    Authorization: ELOGY_AUTH_MODE === 'bearer' ? `Bearer ${ELOGY_TOKEN}` : ELOGY_TOKEN,
    Accept: 'application/json',
  };
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
  } catch {
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

async function getRecentShopifyOrders(limit = 250) {
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

async function getRecentElogyShippings() {
  const pageSize = 100;
  let offset = 0;
  let total = null;
  const allRows = [];

  while (total === null || offset < total) {
    const url = `${ELOGY_BASE_URL}/manageOrders`;
    const { data } = await axios.get(url, {
      headers: elogyHeaders(),
      params: {
        sort: 'created_at',
        sort_dir: 'desc',
        offset,
        length: pageSize,
      },
      timeout: 30000,
    });

    const rows = data?.data || data?.rows || data?.results || [];
    total = Number(data?.total || rows.length || 0);

    allRows.push(...rows);

    if (!rows.length) break;
    offset += pageSize;
    if (offset > 5000) break;
  }

  const normalized = allRows
    .map((row) => {
      const orderNumber = normalizeOrderName(
        row.order_number || row.order_name || row.order?.order_number || row.number || row.orderNumber
      );

      const trackingUrl = row.tracking_link || row.trackingUrl || null;
      const shippingNumber =
        row.ext_shipping_number ||
        row.shipment_id ||
        row.ddt_alpha ||
        row.shipping_number ||
        row.shippingNumber ||
        row.tracking_number ||
        extractShippingNumberFromUrl(trackingUrl) ||
        null;

      const carrier = normalizeCarrierName(
        row.carrier?.name || row.carrier_name || row.carrier_slug || row.carrier || null
      );

      const trackingStatus =
        row.tracking_status_name ||
        row.tracking_status ||
        row.status ||
        row.last_status ||
        null;

      return {
        raw: row,
        orderNumber,
        shippingNumber,
        trackingUrl,
        carrier,
        trackingStatus,
        status: row.status || row.last_status || null,
        externalFulfillmentId: row.external_fulfillment_id || null,
        externalOrderId: row.external_id || null,
      };
    })
    .filter((row) => row.orderNumber && row.shippingNumber);

  return normalized.slice(0, 50);
}

async function syncRecentTrackings() {
  const shippings = await getRecentElogyShippings();
  const results = [];

  for (const shipment of shippings) {
    const shippingNumber = shipment.shippingNumber || extractShippingNumberFromUrl(shipment.trackingUrl);
    const trackingUrl = shipment.trackingUrl;
    const carrier = normalizeCarrierName(shipment.carrier);

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

    if (!needsTrackingUpdate(fulfillment, { shippingNumber, trackingUrl, carrier })) {
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
      status: shipment.status || null,
      trackingStatus: shipment.trackingStatus || null,
      response: update,
    });
  }

  return results;
}

(async () => {
  try {
    console.log('Starting one-off sync job...');
    const results = await syncRecentTrackings();

    const summary = {
      ok: true,
      count: results.length,
      updated: results.filter((r) => r.updated).length,
      skipped: results.filter((r) => r.skipped).length,
    };

    console.log(JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(results, null, 2));

    process.exit(0);
  } catch (error) {
    console.error('Sync job failed');
    console.error(error?.response?.data || error?.stack || error?.message || error);
    process.exit(1);
  }
})();
