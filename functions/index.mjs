import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore';
import PDFDocument from 'pdfkit';
import nodemailer from 'nodemailer';

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
  const salesAgent = (row['SALES_USER_FIRST'] || row['SALESMAN_ID'] || '').trim();
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

// ─── PDF BUILDER ─────────────────────────────────────────────────────────────
function buildPDF({ title, department, dateRange, kpis, columns, rows: tableRows }) {
  return new Promise((resolve, reject) => {
    const COLORS = {
      sales:      '#1d4ed8',
      logistics:  '#b45309',
      activation: '#065f46',
      management: '#4c1d95',
    };
    const accent = COLORS[department] || '#1d4ed8';
    const PAGE_W = 595.28;
    const MARGIN = 40;
    const COL_W  = (PAGE_W - MARGIN * 2) / columns.length;
    const ROW_H  = 20;

    const doc    = new PDFDocument({ margin: MARGIN, size: 'A4' });
    const chunks = [];
    doc.on('data',  c => chunks.push(c));
    doc.on('end',   () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── Header banner
    doc.rect(0, 0, PAGE_W, 72).fill(accent);
    doc.fillColor('white')
       .fontSize(20).font('Helvetica-Bold').text(title, MARGIN, 18, { width: PAGE_W - MARGIN * 2 });
    doc.fontSize(10).font('Helvetica').text(dateRange, MARGIN, 46);

    // ── KPI boxes
    const KPI_TOP = 90;
    const KPI_W   = (PAGE_W - MARGIN * 2) / kpis.length;
    kpis.forEach((kpi, i) => {
      const x = MARGIN + i * KPI_W;
      doc.rect(x, KPI_TOP, KPI_W - 8, 52).fill('#f1f5f9').stroke('#cbd5e1');
      doc.fillColor('#64748b').fontSize(8).font('Helvetica')
         .text(kpi.label, x + 6, KPI_TOP + 7, { width: KPI_W - 14 });
      doc.fillColor('#0f172a').fontSize(15).font('Helvetica-Bold')
         .text(kpi.value, x + 6, KPI_TOP + 20, { width: KPI_W - 14 });
    });

    // ── Table header
    let y = KPI_TOP + 64;
    doc.rect(MARGIN, y, PAGE_W - MARGIN * 2, ROW_H).fill(accent);
    columns.forEach((col, i) => {
      doc.fillColor('white').fontSize(8).font('Helvetica-Bold')
         .text(col, MARGIN + i * COL_W + 4, y + 6, { width: COL_W - 8 });
    });
    y += ROW_H;

    // ── Table rows
    tableRows.forEach((row, idx) => {
      if (y > 800) { doc.addPage(); y = MARGIN; }
      doc.rect(MARGIN, y, PAGE_W - MARGIN * 2, ROW_H).fill(idx % 2 === 0 ? 'white' : '#f8fafc');
      row.forEach((cell, i) => {
        doc.fillColor('#1e293b').fontSize(8).font('Helvetica')
           .text(String(cell ?? '—'), MARGIN + i * COL_W + 4, y + 6, { width: COL_W - 8 });
      });
      y += ROW_H;
    });

    // ── Footer
    doc.fillColor('#94a3b8').fontSize(7)
       .text(`Generated: ${new Date().toLocaleString('en-GB')}  ·  Team Performance System`,
             MARGIN, doc.page.height - 30, { width: PAGE_W - MARGIN * 2, align: 'center' });

    doc.end();
  });
}

// ─── EMAIL SENDER ─────────────────────────────────────────────────────────────
async function sendReport({ to, subject, html, pdfBuffer, filename }) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_PASS },
  });
  await transporter.sendMail({
    from: `"Team Performance" <${GMAIL_USER}>`,
    to:   Array.isArray(to) ? to.join(', ') : to,
    subject,
    html,
    attachments: [{ filename, content: pdfBuffer, contentType: 'application/pdf' }],
  });
}

// ─── GENERATE + SEND ALL REPORTS ─────────────────────────────────────────────
async function sendAllReports(importId) {
  if (!GMAIL_USER || !GMAIL_PASS) return;

  // Determine which period to report on based on today's date
  const period = getReportPeriod();
  const fromTs = Timestamp.fromDate(period.from);
  const toTs   = Timestamp.fromDate(period.to);

  // Query Firestore for the correct date range
  const [salesSnap, logSnap, actSnap] = await Promise.all([
    db.collection('orders').where('orderDT', '>=', fromTs).where('orderDT', '<=', toTs).get(),
    db.collection('logisticsOrders').where('assignDT', '>=', fromTs).where('assignDT', '<=', toTs).get(),
    db.collection('activationOrders').where('assignDT', '>=', fromTs).where('assignDT', '<=', toTs).get(),
  ]);

  function statsFromDocs(docs, timeField) {
    const map = {};
    docs.forEach(d => {
      const data = d.data();
      const agent = data.agentName || '';
      if (!agent) return;
      if (!map[agent]) map[agent] = { orders: 0, claimed: 0, times: [] };
      map[agent].orders++;
      if (data.claimed) {
        map[agent].claimed++;
        const t = data[timeField];
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

  const salesStats = statsFromDocs(salesSnap.docs,  'claimTimeSec');
  const logStats   = statsFromDocs(logSnap.docs,    'claimTimeSec');
  const actStats   = statsFromDocs(actSnap.docs,    'handleTimeSec');

  const salesAvgTime = safeAvg(salesStats.map(a => a.avgTime).filter(Boolean));
  const logAvgTime   = safeAvg(logStats.map(a => a.avgTime).filter(Boolean));
  const actAvgTime   = safeAvg(actStats.map(a => a.avgTime).filter(Boolean));

  const totalOrders  = salesSnap.docs.length;
  const totalClaimed = salesSnap.docs.filter(d => d.data().claimed).length;

  const dateRange = period.label;
  const dateTag   = period.from.toISOString().slice(0, 10);

  const emailHtml = (dept) => `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
      <div style="background:#1d4ed8;padding:24px 32px;border-radius:8px 8px 0 0">
        <h2 style="color:white;margin:0">Team Performance Report</h2>
        <p style="color:#bfdbfe;margin:6px 0 0">${dept} · ${dateRange}</p>
      </div>
      <div style="background:#f8fafc;padding:24px 32px;border:1px solid #e2e8f0;border-top:none">
        <p style="color:#334155">Hi,</p>
        <p style="color:#334155">Please find attached the <strong>${dept} Performance Report</strong> for <strong>${dateRange}</strong>.</p>
        <p style="color:#334155">This report was generated automatically after the latest data import.</p>
        <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0">
        <p style="color:#64748b;font-size:13px;margin:0">
          Automated report developed by <strong>Ali Isa Mohsen</strong> 36030791
        </p>
      </div>
    </div>`;

  // ── Sales PDF
  const salesPDF = await buildPDF({
    title: 'Sales Performance Report', department: 'sales', dateRange,
    kpis: [
      { label: 'Total Orders',   value: totalOrders.toLocaleString() },
      { label: 'Claimed',        value: totalClaimed.toLocaleString() },
      { label: 'Claim Rate',     value: totalOrders ? `${Math.round(totalClaimed / totalOrders * 100)}%` : '—' },
      { label: 'Avg Claim Time', value: fmtTime(salesAvgTime) },
      { label: 'Agents',         value: String(salesStats.length) },
    ],
    columns: ['Agent', 'Orders', 'Claimed', 'Claim Rate', 'Avg Claim Time'],
    rows: salesStats.map(a => [a.name, a.orders, a.claimed, `${a.rate}%`, fmtTime(a.avgTime)]),
  });

  // ── Logistics PDF
  const logOrders  = logStats.reduce((s, a) => s + a.orders,  0);
  const logClaimed = logStats.reduce((s, a) => s + a.claimed, 0);
  const logisticsPDF = await buildPDF({
    title: 'Logistics Performance Report', department: 'logistics', dateRange,
    kpis: [
      { label: 'Total Assigned', value: logOrders.toLocaleString() },
      { label: 'Claimed',        value: logClaimed.toLocaleString() },
      { label: 'Claim Rate',     value: logOrders ? `${Math.round(logClaimed / logOrders * 100)}%` : '—' },
      { label: 'Avg Claim Time', value: fmtTime(logAvgTime) },
      { label: 'Agents',         value: String(logStats.length) },
    ],
    columns: ['Agent', 'Assigned', 'Claimed', 'Claim Rate', 'Avg Claim Time'],
    rows: logStats.map(a => [a.name, a.orders, a.claimed, `${a.rate}%`, fmtTime(a.avgTime)]),
  });

  // ── Activation PDF
  const actOrders  = actStats.reduce((s, a) => s + a.orders,  0);
  const actClaimed = actStats.reduce((s, a) => s + a.claimed, 0);
  const activationPDF = await buildPDF({
    title: 'Activation Performance Report', department: 'activation', dateRange,
    kpis: [
      { label: 'Total Assigned',  value: actOrders.toLocaleString() },
      { label: 'Completed',       value: actClaimed.toLocaleString() },
      { label: 'Completion Rate', value: actOrders ? `${Math.round(actClaimed / actOrders * 100)}%` : '—' },
      { label: 'Avg Handle Time', value: fmtTime(actAvgTime) },
      { label: 'Agents',          value: String(actStats.length) },
    ],
    columns: ['Agent', 'Assigned', 'Completed', 'Completion Rate', 'Avg Handle Time'],
    rows: actStats.map(a => [a.name, a.orders, a.claimed, `${a.rate}%`, fmtTime(a.avgTime)]),
  });

  // ── Management PDF
  const top5 = arr => arr.slice(0, 5);
  const managementPDF = await buildPDF({
    title: 'Management Summary Report', department: 'management', dateRange,
    kpis: [
      { label: 'Total Orders',     value: totalOrders.toLocaleString() },
      { label: 'Sales Claim Rate', value: totalOrders ? `${Math.round(totalClaimed / totalOrders * 100)}%` : '—' },
      { label: 'Avg Sales Claim',  value: fmtTime(salesAvgTime) },
      { label: 'Avg Log Claim',    value: fmtTime(logAvgTime) },
      { label: 'Avg Act Handle',   value: fmtTime(actAvgTime) },
    ],
    columns: ['Agent / Section', 'Assigned', 'Claimed', 'Rate', 'Avg Time'],
    rows: [
      ['── SALES ──', '', '', '', ''],
      ...top5(salesStats).map(a => [a.name, a.orders, a.claimed, `${a.rate}%`, fmtTime(a.avgTime)]),
      ['── LOGISTICS ──', '', '', '', ''],
      ...top5(logStats).map(a => [a.name, a.orders, a.claimed, `${a.rate}%`, fmtTime(a.avgTime)]),
      ['── ACTIVATION ──', '', '', '', ''],
      ...top5(actStats).map(a => [a.name, a.orders, a.claimed, `${a.rate}%`, fmtTime(a.avgTime)]),
    ],
  });

  await Promise.all([
    sendReport({ to: RECIPIENTS.sales,      subject: `Sales Performance Report – ${dateRange}`,      html: emailHtml('Sales'),      pdfBuffer: salesPDF,      filename: `sales-report-${dateTag}.pdf` }),
    sendReport({ to: RECIPIENTS.logistics,  subject: `Logistics Performance Report – ${dateRange}`,  html: emailHtml('Logistics'),  pdfBuffer: logisticsPDF,  filename: `logistics-report-${dateTag}.pdf` }),
    sendReport({ to: RECIPIENTS.activation, subject: `Activation Performance Report – ${dateRange}`, html: emailHtml('Activation'), pdfBuffer: activationPDF, filename: `activation-report-${dateTag}.pdf` }),
    sendReport({ to: RECIPIENTS.management, subject: `Management Summary Report – ${dateRange}`,     html: emailHtml('Management'), pdfBuffer: managementPDF, filename: `management-report-${dateTag}.pdf` }),
  ]);

  // Save to email history
  await db.collection('emailHistory').add({
    sentAt:     FieldValue.serverTimestamp(),
    importId,
    dateRange,
    rowCount:   totalOrders,
    reports:    ['Sales', 'Logistics', 'Activation', 'Management'],
    recipients: RECIPIENTS,
    status:     'sent',
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
async function runImport(csvText, filename) {
  const { headers, rows } = parseCSV(csvText);
  if (!headers.length || !rows.length) {
    throw new Error('CSV is empty or invalid');
  }

  const headerSet = new Set(headers.map(h => h.trim()));
  const missing = ACTIVE_COLS.filter(c => !headerSet.has(c));
  if (missing.length > 0) {
    throw new Error(`Missing required columns: ${missing.join(', ')}`);
  }

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
    rowCount: totalRows,
    uniqueOrderCount: uniqueCount,
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

    return {
      orderNo,
      agentName: getRowAgentName(row),
      channel: row['CHANNEL'] || '',
      status: row['ESHOP_ORDER_STATUS'] || '',
      hoursType: row['HOURS_TYPE'] || '',
      orderDT: orderDT ? Timestamp.fromDate(orderDT) : null,
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

  // Save agent mappings
  if (!isLargeFile || agents.length < 1000) {
    const existingSnap = await db.collection('agentMappings').get();
    const existing = {};
    existingSnap.forEach(d => {
      const data = d.data();
      if (data.agentCode) existing[data.agentCode.toUpperCase()] = data;
    });

    const parsedAgents = [];
    const agentSet = new Set();
    rows.forEach(row => {
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
        visible: true,
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

  return {
    importId,
    agents: agents.length,
    summary,
    filename: filename || 'unknown.csv',
    rowCount: totalRows,
    uniqueOrderCount: uniqueCount,
    salesCount,
    logisticsCount,
    activationCount,
    isLargeFile,
  };

  // Schedule PDF reports to be sent 5 minutes after import (once per day)
  const dateKey    = new Date().toISOString().slice(0, 10); // e.g. '2026-04-01'
  const sendAt     = new Date(Date.now() + 5 * 60 * 1000);
  const pendingRef = db.collection('pendingReports').doc(dateKey);
  const existing   = await pendingRef.get();
  // Only schedule if not already sent today
  if (!existing.exists || existing.data().sent !== true) {
    await pendingRef.set({
      importId,
      sendAt:    Timestamp.fromDate(sendAt),
      sent:      false,
      createdAt: FieldValue.serverTimestamp(),
    });
  }

  return {
    importId,
    agents: agents.length,
    summary,
    filename: filename || 'unknown.csv',
    rowCount: totalRows,
    uniqueOrderCount: uniqueCount,
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
      let csvText = req.body?.csv || req.body?.text;
      const filename = req.body?.filename || req.query?.filename || `auto-import-${new Date().toISOString()}.csv`;

      // If a URL was provided, fetch the CSV content from it
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

      const result = await runImport(csvText, filename);
      res.status(200).json({ success: true, result });
    } catch (err) {
      console.error('Auto-import error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  }
);
