import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import chromium from '@sparticuz/chromium-min';
import puppeteer from 'puppeteer-core';
import nodemailer from 'nodemailer';

const CHROMIUM_PACK = 'https://github.com/Sparticuz/chromium/releases/download/v127.0.0/chromium-v127.0.0-pack.tar';

initializeApp();
const db = getFirestore();

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const WEBHOOK_SECRET   = process.env.WEBHOOK_SECRET   || 'change-me-in-env';
const GMAIL_USER       = process.env.GMAIL_USER       || '';
const GMAIL_PASS       = process.env.GMAIL_APP_PASSWORD || '';
const BAD_HANDLING_SEC = 60000;

const RECIPIENTS = {
  sales:      (process.env.SALES_RECIPIENTS      || '').split(',').map(s => s.trim()).filter(Boolean),
  logistics:  (process.env.LOGISTICS_RECIPIENTS  || '').split(',').map(s => s.trim()).filter(Boolean),
  activation: (process.env.ACTIVATION_RECIPIENTS || '').split(',').map(s => s.trim()).filter(Boolean),
  management: (process.env.MANAGEMENT_RECIPIENTS || '').split(',').map(s => s.trim()).filter(Boolean),
};

const TEST_RECIPIENT = 'ali.mohsen@bh.zain.com';

const WORKING_HOURS = {
  sales: { start: 9, end: 22 },
  logistics: { start: 9, end: 20 },
  activation: { start: 9, end: 22 },
};

const ACTIVE_COLS = [
  'ORDER_CREATION_DATE',
  'ORDER_CREATION_time',
  'HOURS_TYPE',
  'CHANNEL_ORDER_NO',
  'CHANNEL',
  'ESHOP_ORDER_STATUS',
  'DEVICE_STATUS_REASON1',
  'DEVICE_SERVICE1',
  'PLAN_STATUS_REASON1',
  'NEW_EXISTING_FLAG1',
  'PLAN_PACKAGE1',
  'SALES_CLAIM_DATE_FIRST',
  'SALES_CLAIM_TIME_FIRST',
  'SALES_USER_FIRST',
  'LOGISTICS_ASSIGN_DATE_1',
  'LOGISTICS_ASSIGN_TIME_1',
];

// ─── CSV PARSER ───────────────────────────────────────────────────────────────
function detectDelimiter(sample) {
  const counts = { ',': 0, '\t': 0, ';': 0, '|': 0 };
  for (const c of sample) if (c in counts) counts[c]++;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim());
  if (!lines.length) return { headers: [], rows: [] };

  const delim = detectDelimiter(lines[0]);
  const parseRow = (line) => {
    const fields = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else { inQ = !inQ; }
      } else if (ch === delim && !inQ) {
        fields.push(cur.trim()); cur = '';
      } else {
        cur += ch;
      }
    }
    fields.push(cur.trim());
    return fields;
  };

  const headers = parseRow(lines[0]).map(h => h.replace(/^\ufeff/, '').trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseRow(lines[i]);
    if (vals.every(v => !v)) continue;
    const row = {};
    headers.forEach((h, idx) => { row[h] = vals[idx] ?? ''; });
    rows.push(row);
  }
  return { headers, rows };
}

// ─── DATE/TIME HELPERS ───────────────────────────────────────────────────────
function parseDateTime(dateStr, timeStr) {
  if (!dateStr) return null;
  dateStr = dateStr.trim();
  timeStr = (timeStr || '').trim();

  const spaceIdx = dateStr.indexOf(' ');
  if (spaceIdx > 0) {
    if (!timeStr) timeStr = dateStr.slice(spaceIdx + 1).trim();
    dateStr = dateStr.slice(0, spaceIdx);
  }

  const ampmMatch = timeStr.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])$/);
  if (ampmMatch) {
    let h = parseInt(ampmMatch[1], 10);
    const m = ampmMatch[2], s = ampmMatch[3] || '00', ampm = ampmMatch[4].toUpperCase();
    if (ampm === 'AM' && h === 12) h = 0;
    if (ampm === 'PM' && h !== 12) h += 12;
    timeStr = `${String(h).padStart(2, '0')}:${m}:${s}`;
  }

  if (/^\d{1,2}:\d{2}$/.test(timeStr)) timeStr += ':00';

  let d = new Date(`${dateStr}T${timeStr || '00:00:00'}`);
  if (!isNaN(d)) return d;

  const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const monMatch = dateStr.match(/^(\d{1,2})[\/\-\s]([A-Za-z]{3,})[\/\-\s](\d{2,4})$/);
  if (monMatch) {
    const monNum = MON[monMatch[2].slice(0, 3).toLowerCase()];
    if (monNum) {
      const day = parseInt(monMatch[1], 10);
      const yr = parseInt(monMatch[3], 10);
      const iso = `${yr < 100 ? 2000 + yr : yr}-${String(monNum).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      d = new Date(`${iso}T${timeStr || '00:00:00'}`);
      if (!isNaN(d)) return d;
    }
  }

  const parts = dateStr.split(/[\/\-\.]/);
  if (parts.length === 3) {
    const raw = parts.map(Number);
    if (!raw.some(isNaN)) {
      let [a, b, c] = raw;
      let iso;
      if (a > 31) iso = `${a}-${String(b).padStart(2, '0')}-${String(c).padStart(2, '0')}`;
      else if (a > 12) iso = `${c < 100 ? 2000 + c : c}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`;
      else iso = `${c < 100 ? 2000 + c : c}-${String(a).padStart(2, '0')}-${String(b).padStart(2, '0')}`;
      d = new Date(`${iso}T${timeStr || '00:00:00'}`);
      if (!isNaN(d)) return d;
    }
  }
  return null;
}

function diffSeconds(dtA, dtB) {
  if (!dtA || !dtB) return null;
  const diff = (dtB - dtA) / 1000;
  return diff >= 0 ? diff : null;
}

function avgArr(arr) {
  const valid = arr.filter(v => v != null && !isNaN(v));
  if (!valid.length) return null;
  return valid.reduce((s, v) => s + v, 0) / valid.length;
}

function getEffectiveSalesStartTime(orderDT, hoursType) {
  if (!orderDT) return null;
  const isNonWorking = (hoursType || '').toLowerCase().includes('non');
  if (isNonWorking) {
    const next9AM = new Date(orderDT);
    next9AM.setDate(next9AM.getDate() + 1);
    next9AM.setHours(9, 0, 0, 0);
    return next9AM;
  }
  return orderDT;
}

function getEffectiveStartTime(assignDT, department) {
  if (!assignDT) return null;
  const config = WORKING_HOURS[department];
  if (!config) return assignDT;
  const hour = assignDT.getHours();
  if (hour < config.start) {
    const sameDay9AM = new Date(assignDT);
    sameDay9AM.setHours(config.start, 0, 0, 0);
    return sameDay9AM;
  }
  if (hour >= config.end) {
    const nextDay9AM = new Date(assignDT);
    nextDay9AM.setDate(nextDay9AM.getDate() + 1);
    nextDay9AM.setHours(config.start, 0, 0, 0);
    return nextDay9AM;
  }
  return assignDT;
}

function getRowAgentName(row) {
  return (row['SALESMAN_ID'] || row['SALES_USER_FIRST'] || row['LOGISTICS_USER_FIRST'] || row['LOGISTICS_USER_LAST'] || row['DELIVERY_USER'] || row['ACTIVATION_USER'] || '').trim();
}

function extractAllAgentsFromRow(row) {
  const agents = [];
  // Portal orders (manually created) use LOG_USER as the creator, not SALES_USER_FIRST
  const isPortal = (row['CHANNEL'] || '').trim().toLowerCase() === 'portal';
  const salesAgent = isPortal
    ? (row['LOG_USER'] || row['SALES_USER_FIRST'] || row['SALESMAN_ID'] || '').trim()
    : (row['SALES_USER_FIRST'] || row['SALESMAN_ID'] || '').trim();
  if (salesAgent) agents.push({ agentCode: salesAgent, agentType: 'sales' });
  const logisticsAgent = (row['LOGISTICS_USER_FIRST'] || row['LOGISTICS_USER_LAST'] || '').trim();
  if (logisticsAgent) agents.push({ agentCode: logisticsAgent, agentType: 'logistics' });
  const activationAgent = (row['ACTIVATION_USER'] || '').trim();
  if (activationAgent) agents.push({ agentCode: activationAgent, agentType: 'activation' });
  const deliveryAgent = (row['DELIVERY_USER'] || '').trim();
  if (deliveryAgent) agents.push({ agentCode: deliveryAgent, agentType: 'logistics' });
  return agents;
}

function processRows(rows) {
  const agentMap = {};
  rows.forEach(row => {
    const agent = getRowAgentName(row);
    if (!agent) return;
    if (!agentMap[agent]) agentMap[agent] = { name: agent, orders: [] };
    const orderDT = parseDateTime(row['ORDER_CREATION_DATE_TIME1'] || row['ORDER_CREATION_DATE'], row['ORDER_CREATION_time']);
    const claimDT = parseDateTime(row['SALES_CLAIM_DATE_FIRST'], row['SALES_CLAIM_TIME_FIRST']);
    const assignDT = parseDateTime(row['LOGISTICS_ASSIGN_DATE_1'], row['LOGISTICS_ASSIGN_TIME_1']);
    const claimed = !!claimDT;
    const claimTimeSec = diffSeconds(orderDT, claimDT);
    const assignTimeSec = diffSeconds(claimDT, assignDT);
    agentMap[agent].orders.push({ orderNo: row['CHANNEL_ORDER_NO'] || '', channel: row['CHANNEL'] || '', status: row['ESHOP_ORDER_STATUS'] || '', hoursType: row['HOURS_TYPE'] || '', claimed, claimTimeSec, assignTimeSec, orderDT });
  });
  return Object.values(agentMap).map(a => {
    const claimTimes = a.orders.map(o => o.claimTimeSec).filter(v => v != null && v >= 0 && v < 86400);
    const assignTimes = a.orders.map(o => o.assignTimeSec).filter(v => v != null && v >= 0 && v < 86400);
    return {
      name: a.name,
      role: a.name,
      initials: a.name.split(/\s+/).map(p => p[0]).join('').slice(0, 2).toUpperCase(),
      total: a.orders.length,
      claimed: a.orders.filter(o => o.claimed).length,
      claimTimeSec: Math.round(avgArr(claimTimes) ?? 0),
      assignTimeSec: Math.round(avgArr(assignTimes) ?? 0),
    };
  }).sort((a, b) => b.total - a.total);
}

function computeSummary(agents, rows) {
  const totalOrders = rows.length;
  const totalClaimed = agents.reduce((s, a) => s + a.claimed, 0);
  const avgClaim = Math.round(avgArr(agents.map(a => a.claimTimeSec).filter(v => v > 0)) ?? 0);
  const avgAssign = Math.round(avgArr(agents.map(a => a.assignTimeSec).filter(v => v > 0)) ?? 0);
  const dates = rows.map(r => parseDateTime(r['ORDER_CREATION_DATE'], r['ORDER_CREATION_time'])).filter(Boolean).sort((a, b) => a - b);
  const dateFrom = dates[0] ? dates[0].toLocaleDateString() : '—';
  const dateTo = dates.at(-1) ? dates.at(-1).toLocaleDateString() : '—';
  const salesAgents = agents.filter(a => a.agentType === 'sales' || !a.agentType).length;
  const logisticsAgents = agents.filter(a => a.agentType === 'logistics').length;
  const activationAgents = agents.filter(a => a.agentType === 'activation').length;
  return { totalOrders, totalClaimed, avgClaimTimeSec: avgClaim, avgAssignTimeSec: avgAssign, dateFrom, dateTo, salesAgents, logisticsAgents, activationAgents };
}

// ─── REPORT PERIOD LOGIC ─────────────────────────────────────────────────────
function getReportPeriod() {
  const now = new Date();
  const day = now.getDate();
  let from, to;

  if (day === 1) {
    // 1st of month → send full previous month
    from = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0);
    to   = new Date(now.getFullYear(), now.getMonth(),     0, 23, 59, 59);
  } else {
    // 2nd+ → current month from 1st to today
    from = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
    to   = new Date(now.getFullYear(), now.getMonth(), day, 23, 59, 59);
  }

  const fmt = d => d.toLocaleDateString('en-GB'); // DD/MM/YYYY
  return { from, to, label: `${fmt(from)} – ${fmt(to)}` };
}

// ─── FIRESTORE BATCH HELPERS ─────────────────────────────────────────────────
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function commitWithRetry(batch) {
  let retries = 0;
  while (true) {
    try {
      await batch.commit();
      return;
    } catch (err) {
      if (err?.code === 'resource-exhausted' && retries < 2) {
        retries++;
        await delay(1000 * Math.pow(2, retries));
      } else {
        throw err;
      }
    }
  }
}

async function processInChunks(collectionName, rows, rowProcessor, BATCH_SIZE = 450, BATCH_DELAY = 50) {
  let processedCount = 0;
  let batch = db.batch();
  let batchCount = 0;
  const totalCount = rows.length;

  for (let i = 0; i < rows.length; i++) {
    const order = rowProcessor(rows[i]);
    if (!order) continue;
    const docRef = db.collection(collectionName).doc(order.orderNo);
    batch.set(docRef, order, { merge: true });
    batchCount++;
    processedCount++;

    if (batchCount >= BATCH_SIZE) {
      await commitWithRetry(batch);
      batch = db.batch();
      batchCount = 0;
      if (i < rows.length - 1) await delay(BATCH_DELAY);
    }
  }
  if (batchCount > 0) {
    await commitWithRetry(batch);
  }
  return processedCount;
}

// ─── REPORT HELPERS ──────────────────────────────────────────────────────────
function fmtTime(sec) {
  if (sec == null || isNaN(sec)) return '—';
  if (sec < 60)   return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

function safeAvg(arr) {
  const v = arr.filter(x => x != null && !isNaN(x));
  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
}

// ─── SHARED STATS BUILDER ─────────────────────────────────────────────────────
// Used by both sendAllReports (auto email) and downloadPDF (Save as PDF).
function statsFromDocs(docs, timeField) {
  const map = {};
  docs.forEach(d => {
    const data = d.data();
    const agent = data.agentName || '';
    if (!agent) return;
    if (!map[agent]) map[agent] = { orders: 0, claimed: 0, times: [], badCount: 0, assignTimes: [], portalOrders: 0 };
    map[agent].orders++;
    // Track portal orders separately (channel = 'Portal' or 'PORTAL')
    const channel = (data.channel || '').toLowerCase();
    if (channel === 'portal') {
      map[agent].portalOrders++;
    }
    if (data.claimed) {
      map[agent].claimed++;
      const t = data[timeField];
      if (t != null && t >= 0) {
        if (t >= BAD_HANDLING_SEC) map[agent].badCount++;
        else map[agent].times.push(t);
      }
      // Also track assign time (handle time) for sales
      const assignT = data.assignTimeSec || data.logisticsAssignTimeSec;
      if (assignT != null && assignT >= 0 && assignT < BAD_HANDLING_SEC) {
        map[agent].assignTimes.push(assignT);
      }
    }
  });
  return Object.entries(map).map(([name, d]) => ({
    name,
    orders:      d.orders,
    claimed:     d.claimed,
    portalOrders: d.portalOrders,
    rate:        d.orders ? Math.round(d.claimed / d.orders * 100) : 0,
    avgTime:     safeAvg(d.times),
    avgHandleTime: safeAvg(d.assignTimes),
    badHandling: d.badCount,
  })).sort((a, b) => b.orders - a.orders);
}

function buildSalesStats(rows) {
  const map = {};
  rows.forEach(row => {
    const agent = (row['SALES_USER_FIRST'] || row['SALESMAN_ID'] || '').trim();
    if (!agent) return;
    if (!map[agent]) map[agent] = { orders: 0, claimed: 0, times: [] };
    const odt = parseDateTime(row['ORDER_CREATION_DATE_TIME1'] || row['ORDER_CREATION_DATE'], row['ORDER_CREATION_time']);
    const cdt = parseDateTime(row['SALES_CLAIM_DATE_FIRST'], row['SALES_CLAIM_TIME_FIRST']);
    const eff = getEffectiveSalesStartTime(odt, row['HOURS_TYPE']);
    const t   = diffSeconds(eff, cdt);
    map[agent].orders++;
    if (cdt) {
      map[agent].claimed++;
      if (t != null && t >= 0 && t < BAD_HANDLING_SEC) map[agent].times.push(t);
    }
  });
  return Object.entries(map).map(([name, d]) => ({
    name,
    orders:   d.orders,
    claimed:  d.claimed,
    rate:     d.orders ? Math.round(d.claimed / d.orders * 100) : 0,
    avgTime:  safeAvg(d.times),
  })).sort((a, b) => b.orders - a.orders);
}

function buildLogisticsStats(rows) {
  const map = {};
  rows.forEach(row => {
    const agent = (row['LOGISTICS_USER_FIRST'] || row['LOGISTICS_USER_LAST'] || '').trim();
    if (!agent) return;
    if (!map[agent]) map[agent] = { orders: 0, claimed: 0, times: [] };
    const adt = parseDateTime(row['LOGISTICS_ASSIGN_DATE_1'], row['LOGISTICS_ASSIGN_TIME_1']);
    const cdt = parseDateTime(row['LOGISTICS_CLAIM_DATE_FIRST'], row['LOGISTICS_CLAIM_TIME_FIRST']);
    const eff = getEffectiveStartTime(adt, 'logistics');
    const t   = diffSeconds(eff, cdt);
    map[agent].orders++;
    if (cdt) {
      map[agent].claimed++;
      if (t != null && t >= 0 && t < BAD_HANDLING_SEC) map[agent].times.push(t);
    }
  });
  return Object.entries(map).map(([name, d]) => ({
    name,
    orders:  d.orders,
    claimed: d.claimed,
    rate:    d.orders ? Math.round(d.claimed / d.orders * 100) : 0,
    avgTime: safeAvg(d.times),
  })).sort((a, b) => b.orders - a.orders);
}

function buildActivationStats(rows) {
  const map = {};
  rows.forEach(row => {
    const agent = (row['ACTIVATION_USER'] || '').trim();
    if (!agent) return;
    if (!map[agent]) map[agent] = { orders: 0, claimed: 0, times: [] };
    const adt = parseDateTime(row['ACTIVATION_ASSIGN_DATE'], row['ACTIVATION_ASSIGN_TIME']);
    const cdt = parseDateTime(row['ACTIVATION_CLAIM_DATE'],  row['ACTIVATION_CLAIM_TIME']);
    const t   = diffSeconds(adt, cdt);
    map[agent].orders++;
    if (cdt) {
      map[agent].claimed++;
      if (t != null && t >= 0 && t < BAD_HANDLING_SEC) map[agent].times.push(t);
    }
  });
  return Object.entries(map).map(([name, d]) => ({
    name,
    orders:  d.orders,
    claimed: d.claimed,
    rate:    d.orders ? Math.round(d.claimed / d.orders * 100) : 0,
    avgTime: safeAvg(d.times),
  })).sort((a, b) => b.orders - a.orders);
}

// ─── PDF FROM LIVE APP ───────────────────────────────────────────────────────
// Puppeteer navigates to the actual deployed app and generates the PDF the same
// way the browser does when the user clicks "Save as PDF" (window.print()).
// This guarantees the emailed PDF is pixel-identical to the in-app print view.
const FIREBASE_WEB_API_KEY = 'AIzaSyBC9TKA8shfMD64qfQPJJ3DvdC7hbkxamc';
const APP_BASE_URL         = 'https://performer-2df35.web.app';

// Sign in as the dedicated PDF renderer Firebase user using email/password.
// This avoids createCustomToken() which requires the iam.serviceAccounts.signBlob
// IAM permission that is often missing on the default Cloud Functions service account.
const PDF_RENDERER_EMAIL    = 'pdf-renderer@performer-2df35.firebaseapp.com';
const PDF_RENDERER_PASSWORD = process.env.PDF_RENDERER_PASSWORD || 'Tpw_Pdf_R3nd3r_2df35!';

async function getAuthStateForPuppeteer() {
  // Ensure the dedicated renderer account exists (creates it on first run)
  try {
    await getAuth().getUserByEmail(PDF_RENDERER_EMAIL);
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      await getAuth().createUser({
        email:       PDF_RENDERER_EMAIL,
        password:    PDF_RENDERER_PASSWORD,
        displayName: 'PDF Renderer Service',
      });
      console.log('[getAuthStateForPuppeteer] created pdf-renderer user');
    } else {
      throw err;
    }
  }

  // Sign in via REST API — no signBlob permission required
  const resp = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_WEB_API_KEY}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email: PDF_RENDERER_EMAIL, password: PDF_RENDERER_PASSWORD, returnSecureToken: true }),
    }
  );
  if (!resp.ok) throw new Error(`PDF renderer sign-in failed: ${await resp.text()}`);
  const { idToken, refreshToken, localId, expiresIn } = await resp.json();
  return {
    uid: localId, email: PDF_RENDERER_EMAIL, emailVerified: false, displayName: 'PDF Renderer Service',
    isAnonymous: false, photoURL: null, phoneNumber: null, tenantId: null,
    providerData: [],
    stsTokenManager: {
      refreshToken,
      accessToken: idToken,
      expirationTime: Date.now() + parseInt(expiresIn, 10) * 1000,
    },
    createdAt:   String(Date.now()),
    lastLoginAt: String(Date.now()),
    apiKey:  FIREBASE_WEB_API_KEY,
    appName: '[DEFAULT]',
  };
}

// Navigate a Puppeteer page to a path, wait for the data to load, print as PDF.
async function renderAndPrint(page, path, waitSelector) {
  await page.goto(`${APP_BASE_URL}${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // Wait for the loading spinner to disappear (data has loaded from Firestore)
  await page.waitForFunction(() => !document.querySelector('.spinner-lg'), { timeout: 30000 });
  if (waitSelector) {
    await page.waitForSelector(waitSelector, { timeout: 15000 }).catch(() => {});
  }
  await new Promise(r => setTimeout(r, 1200)); // stabilisation
  const buf = await page.pdf({
    format:          'A4',
    landscape:       true,
    printBackground: true,
    margin: { top: '8mm', right: '10mm', bottom: '8mm', left: '10mm' },
  });
  return Buffer.from(buf);
}

// Launch one browser, generate all four department PDFs by navigating to the
// actual live app pages — identical to what "Save as PDF" produces per page.
async function buildAllDeptPDFs(period) {
  console.log('[buildAllDeptPDFs] starting for period:', period.label);
  const authState = await getAuthStateForPuppeteer();
  const fromStr   = period.from.toISOString().slice(0, 10);
  const toStr     = period.to.toISOString().slice(0, 10);
  const authKey   = `firebase:authUser:${FIREBASE_WEB_API_KEY}:[DEFAULT]`;

  const executablePath = await chromium.executablePath(CHROMIUM_PACK);
  const browser = await puppeteer.launch({
    args:            chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath,
    headless:        chromium.headless,
  });
  try {
    const pg = await browser.newPage();

    // Inject Firebase auth + custom date range into localStorage before every
    // page navigation, so ProtectedRoute passes and the correct period is shown.
    await pg.evaluateOnNewDocument((key, val, from, to) => {
      localStorage.setItem(key, val);
      localStorage.setItem('tpw_filter_range', 'custom');
      localStorage.setItem('tpw_filter_from', from);
      localStorage.setItem('tpw_filter_to',   to);
    }, authKey, JSON.stringify(authState), fromStr, toStr);

    console.log('[buildAllDeptPDFs] rendering Sales (/performance)...');
    const salesPDF      = await renderAndPrint(pg, '/performance', '.table-wrap');
    console.log('[buildAllDeptPDFs] rendering Logistics (/logistics)...');
    const logisticsPDF  = await renderAndPrint(pg, '/logistics',   '.table-wrap');
    console.log('[buildAllDeptPDFs] rendering Activation (/activation)...');
    const activationPDF = await renderAndPrint(pg, '/activation',  '.table-wrap');
    console.log('[buildAllDeptPDFs] rendering Management (/dashboard)...');
    const managementPDF = await renderAndPrint(pg, '/dashboard',   '.hero-badge');

    console.log('[buildAllDeptPDFs] all 4 PDFs rendered successfully');
    return { salesPDF, logisticsPDF, activationPDF, managementPDF };
  } catch (err) {
    console.error('[buildAllDeptPDFs] Puppeteer render failed:', err.message, err.stack);
    throw err;
  } finally {
    await browser.close();
  }
}

// ─── LEGACY TEMPLATE PDF (used only by downloadPDF endpoint) ─────────────────
function buildPDFHtml({ title, department, dateRange, kpis, columns, rows: tableRows, slaSeconds }) {
  const generatedAt = new Date().toLocaleString('en-GB');
  const slaSec = slaSeconds || 7200;

  const kpiCards = kpis.map(k => {
    const exceeded = k.exceeded === true;
    const valClass = exceeded ? 'hero-kpi-value sla-exceeded' : 'hero-kpi-value';
    const badgeClass = exceeded ? 'hero-kpi-badge sla-exceeded' : 'hero-kpi-badge';
    const iconBg = exceeded ? 'rgba(231,76,60,0.15)' : 'rgba(216,245,236,0.08)';
    return `
    <div class="hero-kpi">
      <div class="hero-kpi-icon" style="background:${iconBg}"></div>
      <div class="${valClass}">${k.value}</div>
      <div class="hero-kpi-label">${k.label}</div>
      <span class="${badgeClass}">${k.badge || ''}</span>
    </div>`;
  }).join('');

  const ths = columns.map((c, i) => {
    const radius = i === 0 ? 'border-radius:8px 0 0 0' : i === columns.length - 1 ? 'border-radius:0 8px 0 0' : '';
    const pl = i === 0 ? 'padding-left:16px;' : '';
    return `<th style="${pl}${radius}">${c}</th>`;
  }).join('');

  const trs = tableRows.map((row, idx) => {
    const evenBg = idx % 2 === 1 ? 'background:#f9fafb' : '';
    // row is either a flat array (management section headers) or an object
    if (Array.isArray(row)) {
      const tds = row.map((cell, ci) => {
        const pl = ci === 0 ? 'padding-left:16px;' : '';
        return `<td style="${evenBg};${pl}">${cell ?? '—'}</td>`;
      }).join('');
      return `<tr>${tds}</tr>`;
    }
    // structured agent row
    const timeExceeded = row.avgTime != null && row.avgTime > slaSec;
    const timeCls  = timeExceeded ? 'num-cell sla-exceeded' : 'num-cell';
    const timeVal  = fmtTime(row.avgTime);
    const timeTxt  = timeExceeded ? `${timeVal} <span style="font-size:9px;opacity:0.8">(SLA)</span>` : timeVal;
    const badVal   = row.badHandling || 0;
    const badTxt   = badVal > 0 ? `<span class="sla-exceeded">${badVal}</span>` : `<span style="color:#6b7280">0</span>`;
    return `<tr>
      <td style="padding-left:16px;${evenBg}">
        <div style="display:flex;align-items:center;gap:8px">
          <div class="agent-avatar">${row.name.slice(0,2).toUpperCase()}</div>
          <span class="agent-name">${row.name}</span>
        </div>
      </td>
      <td class="num-cell" style="${evenBg}">${row.orders.toLocaleString()}</td>
      <td class="num-cell" style="${evenBg}">${row.claimed.toLocaleString()}</td>
      <td class="num-cell" style="${evenBg}">${row.rate}%</td>
      <td class="${timeCls}" style="${evenBg}">${timeTxt}</td>
      <td class="num-cell" style="${evenBg}">${badTxt}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><style>
  @page { size: A4 landscape; margin: 8mm 10mm; }
  *, *::before, *::after {
    box-sizing: border-box; margin: 0; padding: 0;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  body {
    background: #ffffff; color: #111827;
    font-family: 'Segoe UI', system-ui, -apple-system, Arial, sans-serif;
    font-size: 10px;
  }

  /* ── PAGE HEADER ── */
  .page-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 0 0 10px 0; margin-bottom: 14px;
    border-bottom: 3px solid #111827;
  }
  .print-period-line {
    font-size: 16px; font-weight: 700; color: #111827;
    letter-spacing: -0.3px; line-height: 1.2;
  }
  .print-generated {
    display: flex; flex-direction: column; align-items: flex-end;
    font-size: 10px; color: #9ca3af; line-height: 1.7; text-align: right;
  }
  .print-generated strong { color: #374151; font-size: 10px; }

  /* ── HERO BADGE / KPI SECTION ── */
  .hero-badge { margin-bottom: 14px; }
  .hero-badge-label {
    font-size: 13px; font-weight: 700; color: #111827;
    margin-bottom: 8px; padding-bottom: 4px;
    border-bottom: 1px solid #e5e7eb;
    display: flex; align-items: center; gap: 6px;
  }
  .dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: #059669; flex-shrink: 0; display: inline-block;
  }
  .hero-kpis { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; }
  .hero-kpi {
    background: #f9fafb; border: 1px solid #e5e7eb;
    border-radius: 8px; padding: 10px;
  }
  .hero-kpi-icon {
    width: 22px; height: 22px; border-radius: 6px; margin-bottom: 6px;
  }
  .hero-kpi-value { color: #111827; font-size: 18px; font-weight: 700; }
  .hero-kpi-label { color: #6b7280; font-size: 9px; margin-bottom: 4px; }
  .hero-kpi-badge {
    background: #f3f4f6; color: #374151;
    font-size: 8px; padding: 1px 5px; border-radius: 20px;
    display: inline-block;
  }

  /* ── SECTION HEADER ── */
  .section-header {
    margin-bottom: 8px; padding-bottom: 4px;
    border-bottom: 1px solid #e5e7eb;
  }
  .section-title { font-size: 13px; font-weight: 700; color: #111827; }
  .section-sub   { font-size: 9px; color: #6b7280; }

  /* ── TABLE ── */
  .table-wrap {
    background: #ffffff; border: 1px solid #e5e7eb;
    border-radius: 8px; overflow: hidden;
  }
  table { width: 100%; border-collapse: collapse; }
  thead { background: #111827; }
  th {
    background: #111827; color: #ffffff;
    font-size: 9px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.8px;
    padding: 8px 12px; text-align: left; border: none;
  }
  td {
    color: #111827; font-size: 10px; padding: 6px 12px;
    border-bottom: 1px solid #f3f4f6; vertical-align: middle;
  }
  .num-cell { font-variant-numeric: tabular-nums; color: #111827; }
  .agent-avatar {
    width: 26px; height: 26px; border-radius: 50%;
    background: #e5e7eb; color: #374151;
    font-size: 9px; font-weight: 600;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .agent-name { font-size: 10px; font-weight: 600; color: #111827; }

  /* ── SLA EXCEEDED (same class as dashboard) ── */
  .sla-exceeded { color: #E74C3C !important; font-weight: 600; }
  .hero-kpi-badge.sla-exceeded { background: rgba(231,76,60,0.12); }

  /* ── PRINT FOOTER ── */
  .print-footer {
    display: flex; justify-content: space-between; align-items: center;
    margin-top: 16px; padding-top: 8px; border-top: 1px solid #e5e7eb;
    font-size: 8px; color: #9ca3af;
  }
  .print-footer-sig { font-weight: 500; color: #6b7280; }
</style></head>
<body>
  <div class="page-header">
    <div class="print-period-line">${title}</div>
    <div class="print-generated">
      <strong>${title}</strong>
      <span>Generated: ${generatedAt}</span>
      <span>${dateRange}</span>
    </div>
  </div>

  <div class="hero-badge">
    <div class="hero-badge-label"><span class="dot"></span> Team Overview</div>
    <div class="hero-kpis">${kpiCards}</div>
  </div>

  <div class="section-header">
    <div class="section-title">Agent Breakdown</div>
    <div class="section-sub">${dateRange}</div>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr>${ths}</tr></thead>
      <tbody>${trs}</tbody>
    </table>
  </div>

  <div class="print-footer">
    <span>Team Performance System</span>
    <span>${dateRange}</span>
    <span class="print-footer-sig">Automated report developed by Ali Isa Mohsen 36030791</span>
  </div>
</body></html>`;
}

async function buildPDF(params) {
  const executablePath = await chromium.executablePath(CHROMIUM_PACK);
  const browser = await puppeteer.launch({
    args:            chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath,
    headless:        chromium.headless,
  });
  try {
    const pg = await browser.newPage();
    await pg.setContent(buildPDFHtml(params), { waitUntil: 'networkidle0' });
    const pdfBuffer = await pg.pdf({
      format:          'A4',
      landscape:       true,
      printBackground: true,
      margin: { top: '8mm', right: '10mm', bottom: '8mm', left: '10mm' },
    });
    return Buffer.from(pdfBuffer);
  } finally {
    await browser.close();
  }
}

// ─── EMAIL SENDER ─────────────────────────────────────────────────────────────
async function sendReport({ to, subject, html }) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_PASS },
  });
  await transporter.sendMail({
    from: `"Team Performance" <${GMAIL_USER}>`,
    to:   Array.isArray(to) ? to.join(', ') : to,
    subject,
    html,
  });
}

// ─── HTML REPORT EMAIL BUILDERS ───────────────────────────────────────────────
// Dark-themed email matching the dashboard palette (#0D1F1A, #132B22, #1D9E75)
function buildReportEmailHtml({ dept, color, dateRange, generatedAt, kpis, sections }) {
  // KPI cards as tiles (dark surface, muted label on top, large white value below)
  const kpiHtml = kpis.map(k => {
    const isExceeded = k.exceeded;
    const badgeHtml = k.badge ? 
      `<div style="display:inline-block;margin-top:6px;font-size:10px;font-weight:600;color:${isExceeded ? '#fff' : '#1D9E75'};background:${isExceeded ? '#dc2626' : 'rgba(29,158,117,0.15)'};padding:3px 10px;border-radius:20px">${k.badge}</div>` : '';
    return `
    <td width="${Math.floor(100 / kpis.length)}%" style="padding:0 6px 0 0;vertical-align:top">
      <div style="background:#132B22;border:1px solid rgba(29,158,117,0.2);border-radius:10px;padding:16px 12px;text-align:center">
        <div style="font-size:10px;color:#6b9a8a;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.06em">${k.label}</div>
        <div style="font-size:24px;font-weight:700;color:#ffffff;line-height:1.1">${k.value}</div>
        ${badgeHtml}
      </div>
    </td>`;
  }).join('');

  const sectionsHtml = sections.map(sec => {
    const thead = sec.headers.map((h, i) =>
      `<th style="background:#132B22;color:#1D9E75;padding:12px ${i===0?'16px':'12px'};text-align:${i===0?'left':'right'};font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;white-space:nowrap;border-bottom:2px solid #1D9E75;${i===0?'width:22%;':''}">${h}</th>`
    ).join('');

    const tbody = sec.rows.map((row, idx) => {
      if (row.sep) return `<tr><td colspan="${sec.headers.length}" style="padding:10px 16px;background:#0D1F1A;color:#1D9E75;font-size:11px;font-weight:700;letter-spacing:0.08em;border-bottom:1px solid #1D9E75">${row.sep}</td></tr>`;
      const bg = idx % 2 === 1 ? '#0D1F1A' : '#132B22';
      return `<tr>${row.cells.map((c, ci) => {
        const isBadHandling = sec.headers[ci] === 'Bad Handling' && c.v !== '—' && parseInt(c.v) > 0;
        const textColor = isBadHandling ? '#f97316' : (c.red ? '#dc2626' : (ci === 0 ? '#ffffff' : '#d1e0d9'));
        const align = ci === 0 ? 'left' : 'right';
        const fontSize = ci === 0 ? '13px' : '12px';
        const fontWeight = (ci===0||c.bold||isBadHandling) ? '600' : '400';
        // Agent name on single line with wider column - no sub-line for agentId
        return `<td style="padding:10px ${ci===0?'16px':'12px'};background:${bg};font-size:${fontSize};color:${textColor};font-weight:${fontWeight};border-bottom:1px solid rgba(29,158,117,0.1);text-align:${align};white-space:nowrap;${ci===0?'width:22%;':''}">${c.v}</td>`;
      }).join('')}</tr>`;
    }).join('');

    return `
      ${sec.title ? `<div style="font-size:12px;font-weight:700;color:${color};text-transform:uppercase;letter-spacing:0.08em;margin:0 0 12px;padding-bottom:8px;border-bottom:2px solid ${color}">${sec.title}</div>` : ''}
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid rgba(29,158,117,0.2);border-radius:10px;overflow:hidden;margin-bottom:20px">
        <thead><tr>${thead}</tr></thead>
        <tbody>${tbody}</tbody>
      </table>`;
  }).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${dept} Performance Report</title></head>
<body style="margin:0;padding:0;background:#0D1F1A;font-family:'Segoe UI',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0D1F1A">
<tr><td align="center" style="padding:24px 12px">
<table width="680" cellpadding="0" cellspacing="0" style="max-width:680px;background:#132B22;border-radius:16px;overflow:hidden;border:1px solid rgba(29,158,117,0.25)">
  <tr><td style="background:#0D1F1A;padding:28px 32px;border-left:4px solid ${color}">
    <div style="font-size:24px;font-weight:700;color:#ffffff;letter-spacing:-0.3px">${dept} Performance Report</div>
    <div style="font-size:12px;color:#6b9a8a;margin-top:8px">
      Generated: ${generatedAt} &nbsp;&bull;&nbsp; Period: <strong style="color:#1D9E75">${dateRange}</strong>
    </div>
  </td></tr>
  <tr><td style="height:2px;background:linear-gradient(90deg,${color} 0%,transparent 100%)"></td></tr>
  <tr><td style="padding:28px 32px 20px">
    <div style="font-size:11px;font-weight:700;color:#1D9E75;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:16px;padding-bottom:8px;border-bottom:1px solid rgba(29,158,117,0.3)">&#9679; Team Overview</div>
    <table width="100%" cellpadding="0" cellspacing="0"><tr>${kpiHtml}</tr></table>
  </td></tr>
  <tr><td style="padding:4px 32px 32px">
    <div style="font-size:11px;font-weight:700;color:#1D9E75;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:16px;padding-bottom:8px;border-bottom:1px solid rgba(29,158,117,0.3)">&#9679; Agent Breakdown &nbsp;<span style="font-weight:400;color:#6b9a8a;font-size:10px">${dateRange}</span></div>
    ${sectionsHtml}
  </td></tr>
  <tr><td style="padding:16px 32px;background:#0D1F1A;border-top:1px solid rgba(29,158,117,0.2)">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font-size:10px;color:#6b9a8a">Team Performance System</td>
      <td align="center" style="font-size:10px;color:#6b9a8a">${dateRange}</td>
      <td align="right" style="font-size:10px;color:#6b9a8a">Automated report developed by Ali Isa Mohsen 36030791</td>
    </tr></table>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function buildSalesEmailBody({ stats, totalOrders, totalClaimed, avgTime, avgHandleTime, slaSeconds, handleSlaSeconds, dateRange, generatedAt }) {
  const rate = totalOrders ? Math.round(totalClaimed / totalOrders * 100) : 0;
  const isSlaExceeded = avgTime > slaSeconds;
  const isHandleSlaExceeded = avgHandleTime > (handleSlaSeconds || slaSeconds);
  const totalPortalOrders = stats.reduce((s, a) => s + (a.portalOrders || 0), 0);
  return buildReportEmailHtml({
    dept: 'Sales', color: '#1D9E75', dateRange, generatedAt,
    kpis: [
      { label: 'Total Orders',   value: totalOrders.toLocaleString() },
      { label: 'Claimed',        value: totalClaimed.toLocaleString(), badge: `${rate}%` },
      { label: 'Claim Rate',     value: `${rate}%` },
      { label: 'Created Orders', value: totalPortalOrders.toLocaleString() },
      { label: 'Avg Claim Time', value: fmtTime(avgTime), exceeded: isSlaExceeded, badge: isSlaExceeded ? 'SLA Exceeded' : 'On Track' },
      { label: 'Avg Handle Time', value: fmtTime(avgHandleTime), exceeded: isHandleSlaExceeded, badge: isHandleSlaExceeded ? 'SLA Exceeded' : 'On Track' },
      { label: 'Agents',         value: String(stats.length), badge: 'active' },
    ],
    sections: [{ headers: ['Agent','Orders','Created','Claimed','Claim Rate','Avg Claim Time','Avg Handle Time','Bad Handling'],
      rows: stats.map(a => {
        const handleTimeExceeded = a.avgHandleTime != null && a.avgHandleTime > (handleSlaSeconds || slaSeconds);
        return { cells: [
          { v: a.displayName || a.name, agentId: a.name },
          { v: a.orders.toLocaleString() },
          { v: (a.portalOrders || 0) > 0 ? (a.portalOrders).toLocaleString() : '—' },
          { v: a.claimed.toLocaleString() },
          { v: `${a.rate}%` },
          { v: fmtTime(a.avgTime), red: a.avgTime != null && a.avgTime > slaSeconds },
          { v: fmtTime(a.avgHandleTime), red: handleTimeExceeded },
          { v: a.badHandling > 0 ? String(a.badHandling) : '—' },
        ]};
      }) }],
  });
}

function buildLogisticsEmailBody({ stats, avgTime, slaSeconds, dateRange, generatedAt }) {
  const total   = stats.reduce((s, a) => s + a.orders,  0);
  const claimed = stats.reduce((s, a) => s + a.claimed, 0);
  const rate    = total ? Math.round(claimed / total * 100) : 0;
  const isSlaExceeded = avgTime > slaSeconds;
  return buildReportEmailHtml({
    dept: 'Logistics', color: '#3b82f6', dateRange, generatedAt,
    kpis: [
      { label: 'Total Assigned', value: total.toLocaleString() },
      { label: 'Claimed',        value: claimed.toLocaleString(), badge: `${rate}%` },
      { label: 'Claim Rate',     value: `${rate}%` },
      { label: 'Avg Claim Time', value: fmtTime(avgTime), exceeded: isSlaExceeded, badge: isSlaExceeded ? 'SLA Exceeded' : 'On Track' },
      { label: 'Agents',         value: String(stats.length), badge: 'active' },
    ],
    sections: [{ headers: ['Agent','Assigned','Claimed','Claim Rate','Avg Claim Time','Bad Handling'],
      rows: stats.map(a => ({ cells: [
        { v: a.displayName || a.name, agentId: a.name },
        { v: a.orders.toLocaleString() },
        { v: a.claimed.toLocaleString() },
        { v: `${a.rate}%` },
        { v: fmtTime(a.avgTime), red: a.avgTime != null && a.avgTime > slaSeconds },
        { v: a.badHandling > 0 ? String(a.badHandling) : '—' },
      ]})) }],
  });
}

function buildActivationEmailBody({ stats, avgTime, slaSeconds, dateRange, generatedAt }) {
  const total     = stats.reduce((s, a) => s + a.orders,  0);
  const completed = stats.reduce((s, a) => s + a.claimed, 0);
  const rate      = total ? Math.round(completed / total * 100) : 0;
  const isSlaExceeded = avgTime > slaSeconds;
  return buildReportEmailHtml({
    dept: 'Activation', color: '#a855f7', dateRange, generatedAt,
    kpis: [
      { label: 'Total Assigned',  value: total.toLocaleString() },
      { label: 'Completed',       value: completed.toLocaleString(), badge: `${rate}%` },
      { label: 'Completion Rate', value: `${rate}%` },
      { label: 'Avg Handle Time', value: fmtTime(avgTime), exceeded: isSlaExceeded, badge: isSlaExceeded ? 'SLA Exceeded' : 'On Track' },
      { label: 'Agents',          value: String(stats.length), badge: 'active' },
    ],
    sections: [{ headers: ['Agent','Assigned','Completed','Completion Rate','Avg Handle Time','Bad Handling'],
      rows: stats.map(a => ({ cells: [
        { v: a.displayName || a.name, agentId: a.name },
        { v: a.orders.toLocaleString() },
        { v: a.claimed.toLocaleString() },
        { v: `${a.rate}%` },
        { v: fmtTime(a.avgTime), red: a.avgTime != null && a.avgTime > slaSeconds },
        { v: a.badHandling > 0 ? String(a.badHandling) : '—' },
      ]})) }],
  });
}

function buildManagementEmailBody({ salesStats, logStats, actStats, totalOrders, totalClaimed, salesAvgTime, logAvgTime, actAvgTime, slaSalesSec, slaLogisticsSec, slaActSec, dateRange, generatedAt }) {
  // Calculate aggregate statistics
  const totalPortalOrders = salesStats.reduce((s, a) => s + (a.portalOrders || 0), 0);
  const totalLogAssigned = logStats.reduce((s, a) => s + a.orders, 0);
  const totalLogClaimed = logStats.reduce((s, a) => s + a.claimed, 0);
  const totalActAssigned = actStats.reduce((s, a) => s + a.orders, 0);
  const totalActCompleted = actStats.reduce((s, a) => s + a.claimed, 0);
  
  // Calculate average handling times
  const salesAvgHandleTime = safeAvg(salesStats.map(a => a.avgHandleTime).filter(Boolean)) || 0;
  const logAvgHandleTime = safeAvg(logStats.map(a => a.avgHandleTime).filter(Boolean)) || 0;
  const actAvgHandleTime = safeAvg(actStats.map(a => a.avgHandleTime).filter(Boolean)) || 0;
  const totalHandleTime = salesAvgHandleTime + logAvgHandleTime + actAvgHandleTime;
  
  // Build custom KPI section HTML
  const kpiTile = (label, value, subtext, color = '#1D9E75') => `
    <div style="background:#132B22;border:1px solid rgba(29,158,117,0.2);border-radius:10px;padding:16px 12px;text-align:center;margin-bottom:12px;">
      <div style="font-size:10px;color:#6b9a8a;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.06em">${label}</div>
      <div style="font-size:24px;font-weight:700;color:#ffffff;line-height:1.1">${value}</div>
      ${subtext ? `<div style="font-size:11px;color:${color};margin-top:4px">${subtext}</div>` : ''}
    </div>
  `;
  
  const handlingTimeTile = (label, time, desc) => `
    <div style="background:#132B22;border:1px solid rgba(29,158,117,0.2);border-radius:10px;padding:12px;text-align:left;margin-bottom:10px;">
      <div style="font-size:11px;color:#6b9a8a;margin-bottom:2px">${label}</div>
      <div style="font-size:18px;font-weight:700;color:#ffffff">${fmtTime(time)}</div>
      <div style="font-size:10px;color:#6b9a8a">${desc}</div>
    </div>
  `;
  
  // Main KPIs section - Orders Claimed & Created Orders
  const ordersSection = `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
      <tr>
        <td width="50%" style="padding-right:8px;">
          ${kpiTile('Orders Claimed', fmtTime(salesAvgTime), `${totalClaimed.toLocaleString()} orders`, salesAvgTime > slaSalesSec ? '#dc2626' : '#1D9E75')}
        </td>
        <td width="50%" style="padding-left:8px;">
          ${kpiTile('Created Orders', totalPortalOrders > 0 ? totalPortalOrders.toLocaleString() : '—', totalPortalOrders > 0 ? 'portal channel' : '0 orders')}
        </td>
      </tr>
    </table>
  `;
  
  // Assigned section
  const assignedSection = `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
      <tr>
        <td width="50%" style="padding-right:8px;">
          ${kpiTile('Assigned to Logistics', fmtTime(logAvgTime), `${totalLogAssigned.toLocaleString()} orders`, logAvgTime > slaLogisticsSec ? '#dc2626' : '#1D9E75')}
        </td>
        <td width="50%" style="padding-left:8px;">
          ${kpiTile('Assigned to Activation', fmtTime(actAvgTime), `${totalActAssigned.toLocaleString()} orders`, actAvgTime > slaActSec ? '#dc2626' : '#1D9E75')}
        </td>
      </tr>
    </table>
  `;
  
  // Handling Times section
  const handlingSection = `
    <div style="background:#0D1F1A;border-radius:10px;padding:16px;margin-bottom:20px;">
      <div style="font-size:11px;font-weight:700;color:#1D9E75;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:12px;">Handling Times</div>
      ${handlingTimeTile('Sales Handling Time', salesAvgHandleTime, 'claim → logistics assign')}
      ${handlingTimeTile('Logistics Handling Time', logAvgHandleTime, 'claim → activation assign')}
      ${handlingTimeTile('Activation Handling Time', actAvgHandleTime, 'claim → complete')}
      <div style="border-top:1px solid rgba(29,158,117,0.2);margin:12px 0;padding-top:12px;">
        ${handlingTimeTile('Total Handling Time', totalHandleTime, 'combined average')}
      </div>
    </div>
  `;
  
  // Build custom email HTML
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Management Summary Report</title></head>
<body style="margin:0;padding:0;background:#0D1F1A;font-family:'Segoe UI',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0D1F1A">
<tr><td align="center" style="padding:24px 12px">
<table width="680" cellpadding="0" cellspacing="0" style="max-width:680px;background:#132B22;border-radius:16px;overflow:hidden;border:1px solid rgba(29,158,117,0.25)">
  <tr><td style="background:#0D1F1A;padding:28px 32px;border-left:4px solid #f59e0b">
    <div style="font-size:24px;font-weight:700;color:#ffffff;letter-spacing:-0.3px">Management Summary Report</div>
    <div style="font-size:12px;color:#6b9a8a;margin-top:8px">
      Generated: ${generatedAt} &nbsp;&bull;&nbsp; Period: <strong style="color:#1D9E75">${dateRange}</strong>
    </div>
  </td></tr>
  <tr><td style="height:2px;background:linear-gradient(90deg,#f59e0b 0%,transparent 100%)"></td></tr>
  <tr><td style="padding:28px 32px 20px">
    ${ordersSection}
    ${assignedSection}
    ${handlingSection}
  </td></tr>
  <tr><td style="padding:16px 32px;background:#0D1F1A;border-top:1px solid rgba(29,158,117,0.2)">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font-size:10px;color:#6b9a8a">Team Performance System</td>
      <td align="center" style="font-size:10px;color:#6b9a8a">${dateRange}</td>
      <td align="right" style="font-size:10px;color:#6b9a8a">Automated report developed by Ali Isa Mohsen 36030791</td>
    </tr></table>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

async function sendEmail({ to, cc, subject, html }) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_PASS },
  });
  const mailOpts = {
    from: `"Team Performance" <${GMAIL_USER}>`,
    to:   Array.isArray(to) ? to.join(', ') : to,
    subject,
    html,
  };
  if (cc && (Array.isArray(cc) ? cc.length : cc)) {
    mailOpts.cc = Array.isArray(cc) ? cc.join(', ') : cc;
  }
  await transporter.sendMail(mailOpts);
}

function buildAgentSlaAlertHtml({ agentName, department, dateRange, avgTime, slaSeconds, orders, claimed, rate, badHandling, timeLabel, ordersLabel, claimedLabel }) {
  const avgFmt = fmtTime(avgTime);
  const slaFmt = fmtTime(slaSeconds);
  const deptLabel = department.charAt(0).toUpperCase() + department.slice(1);
  const deptColor = department === 'sales' ? '#1D9E75' : department === 'logistics' ? '#3b82f6' : '#a855f7';
  
  // Compact KPI tiles
  const kpiTiles = [
    { label: ordersLabel, value: orders },
    { label: claimedLabel, value: claimed },
    { label: 'Rate', value: `${rate}%` },
    { label: 'Bad Handling', value: badHandling, warn: badHandling > 0 },
  ].map(k => `
    <td width="25%" style="padding:0 4px 0 0">
      <div style="background:#132B22;border:1px solid rgba(163,45,45,0.3);border-radius:8px;padding:12px 8px;text-align:center">
        <div style="font-size:9px;color:#6b9a8a;margin-bottom:3px;text-transform:uppercase;letter-spacing:0.05em">${k.label}</div>
        <div style="font-size:18px;font-weight:700;color:${k.warn ? '#f97316' : '#ffffff'}">${k.value}</div>
      </div>
    </td>
  `).join('');
  
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SLA Alert – ${agentName}</title></head>
<body style="margin:0;padding:0;background:#0D1F1A;font-family:'Segoe UI',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0D1F1A">
<tr><td align="center" style="padding:24px 12px">
<table width="680" cellpadding="0" cellspacing="0" style="max-width:680px;background:#132B22;border-radius:16px;overflow:hidden;border:1px solid rgba(163,45,45,0.4)">
  
  <!-- Red Warning Banner -->
  <tr><td style="background:#A32D2D;padding:28px 32px">
    <div style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.3px">SLA Breach Notification</div>
    <div style="font-size:12px;color:#fecaca;margin-top:6px">${deptLabel} · ${dateRange}</div>
  </td></tr>
  
  <tr><td style="padding:28px 32px">
    <!-- Greeting -->
    <p style="color:#ffffff;font-size:16px;margin:0 0 12px">Dear <strong>${agentName}</strong>,</p>
    <p style="color:#6b9a8a;font-size:14px;line-height:1.6;margin:0 0 24px">This is an automated notification to inform you that your average handling time for the period <strong style="color:#1D9E75">${dateRange}</strong> has exceeded the accepted SLA threshold.</p>
    
    <!-- Two-column comparison card -->
    <div style="background:#0D1F1A;border:1px solid rgba(163,45,45,0.4);border-radius:12px;padding:20px 24px;margin-bottom:24px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid rgba(163,45,45,0.3)">
        <div>
          <div style="font-size:11px;color:#dc2626;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px">Your Avg Time</div>
          <div style="font-size:28px;font-weight:700;color:#dc2626">${avgFmt}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:11px;color:#1D9E75;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px">Accepted SLA</div>
          <div style="font-size:28px;font-weight:700;color:#1D9E75">${slaFmt}</div>
        </div>
      </div>
      <div style="background:rgba(220,38,38,0.15);border-radius:8px;padding:12px 16px;text-align:center">
        <span style="font-size:12px;color:#fecaca">SLA exceeded by <strong>${fmtTime(avgTime - slaSeconds)}</strong></span>
      </div>
    </div>
    
    <!-- Compact KPI tiles -->
    <p style="color:#1D9E75;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 12px">Performance Breakdown</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px"><tr>${kpiTiles}</tr></table>
    
    <!-- Closing line -->
    <p style="color:#6b9a8a;font-size:14px;font-style:italic;margin:0 0 8px">We kindly ask you to review your handling process.</p>
    <p style="color:#6b9a8a;font-size:13px;margin:0">Please ensure your response times are corrected to be within the accepted SLA of <strong style="color:#1D9E75">${slaFmt}</strong>.</p>
  </td></tr>
  
  <!-- Footer -->
  <tr><td style="padding:16px 32px;background:#0D1F1A;border-top:1px solid rgba(163,45,45,0.2)">
    <p style="color:#6b9a8a;font-size:10px;margin:0;text-align:center">Automated report developed by <strong style="color:#1D9E75">Ali Isa Mohsen</strong> 36030791</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

// ─── GENERATE + SEND ALL REPORTS ─────────────────────────────────────────────
async function sendAllReports(importId, testRecipient = null) {
  if (!GMAIL_USER || !GMAIL_PASS) return;

  const todayKey = new Date().toISOString().slice(0, 10);

  // Check global auto-email toggle (skipped for manual test sends)
  if (!testRecipient) {
    const emailSettingsSnap = await db.collection('emailSettings').doc('default').get();
    const autoEmailEnabled = emailSettingsSnap.exists
      ? emailSettingsSnap.data().autoEmailEnabled !== false
      : true; // default enabled if doc not yet created
    if (!autoEmailEnabled) {
      console.log('[email] Auto email is disabled — skipping send.');
      return;
    }

    // Guard: Check if emails were already sent today (prevents duplicates)
    const pendingRef = db.collection('pendingReports').doc(todayKey);
    const pendingDoc = await pendingRef.get();
    if (pendingDoc.exists && pendingDoc.data().sent === true) {
      console.log(`[email] Emails were already sent today (${todayKey}) — skipping duplicate send.`);
      return;
    }
  }

  const effectiveRecipients = testRecipient
    ? { sales: [testRecipient], logistics: [testRecipient], activation: [testRecipient], management: [testRecipient] }
    : RECIPIENTS;
  const subjectPrefix = testRecipient ? '[TEST] ' : '';

  // Determine which period to report on based on today's date
  const period = getReportPeriod();
  const fromTs = Timestamp.fromDate(period.from);
  const toTs   = Timestamp.fromDate(period.to);

  // Query Firestore for the correct date range + SLA settings + agent email mappings
  const [salesSnap, logSnap, actSnap, slaSnap, mappingsSnap] = await Promise.all([
    db.collection('orders').where('orderDT', '>=', fromTs).where('orderDT', '<=', toTs).get(),
    db.collection('logisticsOrders').where('assignDT', '>=', fromTs).where('assignDT', '<=', toTs).get(),
    db.collection('activationOrders').where('assignDT', '>=', fromTs).where('assignDT', '<=', toTs).get(),
    db.collection('slaSettings').limit(1).get(),
    db.collection('agentMappings').get(),
  ]);

  // Build full mapping map: agentCode (uppercase) -> { email, displayName, agentType, visible }
  const mappingMap = {};
  mappingsSnap.docs.forEach(d => {
    const m = d.data();
    if (!m.agentCode) return;
    mappingMap[m.agentCode.toUpperCase()] = {
      email:       (m.email || '').trim(),
      displayName: (m.displayName || '').trim(),
      agentType:   m.agentType || null,
      visible:     m.visible !== false,
    };
  });

  // agentEmailMap is a subset of mappingMap — only agents with an email set
  const agentEmailMap = {};
  Object.entries(mappingMap).forEach(([code, m]) => {
    if (m.email) agentEmailMap[code] = m;
  });

  // Only include agents that are visible (visible===true) AND have a display name set AND match the agent type
  const isVisible = (agentCode) => {
    const m = mappingMap[(agentCode || '').toUpperCase()];
    return !!(m && m.displayName && m.visible !== false);
  };
  
  const isAgentType = (agentCode, type) => {
    const m = mappingMap[(agentCode || '').toUpperCase()];
    return m && m.agentType === type;
  };

  const slaData = slaSnap.empty ? {} : slaSnap.docs[0].data();
  const slaSalesSec     = ((slaData.sales      || {}).workingHours || 120) * 60;
  const slaLogisticsSec = ((slaData.logistics  || {}).workingHours || 120) * 60;
  const slaActSec       = ((slaData.activation || {}).workingHours || 120) * 60;

  // Build stats then filter to visible-only agents of the correct type; add displayName for email output
  // Keep original agent code in `name` so SLA alert email lookups still work
  const applyMapping = (stats, agentType) => stats
    .filter(a => isVisible(a.name) && isAgentType(a.name, agentType))
    .map(a => ({ ...a, displayName: mappingMap[a.name.toUpperCase()]?.displayName || a.name }));

  const salesStats = applyMapping(statsFromDocs(salesSnap.docs,  'claimTimeSec'), 'sales');
  const logStats   = applyMapping(statsFromDocs(logSnap.docs,    'claimTimeSec'), 'logistics');
  const actStats   = applyMapping(statsFromDocs(actSnap.docs,    'handleTimeSec'), 'activation');

  const salesAvgTime = safeAvg(salesStats.map(a => a.avgTime).filter(Boolean));
  const salesAvgHandleTime = safeAvg(salesStats.map(a => a.avgHandleTime).filter(Boolean));
  const logAvgTime   = safeAvg(logStats.map(a => a.avgTime).filter(Boolean));
  const actAvgTime   = safeAvg(actStats.map(a => a.avgTime).filter(Boolean));

  const totalOrders  = salesSnap.docs.length;
  const totalClaimed = salesSnap.docs.filter(d => d.data().claimed).length;

  const dateRange = period.label;
  const dateTag   = period.from.toISOString().slice(0, 10);

  // ── Build HTML email bodies for each department
  const generatedAt    = new Date().toLocaleString('en-GB');
  const salesHtml      = buildSalesEmailBody({ stats: salesStats, totalOrders, totalClaimed, avgTime: salesAvgTime, avgHandleTime: salesAvgHandleTime, slaSeconds: slaSalesSec, handleSlaSeconds: slaSalesSec, dateRange, generatedAt });
  const logisticsHtml  = buildLogisticsEmailBody({ stats: logStats,   avgTime: logAvgTime,   slaSeconds: slaLogisticsSec, dateRange, generatedAt });
  const activationHtml = buildActivationEmailBody({ stats: actStats,  avgTime: actAvgTime,   slaSeconds: slaActSec,       dateRange, generatedAt });
  const managementHtml = buildManagementEmailBody({ salesStats, logStats, actStats, totalOrders, totalClaimed, salesAvgTime, logAvgTime, actAvgTime, slaSalesSec, slaLogisticsSec, slaActSec, dateRange, generatedAt });

  // ── Build per-agent SLA alert emails (skipped entirely in test mode)
  const SLA_ALERT_CC    = ['ali.mohsen@bh.zain.com', 'alaa.alawi@bh.zain.com'];
  const SLA_ALERT_CC_LOG = [...SLA_ALERT_CC, 'NezarN@aramex.com'];
  const agentAlertPromises = [];
  const slaAlerts = []; // track every breach (sent + skipped) for logging
  if (!testRecipient) {
    console.log(`[alerts] checking ${salesStats.length} sales / ${logStats.length} logistics / ${actStats.length} activation agents. SLA: sales=${slaSalesSec}s log=${slaLogisticsSec}s act=${slaActSec}s`);
  }

  salesStats.forEach(agent => {
    if (testRecipient) return; // skip alerts in test mode
    const mapping = agentEmailMap[agent.name.toUpperCase()];
    // Only alert for this agent's primary department to avoid duplicate emails
    if (mapping?.agentType && mapping.agentType !== 'sales') return;
    if (agent.avgTime != null && agent.avgTime > slaSalesSec) {
      if (mapping?.email) {
        slaAlerts.push({ agentName: mapping.displayName, department: 'Sales', avgTime: agent.avgTime, slaSeconds: slaSalesSec, email: mapping.email, status: 'sent' });
        agentAlertPromises.push(sendEmail({
          to:      mapping.email,
          cc:      SLA_ALERT_CC,
          subject: `SLA Alert – ${mapping.displayName} – ${dateRange}`,
          html:    buildAgentSlaAlertHtml({
            agentName:    mapping.displayName,
            department:   'Sales',
            dateRange,
            avgTime:      agent.avgTime,
            slaSeconds:   slaSalesSec,
            orders:       agent.orders,
            claimed:      agent.claimed,
            rate:         agent.rate,
            badHandling:  agent.badHandling || 0,
            timeLabel:    'Avg Claim Time',
            ordersLabel:  'Total Orders',
            claimedLabel: 'Claimed',
          }),
        }));
      } else {
        slaAlerts.push({ agentName: agent.name, department: 'Sales', avgTime: agent.avgTime, slaSeconds: slaSalesSec, email: null, status: 'no_email' });
      }
    }
  });

  logStats.forEach(agent => {
    if (testRecipient) return; // skip alerts in test mode
    const mapping = agentEmailMap[agent.name.toUpperCase()];
    if (mapping?.agentType && mapping.agentType !== 'logistics') return;
    if (agent.avgTime != null && agent.avgTime > slaLogisticsSec) {
      if (mapping?.email) {
        slaAlerts.push({ agentName: mapping.displayName, department: 'Logistics', avgTime: agent.avgTime, slaSeconds: slaLogisticsSec, email: mapping.email, status: 'sent' });
        agentAlertPromises.push(sendEmail({
          to:      mapping.email,
          cc:      SLA_ALERT_CC_LOG,
          subject: `SLA Alert – ${mapping.displayName} – ${dateRange}`,
          html:    buildAgentSlaAlertHtml({
            agentName:    mapping.displayName,
            department:   'Logistics',
            dateRange,
            avgTime:      agent.avgTime,
            slaSeconds:   slaLogisticsSec,
            orders:       agent.orders,
            claimed:      agent.claimed,
            rate:         agent.rate,
            badHandling:  agent.badHandling || 0,
            timeLabel:    'Avg Claim Time',
            ordersLabel:  'Total Assigned',
            claimedLabel: 'Claimed',
          }),
        }));
      } else {
        slaAlerts.push({ agentName: agent.name, department: 'Logistics', avgTime: agent.avgTime, slaSeconds: slaLogisticsSec, email: null, status: 'no_email' });
      }
    }
  });

  actStats.forEach(agent => {
    if (testRecipient) return; // skip alerts in test mode
    const mapping = agentEmailMap[agent.name.toUpperCase()];
    if (mapping?.agentType && mapping.agentType !== 'activation') return;
    if (agent.avgTime != null && agent.avgTime > slaActSec) {
      if (mapping?.email) {
        slaAlerts.push({ agentName: mapping.displayName, department: 'Activation', avgTime: agent.avgTime, slaSeconds: slaActSec, email: mapping.email, status: 'sent' });
        agentAlertPromises.push(sendEmail({
          to:      mapping.email,
          cc:      SLA_ALERT_CC,
          subject: `SLA Alert – ${mapping.displayName} – ${dateRange}`,
          html:    buildAgentSlaAlertHtml({
            agentName:    mapping.displayName,
            department:   'Activation',
            dateRange,
            avgTime:      agent.avgTime,
            slaSeconds:   slaActSec,
            orders:       agent.orders,
            claimed:      agent.claimed,
            rate:         agent.rate,
            badHandling:  agent.badHandling || 0,
            timeLabel:    'Avg Handle Time',
            ordersLabel:  'Total Assigned',
            claimedLabel: 'Completed',
          }),
        }));
      } else {
        slaAlerts.push({ agentName: agent.name, department: 'Activation', avgTime: agent.avgTime, slaSeconds: slaActSec, email: null, status: 'no_email' });
      }
    }
  });

  await Promise.all([
    sendReport({ to: effectiveRecipients.sales,      subject: `${subjectPrefix}Sales Performance Report – ${dateRange}`,      html: salesHtml }),
    sendReport({ to: effectiveRecipients.logistics,  subject: `${subjectPrefix}Logistics Performance Report – ${dateRange}`,  html: logisticsHtml }),
    sendReport({ to: effectiveRecipients.activation, subject: `${subjectPrefix}Activation Performance Report – ${dateRange}`, html: activationHtml }),
    sendReport({ to: effectiveRecipients.management, subject: `${subjectPrefix}Management Summary Report – ${dateRange}`,     html: managementHtml }),
    ...(testRecipient ? [] : agentAlertPromises),
  ]);

  // Save to email history
  await db.collection('emailHistory').add({
    sentAt:     FieldValue.serverTimestamp(),
    importId,
    dateRange,
    rowCount:   totalOrders,
    reports:    ['Sales', 'Logistics', 'Activation', 'Management'],
    recipients: effectiveRecipients,
    status:     'sent',
    isTest:     !!testRecipient,
    slaAlerts,
    slaThresholds: {
      salesSec:     slaSalesSec,
      logisticsSec: slaLogisticsSec,
      activationSec: slaActSec,
    },
    agentStats: {
      sales:      salesStats.map(a => ({ name: a.name, avgTime: a.avgTime, orders: a.orders, claimed: a.claimed })),
      logistics:  logStats.map(a =>   ({ name: a.name, avgTime: a.avgTime, orders: a.orders, claimed: a.claimed })),
      activation: actStats.map(a =>   ({ name: a.name, avgTime: a.avgTime, orders: a.orders, claimed: a.claimed })),
    },
  });
}

// ─── SCHEDULED: PROCESS PENDING REPORTS (every 5 min) ────────────────────────
export const processPendingReports = onSchedule(
  { schedule: 'every 5 minutes', region: 'us-central1', timeoutSeconds: 540, memory: '1GiB' },
  async () => {
    const now  = Timestamp.now();
    const snap = await db.collection('pendingReports')
      .where('sent', '==', false)
      .where('sendAt', '<=', now)
      .get();

    for (const doc of snap.docs) {
      try {
        const { importId } = doc.data();
        await sendAllReports(importId);
        await doc.ref.update({ sent: true, sentAt: FieldValue.serverTimestamp() });
      } catch (err) {
        console.error(`Failed to send report for ${doc.id}:`, err);
        await doc.ref.update({ error: err.message });
      }
    }
  }
);

// ─── MAIN IMPORT LOGIC ───────────────────────────────────────────────────────
// csvText2 / filename2: optional second CSV (portal / manually-created orders).
// Both files share identical headers. Rows are merged before processing so
// portal orders (channel = 'Portal') flow through the same collections but
// are flagged by their channel value for the dashboards to filter separately.
async function runImport(csvText, filename, csvText2 = null, filename2 = null) {
  const { headers, rows: rows1 } = parseCSV(csvText);
  if (!headers.length || !rows1.length) {
    throw new Error('CSV is empty or invalid');
  }

  const headerSet = new Set(headers.map(h => h.trim()));
  const missing = ACTIVE_COLS.filter(c => !headerSet.has(c));
  if (missing.length > 0) {
    throw new Error(`Missing required columns: ${missing.join(', ')}`);
  }

  // Parse and merge second (portal) file if provided
  let rows2 = [];
  if (csvText2) {
    const parsed2 = parseCSV(csvText2);
    rows2 = parsed2.rows; // Same headers assumed — no extra validation needed
  }

  const rows = [...rows1, ...rows2];
  const portalCount = rows.filter(r => (r['CHANNEL'] || '').trim().toLowerCase() === 'portal').length;

  const agents = processRows(rows);
  const summary = computeSummary(agents, rows);
  const orderNos = rows.map(row => (row['CHANNEL_ORDER_NO'] || '').trim()).filter(Boolean);
  const uniqueOrderNos = [...new Set(orderNos)];
  const totalRows = rows.length;
  const uniqueCount = uniqueOrderNos.length;
  const isLargeFile = totalRows > 10000;

  // Save import metadata
  const importRef = await db.collection('imports').add({
    filename: filename || 'unknown.csv',
    ...(filename2 ? { filename2 } : {}),
    rowCount: totalRows,
    uniqueOrderCount: uniqueCount,
    portalOrderCount: portalCount,
    agentCount: agents.length,
    salesAgentCount: summary.salesAgents || 0,
    logisticsAgentCount: summary.logisticsAgents || 0,
    activationAgentCount: summary.activationAgents || 0,
    summary,
    importedAt: FieldValue.serverTimestamp(),
    isLargeFile,
    source: 'power-automate',
  });

  const importId = importRef.id;

  const processSalesOrder = (row) => {
    const orderNo = (row['CHANNEL_ORDER_NO'] || '').trim();
    if (!orderNo) return null;
    const orderDT = parseDateTime(row['ORDER_CREATION_DATE_TIME1'] || row['ORDER_CREATION_DATE'], row['ORDER_CREATION_time']);
    const claimDT = parseDateTime(row['SALES_CLAIM_DATE_FIRST'], row['SALES_CLAIM_TIME_FIRST']);
    const logisticsAssignDT = parseDateTime(row['LOGISTICS_ASSIGN_DATE_1'], row['LOGISTICS_ASSIGN_TIME_1']);
    const logisticsClaimDT = parseDateTime(row['LOGISTICS_CLAIM_DATE_FIRST'], row['LOGISTICS_CLAIM_TIME_FIRST']);
    const activationAssignDT = parseDateTime(row['ACTIVATION_ASSIGN_DATE'], row['ACTIVATION_ASSIGN_TIME']);
    const effectiveOrderDT = getEffectiveSalesStartTime(orderDT, row['HOURS_TYPE']);

    // For portal (manually created) orders, the creator is in LOG_USER not SALES_USER_FIRST
    const isPortal = (row['CHANNEL'] || '').trim().toLowerCase() === 'portal';
    // Portal orders may not have ORDER_CREATION_DATE; fall back to logistics assign date
    // so they are not excluded by date range filters in the dashboards.
    const storedOrderDT = orderDT || (isPortal ? (logisticsAssignDT || activationAssignDT) : null);
    return {
      orderNo,
      agentName: isPortal ? (row['LOG_USER'] || '').trim() || getRowAgentName(row) : getRowAgentName(row),
      channel: row['CHANNEL'] || '',
      status: row['ESHOP_ORDER_STATUS'] || '',
      hoursType: row['HOURS_TYPE'] || '',
      orderDT: storedOrderDT ? Timestamp.fromDate(storedOrderDT) : null,
      effectiveOrderDT: effectiveOrderDT ? Timestamp.fromDate(effectiveOrderDT) : null,
      claimDT: claimDT ? Timestamp.fromDate(claimDT) : null,
      logisticsAssignDT: logisticsAssignDT ? Timestamp.fromDate(logisticsAssignDT) : null,
      logisticsClaimDT: logisticsClaimDT ? Timestamp.fromDate(logisticsClaimDT) : null,
      activationAssignDT: activationAssignDT ? Timestamp.fromDate(activationAssignDT) : null,
      claimed: !!claimDT,
      claimTimeSec: diffSeconds(effectiveOrderDT, claimDT),
      assignTimeSec: diffSeconds(claimDT, logisticsAssignDT),
      logisticsAssignTimeSec: diffSeconds(claimDT, logisticsAssignDT),
      logisticsClaimTimeSec: diffSeconds(logisticsAssignDT, logisticsClaimDT),
      activationAssignTimeSec: diffSeconds(logisticsClaimDT, activationAssignDT),
      lastImportedAt: FieldValue.serverTimestamp(),
      importId,
    };
  };

  const processLogisticsOrder = (row) => {
    const orderNo = (row['CHANNEL_ORDER_NO'] || '').trim();
    const agentName = (row['LOGISTICS_USER_FIRST'] || row['LOGISTICS_USER_LAST'] || '').trim();
    if (!orderNo || !agentName) return null;
    const assignDT = parseDateTime(row['LOGISTICS_ASSIGN_DATE_1'], row['LOGISTICS_ASSIGN_TIME_1']);
    const claimDT = parseDateTime(row['LOGISTICS_CLAIM_DATE_FIRST'], row['LOGISTICS_CLAIM_TIME_FIRST']);
    const activationAssignDT = parseDateTime(row['ACTIVATION_ASSIGN_DATE'], row['ACTIVATION_ASSIGN_TIME']);
    const activationClaimDT = parseDateTime(row['ACTIVATION_CLAIM_DATE'], row['ACTIVATION_CLAIM_TIME']);
    const effectiveAssignDT = getEffectiveStartTime(assignDT, 'logistics');

    return {
      orderNo,
      agentName,
      activationAgentName: row['ACTIVATION_USER'] || '',
      channel: row['CHANNEL'] || '',
      status: row['ESHOP_ORDER_STATUS'] || '',
      assignDT: assignDT ? Timestamp.fromDate(assignDT) : null,
      effectiveAssignDT: effectiveAssignDT ? Timestamp.fromDate(effectiveAssignDT) : null,
      claimDT: claimDT ? Timestamp.fromDate(claimDT) : null,
      activationAssignDT: activationAssignDT ? Timestamp.fromDate(activationAssignDT) : null,
      activationClaimDT: activationClaimDT ? Timestamp.fromDate(activationClaimDT) : null,
      claimed: !!claimDT,
      claimTimeSec: diffSeconds(effectiveAssignDT, claimDT),
      activationAssignTimeSec: diffSeconds(claimDT, activationAssignDT),
      handleTimeSec: diffSeconds(activationAssignDT, activationClaimDT),
      completed: !!activationClaimDT,
      lastImportedAt: FieldValue.serverTimestamp(),
      importId,
    };
  };

  const processActivationOrder = (row) => {
    const orderNo = (row['CHANNEL_ORDER_NO'] || '').trim();
    const activationUser = (row['ACTIVATION_USER'] || '').trim();
    if (!orderNo || !activationUser) return null;
    const activationAssignDT = parseDateTime(row['ACTIVATION_ASSIGN_DATE'], row['ACTIVATION_ASSIGN_TIME']);
    const activationClaimDT = parseDateTime(row['ACTIVATION_CLAIM_DATE'], row['ACTIVATION_CLAIM_TIME']);
    const effectiveAssignDT = getEffectiveStartTime(activationAssignDT, 'activation');

    return {
      orderNo,
      agentName: activationUser,
      channel: row['CHANNEL'] || '',
      status: row['ESHOP_ORDER_STATUS'] || '',
      assignDT: activationAssignDT ? Timestamp.fromDate(activationAssignDT) : null,
      effectiveAssignDT: effectiveAssignDT ? Timestamp.fromDate(effectiveAssignDT) : null,
      claimDT: activationClaimDT ? Timestamp.fromDate(activationClaimDT) : null,
      claimed: !!activationClaimDT,
      claimTimeSec: diffSeconds(effectiveAssignDT, activationClaimDT),
      handleTimeSec: diffSeconds(activationAssignDT, activationClaimDT),
      completed: !!activationClaimDT,
      lastImportedAt: FieldValue.serverTimestamp(),
      importId,
    };
  };

  const salesCount = await processInChunks('orders', rows, processSalesOrder, 450, isLargeFile ? 50 : 0);
  const logisticsCount = await processInChunks('logisticsOrders', rows, processLogisticsOrder, 450, isLargeFile ? 50 : 0);
  const activationCount = await processInChunks('activationOrders', rows, processActivationOrder, 450, isLargeFile ? 50 : 0);

  // Save agent mappings (combined from both files)
  if (!isLargeFile || agents.length < 1000) {
    const existingSnap = await db.collection('agentMappings').get();
    const existing = {};
    existingSnap.forEach(d => {
      const data = d.data();
      if (data.agentCode) existing[data.agentCode.toUpperCase()] = data;
    });

    const parsedAgents = [];
    const agentSet = new Set();
    rows.forEach(row => {  // `rows` is already the merged array
      extractAllAgentsFromRow(row).forEach(({ agentCode, agentType }) => {
        if (!agentCode || agentSet.has(agentCode.toUpperCase())) return;
        agentSet.add(agentCode.toUpperCase());
        parsedAgents.push({ agentCode, agentType });
      });
    });

    let batch = db.batch();
    let batchCount = 0;
    for (const agent of parsedAgents) {
      const code = (agent.agentCode || '').trim().toUpperCase();
      if (!code || existing[code]) continue;
      const ref = db.collection('agentMappings').doc(code);
      batch.set(ref, {
        agentCode: code,
        displayName: '',
        visible: false,
        agentType: agent.agentType || 'sales',
      });
      batchCount++;
      if (batchCount >= 400) {
        await commitWithRetry(batch);
        batch = db.batch();
        batchCount = 0;
      }
    }
    if (batchCount > 0) {
      await commitWithRetry(batch);
    }
  }

  // Schedule PDF reports to be sent 5 minutes after import (once per day)
  // Guard 1: check if auto email is enabled globally
  const emailSettingsSnap = await db.collection('emailSettings').doc('default').get();
  const autoEmailEnabled = emailSettingsSnap.exists
    ? emailSettingsSnap.data().autoEmailEnabled !== false
    : true; // default to enabled if doc doesn't exist

  if (autoEmailEnabled) {
    const dateKey    = new Date().toISOString().slice(0, 10); // e.g. '2026-04-01'
    const sendAt     = new Date(Date.now() + 5 * 60 * 1000);
    const pendingRef = db.collection('pendingReports').doc(dateKey);
    const existingPending = await pendingRef.get();
    // Guard 2: never schedule if an email was already sent today
    if (!existingPending.exists || existingPending.data().sent !== true) {
      await pendingRef.set({
        importId,
        sendAt:    Timestamp.fromDate(sendAt),
        sent:      false,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
  } else {
    console.log('[email] Auto email disabled — skipping schedule for this import.');
  }

  return {
    importId,
    agents: agents.length,
    summary,
    filename: filename || 'unknown.csv',
    ...(filename2 ? { filename2 } : {}),
    rowCount: totalRows,
    uniqueOrderCount: uniqueCount,
    portalOrderCount: portalCount,
    salesCount,
    logisticsCount,
    activationCount,
    isLargeFile,
  };
}

// ─── HTTP HANDLER ─────────────────────────────────────────────────────────────
export const autoImportCsv = onRequest(
  {
    cors: true,
    invoker: 'public',
    memory: '1GiB',
    timeoutSeconds: 540,
    maxInstances: 1,
    region: 'us-central1',
  },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Methods', 'POST');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.status(204).send('');
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    // Simple secret check
    const secret = req.query.secret || req.headers['x-webhook-secret'];
    if (secret !== WEBHOOK_SECRET) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    try {
      // ── Main file ──────────────────────────────────────────────────────────
      let csvText = req.body?.csv || req.body?.text;
      const filename = req.body?.filename || req.query?.filename || `auto-import-${new Date().toISOString()}.csv`;

      if (!csvText && req.body?.url) {
        const response = await fetch(req.body.url);
        if (!response.ok) throw new Error(`Failed to fetch CSV from URL: ${response.status}`);
        csvText = await response.text();
      }

      // Fallback: raw body
      if (!csvText) csvText = typeof req.body === 'string' ? req.body : null;

      if (!csvText || typeof csvText !== 'string') {
        res.status(400).json({ error: 'Missing CSV content. Send url, csv, or raw text in the body.' });
        return;
      }

      // ── Second file (portal / manually-created orders) — optional ──────────
      // Accepted as: url2 (fetched server-side), csv2, or text2
      let csvText2 = req.body?.csv2 || req.body?.text2 || null;
      const filename2 = req.body?.filename2 || null;

      if (!csvText2 && req.body?.url2) {
        const res2 = await fetch(req.body.url2);
        if (!res2.ok) throw new Error(`Failed to fetch portal CSV from url2: ${res2.status}`);
        csvText2 = await res2.text();
      }

      const result = await runImport(csvText, filename, csvText2, filename2);

      // Immediately send reports after import — don't wait for the scheduled function
      // Guard: only send if emails haven't been sent today already
      const todayKey = new Date().toISOString().slice(0, 10);
      const pendingRef = db.collection('pendingReports').doc(todayKey);
      const pendingDoc = await pendingRef.get();
      const alreadySentToday = pendingDoc.exists && pendingDoc.data().sent === true;
      
      if (!alreadySentToday) {
        try {
          await sendAllReports(result.importId);
          await pendingRef.set({ sent: true, sentAt: FieldValue.serverTimestamp() }, { merge: true });
        } catch (emailErr) {
          console.error('Auto-import: failed to send reports:', emailErr);
          result.emailError = emailErr.message;
        }
      } else {
        console.log(`[autoImportCsv] Emails were already sent today (${todayKey}) — skipping send.`);
        result.emailSkipped = true;
        result.emailSkippedReason = 'Emails were already sent today';
      }

      res.status(200).json({ success: true, result });
    } catch (err) {
      console.error('Auto-import error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// ─── HTTP: SEND REPORTS NOW ───────────────────────────────────────────────────
export const sendReportsNow = onRequest(
  { cors: true, invoker: 'public', memory: '1GiB', timeoutSeconds: 540, region: 'us-central1' },
  async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }
    // Verify Firebase Auth ID token
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      await getAuth().verifyIdToken(token);
    } catch {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }
    try {
      const importId = req.body?.importId || null;
      await sendAllReports(importId);
      const todayKey   = new Date().toISOString().slice(0, 10);
      const pendingRef = db.collection('pendingReports').doc(todayKey);
      const existing   = await pendingRef.get();
      if (existing.exists) {
        await pendingRef.update({ sent: true, sentAt: FieldValue.serverTimestamp() });
      }
      res.status(200).json({ success: true });
    } catch (err) {
      console.error('sendReportsNow error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// ─── HTTP: SEND TEST REPORTS (to TEST_RECIPIENT only) ─────────────────────────
export const sendTestReportsNow = onRequest(
  { cors: true, invoker: 'public', memory: '1GiB', timeoutSeconds: 540, region: 'us-central1' },
  async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST')    { res.status(405).json({ error: 'Method not allowed' }); return; }

    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) { res.status(401).json({ error: 'Unauthorized' }); return; }
    try { await getAuth().verifyIdToken(token); } catch { res.status(401).json({ error: 'Invalid token' }); return; }

    // Guard: real auto email must have been sent today before allowing a test send.
    // Filter isTest in-memory to avoid needing a Firestore composite index.
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const sentTodaySnap = await db.collection('emailHistory')
      .where('sentAt', '>=', Timestamp.fromDate(todayStart))
      .get();
    const hasRealEmailToday = sentTodaySnap.docs.some(d => !d.data().isTest);
    if (!hasRealEmailToday) {
      res.status(400).json({ error: 'Real reports have not been sent today yet. Send real reports first.' });
      return;
    }

    try {
      const importId = req.body?.importId || null;
      await sendAllReports(importId, TEST_RECIPIENT);
      res.status(200).json({ success: true });
    } catch (err) {
      console.error('sendTestReportsNow error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// ─── DOWNLOAD PDF ─────────────────────────────────────────────────────────────
// Returns the same PDF that would be emailed for a given department + date range.
// Used by the "Save as PDF" button so both paths produce identical output.
export const downloadPDF = onRequest(
  { cors: true, invoker: 'public', memory: '1GiB', timeoutSeconds: 300, region: 'us-central1' },
  async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST')    { res.status(405).json({ error: 'Method not allowed' }); return; }

    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) { res.status(401).json({ error: 'Unauthorized' }); return; }
    try { await getAuth().verifyIdToken(token); } catch { res.status(401).json({ error: 'Invalid token' }); return; }

    const { dept, from, to } = req.body || {};
    if (!dept || !from || !to) { res.status(400).json({ error: 'Missing dept, from, or to' }); return; }

    const fromDate = new Date(from);
    const toDate   = new Date(to);
    const fromTs   = Timestamp.fromDate(fromDate);
    const toTs     = Timestamp.fromDate(toDate);
    const dateRange = `${fromDate.toLocaleDateString('en-GB')} – ${toDate.toLocaleDateString('en-GB')}`;

    const needSales = dept === 'sales'      || dept === 'management';
    const needLog   = dept === 'logistics'  || dept === 'management';
    const needAct   = dept === 'activation' || dept === 'management';

    const [salesSnap, logSnap, actSnap, slaSnap] = await Promise.all([
      needSales ? db.collection('orders').where('orderDT', '>=', fromTs).where('orderDT', '<=', toTs).get()                   : Promise.resolve({ docs: [] }),
      needLog   ? db.collection('logisticsOrders').where('assignDT', '>=', fromTs).where('assignDT', '<=', toTs).get()        : Promise.resolve({ docs: [] }),
      needAct   ? db.collection('activationOrders').where('assignDT', '>=', fromTs).where('assignDT', '<=', toTs).get()       : Promise.resolve({ docs: [] }),
      db.collection('slaSettings').limit(1).get(),
    ]);

    const slaData         = slaSnap.empty ? {} : slaSnap.docs[0].data();
    const slaSalesSec     = ((slaData.sales      || {}).workingHours || 120) * 60;
    const slaLogisticsSec = ((slaData.logistics  || {}).workingHours || 120) * 60;
    const slaActSec       = ((slaData.activation || {}).workingHours || 120) * 60;

    const salesStats = statsFromDocs(salesSnap.docs, 'claimTimeSec');
    const logStats   = statsFromDocs(logSnap.docs,   'claimTimeSec');
    const actStats   = statsFromDocs(actSnap.docs,   'handleTimeSec');

    const salesAvgTime = safeAvg(salesStats.map(a => a.avgTime).filter(Boolean));
    const logAvgTime   = safeAvg(logStats.map(a => a.avgTime).filter(Boolean));
    const actAvgTime   = safeAvg(actStats.map(a => a.avgTime).filter(Boolean));
    const totalOrders  = salesSnap.docs.length;
    const totalClaimed = salesSnap.docs.filter(d => d.data().claimed).length;

    let pdfBuffer;

    if (dept === 'sales') {
      const rate = totalOrders ? Math.round(totalClaimed / totalOrders * 100) : 0;
      pdfBuffer = await buildPDF({
        title: 'Sales Performance Report', department: 'sales', dateRange, slaSeconds: slaSalesSec,
        kpis: [
          { label: 'Total Orders',   value: totalOrders.toLocaleString(),   badge: 'total' },
          { label: 'Claimed',        value: totalClaimed.toLocaleString(),  badge: `${rate}% rate` },
          { label: 'Claim Rate',     value: `${rate}%`,                     badge: 'of orders' },
          { label: 'Avg Claim Time', value: fmtTime(salesAvgTime),          badge: salesAvgTime > slaSalesSec ? 'SLA Exceeded' : 'team avg', exceeded: salesAvgTime > slaSalesSec },
          { label: 'Agents',         value: String(salesStats.length),      badge: 'active' },
        ],
        columns: ['Agent', 'Orders', 'Claimed', 'Claim Rate', 'Avg Claim Time', 'Bad Handling'],
        rows: salesStats,
      });
    } else if (dept === 'logistics') {
      const logOrders  = logStats.reduce((s, a) => s + a.orders,  0);
      const logClaimed = logStats.reduce((s, a) => s + a.claimed, 0);
      const rate = logOrders ? Math.round(logClaimed / logOrders * 100) : 0;
      pdfBuffer = await buildPDF({
        title: 'Logistics Performance Report', department: 'logistics', dateRange, slaSeconds: slaLogisticsSec,
        kpis: [
          { label: 'Total Assigned', value: logOrders.toLocaleString(),    badge: 'total' },
          { label: 'Claimed',        value: logClaimed.toLocaleString(),   badge: `${rate}% rate` },
          { label: 'Claim Rate',     value: `${rate}%`,                    badge: 'of assigned' },
          { label: 'Avg Claim Time', value: fmtTime(logAvgTime),           badge: logAvgTime > slaLogisticsSec ? 'SLA Exceeded' : 'team avg', exceeded: logAvgTime > slaLogisticsSec },
          { label: 'Agents',         value: String(logStats.length),       badge: 'active' },
        ],
        columns: ['Agent', 'Assigned', 'Claimed', 'Claim Rate', 'Avg Claim Time', 'Bad Handling'],
        rows: logStats,
      });
    } else if (dept === 'activation') {
      const actOrders  = actStats.reduce((s, a) => s + a.orders,  0);
      const actClaimed = actStats.reduce((s, a) => s + a.claimed, 0);
      const rate = actOrders ? Math.round(actClaimed / actOrders * 100) : 0;
      pdfBuffer = await buildPDF({
        title: 'Activation Performance Report', department: 'activation', dateRange, slaSeconds: slaActSec,
        kpis: [
          { label: 'Total Assigned',  value: actOrders.toLocaleString(),   badge: 'total' },
          { label: 'Completed',       value: actClaimed.toLocaleString(),  badge: `${rate}% rate` },
          { label: 'Completion Rate', value: `${rate}%`,                   badge: 'of assigned' },
          { label: 'Avg Handle Time', value: fmtTime(actAvgTime),          badge: actAvgTime > slaActSec ? 'SLA Exceeded' : 'team avg', exceeded: actAvgTime > slaActSec },
          { label: 'Agents',          value: String(actStats.length),      badge: 'active' },
        ],
        columns: ['Agent', 'Assigned', 'Completed', 'Completion Rate', 'Avg Handle Time', 'Bad Handling'],
        rows: actStats,
      });
    } else if (dept === 'management') {
      const salesRate = totalOrders ? Math.round(totalClaimed / totalOrders * 100) : 0;
      const top5 = arr => arr.slice(0, 5);
      pdfBuffer = await buildPDF({
        title: 'Management Summary Report', department: 'management', dateRange,
        slaSeconds: Math.min(slaSalesSec, slaLogisticsSec, slaActSec),
        kpis: [
          { label: 'Total Orders',     value: totalOrders.toLocaleString(),  badge: 'total' },
          { label: 'Sales Claim Rate', value: `${salesRate}%`,               badge: 'sales' },
          { label: 'Avg Sales Claim',  value: fmtTime(salesAvgTime),         badge: salesAvgTime > slaSalesSec     ? 'SLA Exceeded' : 'team avg', exceeded: salesAvgTime > slaSalesSec },
          { label: 'Avg Log Claim',    value: fmtTime(logAvgTime),           badge: logAvgTime   > slaLogisticsSec ? 'SLA Exceeded' : 'team avg', exceeded: logAvgTime   > slaLogisticsSec },
          { label: 'Avg Act Handle',   value: fmtTime(actAvgTime),           badge: actAvgTime   > slaActSec       ? 'SLA Exceeded' : 'team avg', exceeded: actAvgTime   > slaActSec },
        ],
        columns: ['Agent / Section', 'Assigned', 'Claimed', 'Rate', 'Avg Time', 'Bad Handling'],
        rows: [
          ['── SALES ──',      '', '', '', '', ''],
          ...top5(salesStats),
          ['── LOGISTICS ──',  '', '', '', '', ''],
          ...top5(logStats),
          ['── ACTIVATION ──', '', '', '', '', ''],
          ...top5(actStats),
        ],
      });
    } else {
      res.status(400).json({ error: `Unknown dept: ${dept}` });
      return;
    }

    const filename = `${dept}-performance-report.pdf`;
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdfBuffer);
  }
);
