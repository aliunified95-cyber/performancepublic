import React, { useState, useEffect, useMemo } from 'react';
import {
  collection,
  query,
  orderBy,
  limit,
  getDocs,
} from 'firebase/firestore';
import { db } from '../firebase';
import Navbar from '../components/Navbar';
import PptxGenJS from 'pptxgenjs';

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const BAD_HANDLING_THRESHOLD_SEC = 60000;

const AVG_COLORS     = ['#87CEEB', '#1B3B6F', '#8B3A8B'];
const AVG_COLORS_HEX = ['87CEEB',  '1B3B6F',  '8B3A8B'];
const DELIVERY_COLOR     = '#00897B';
const DELIVERY_COLOR_HEX = '00897B';

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function fmtTime(sec) {
  if (!sec || isNaN(sec) || sec <= 0) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function avg(arr) {
  const v = arr.filter(x => x != null && !isNaN(x) && x >= 0);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}

function getMonthBounds(year, month) {
  return {
    from: new Date(year, month, 1, 0, 0, 0),
    to:   new Date(year, month + 1, 0, 23, 59, 59),
  };
}

function monthLabel(year, month) {
  return new Date(year, month, 1).toLocaleString('en-GB', { month: 'long', year: 'numeric' });
}

// ─── LOADING STATE ────────────────────────────────────────────────────────────
function LoadingState() {
  return (
    <div className="loading-state">
      <div className="spinner-lg" aria-hidden="true" />
      <p>Loading presentation data…</p>
    </div>
  );
}

// ─── SLIDE PREVIEW ────────────────────────────────────────────────────────────
function SlidePreview({ data, period }) {
  const { counts, averages, delivery } = data;

  return (
    <div className="pres-preview-card">
      {/* Left gradient stripe */}
      <div className="pres-left-stripe" />

      <div className="pres-preview-inner">
        <h2 className="pres-title">eShop Order Journey SLA</h2>
        <p className="pres-subtitle">{period}</p>

        {/* ── Section 1: Counts Hero ── */}
        <div className="pres-counts-row">
          <div className="pres-count-box">
            <div className="pres-count-value" style={{ color: '#7B3FA0' }}>
              {counts.claimedOrders.toLocaleString()}
            </div>
            <div className="pres-count-label">Orders Claimed</div>
          </div>
          <div className="pres-count-divider" />
          <div className="pres-count-box">
            <div className="pres-count-value" style={{ color: '#1B3B6F' }}>
              {counts.portalOrderCount.toLocaleString()}
            </div>
            <div className="pres-count-label">Created Orders</div>
          </div>
        </div>

        {/* ── Section 2: Averages Timeline ── */}
        <div className="pres-section-label">Average Handling Times</div>
        <div className="pres-timeline-wrap">
          <div className="pres-timeline-line" />
          <div className="pres-timeline-nodes pres-timeline-3">
            {averages.map((step, i) => (
              <div key={i} className="pres-timeline-node">
                <div className="pres-arrow" style={{ color: AVG_COLORS[i] }}>
                  <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
                    <path d="M8 5v14l11-7z"/>
                  </svg>
                </div>
                <div className="pres-node-connector" />
                <div className="pres-circle" style={{ borderColor: AVG_COLORS[i], color: AVG_COLORS[i] }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" width="24" height="24">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                </div>
                <div className="pres-node-title" style={{ color: AVG_COLORS[i] }}>{step.title}</div>
                <div className="pres-node-value">{step.formattedValue}</div>
                <div className="pres-node-desc">{step.description}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Section 3: Delivery Metrics ── */}
        <div className="pres-section-label">Delivery</div>
        <div className="pres-delivery-row">
          <div className="pres-delivery-box">
            <div className="pres-delivery-icon" style={{ color: DELIVERY_COLOR }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="22" height="22">
                <circle cx="12" cy="12" r="10"/>
                <polyline points="12 6 12 12 16 14"/>
              </svg>
            </div>
            <div>
              <div className="pres-delivery-value">{delivery.awbToFirstAttempt}</div>
              <div className="pres-delivery-label">AWB Creation → 1st Attempt</div>
            </div>
          </div>
          <div className="pres-delivery-box">
            <div className="pres-delivery-icon" style={{ color: DELIVERY_COLOR }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="22" height="22">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            </div>
            <div>
              <div className="pres-delivery-value">{delivery.awbToDelivered}</div>
              <div className="pres-delivery-label">AWB Creation → Delivered</div>
            </div>
          </div>
        </div>

        {/* Zain logo */}
        <div className="pres-logo">
          <img src="/zain-logo.svg" alt="Zain" />
        </div>
      </div>
    </div>
  );
}

// ─── PPT GENERATION ───────────────────────────────────────────────────────────
async function generatePPT(data, period, logoBase64) {
  const { counts, averages, delivery } = data;
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'WIDE', width: 13.33, height: 7.5 });
  pptx.layout = 'WIDE';

  const slide = pptx.addSlide();

  // Left gradient stripe
  slide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: 0.35, h: 3.75,
    fill: { type: 'solid', color: '87CEEB' },
  });
  slide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 3.75, w: 0.35, h: 3.75,
    fill: { type: 'solid', color: '7B3FA0' },
  });

  // Title
  slide.addText('eShop Order Journey SLA', {
    x: 0.7, y: 0.2, w: 8, h: 0.6,
    fontSize: 26, fontFace: 'Arial', bold: true,
    color: '333333',
  });

  // Subtitle
  slide.addText(period, {
    x: 0.7, y: 0.75, w: 8, h: 0.35,
    fontSize: 13, fontFace: 'Arial',
    color: '888888',
  });

  // ── Section 1: Counts ──
  const countY = 1.25;
  // Claimed box
  slide.addShape(pptx.ShapeType.roundRect, {
    x: 1.5, y: countY, w: 4.5, h: 0.9,
    fill: { type: 'solid', color: 'F3E8FF' },
    line: { color: '7B3FA0', width: 1.5 },
    rectRadius: 0.1,
  });
  slide.addText(counts.claimedOrders.toLocaleString(), {
    x: 1.5, y: countY, w: 2, h: 0.9,
    fontSize: 28, fontFace: 'Arial', bold: true,
    color: '7B3FA0', align: 'center', valign: 'middle',
  });
  slide.addText('Orders Claimed', {
    x: 3.3, y: countY, w: 2.5, h: 0.9,
    fontSize: 14, fontFace: 'Arial',
    color: '7B3FA0', align: 'left', valign: 'middle',
  });

  // Created box
  slide.addShape(pptx.ShapeType.roundRect, {
    x: 7.3, y: countY, w: 4.5, h: 0.9,
    fill: { type: 'solid', color: 'E8EEF8' },
    line: { color: '1B3B6F', width: 1.5 },
    rectRadius: 0.1,
  });
  slide.addText(counts.portalOrderCount.toLocaleString(), {
    x: 7.3, y: countY, w: 2, h: 0.9,
    fontSize: 28, fontFace: 'Arial', bold: true,
    color: '1B3B6F', align: 'center', valign: 'middle',
  });
  slide.addText('Created Orders', {
    x: 9.1, y: countY, w: 2.5, h: 0.9,
    fontSize: 14, fontFace: 'Arial',
    color: '1B3B6F', align: 'left', valign: 'middle',
  });

  // ── Section 2: Averages Timeline ──
  const avgSectionY = 2.45;
  slide.addText('Average Handling Times', {
    x: 0.7, y: avgSectionY, w: 5, h: 0.35,
    fontSize: 12, fontFace: 'Arial', bold: true,
    color: '666666',
  });

  const lineY = avgSectionY + 0.85;
  slide.addShape(pptx.ShapeType.line, {
    x: 2.0, y: lineY, w: 9.3, h: 0,
    line: { color: 'CCCCCC', width: 2.5 },
  });

  const xPositions = [3.0, 6.65, 10.3];
  const circleSize = 0.65;

  averages.forEach((step, i) => {
    const cx = xPositions[i];

    // Arrow marker
    slide.addText('\u25B6', {
      x: cx - 0.2, y: lineY - 0.55, w: 0.4, h: 0.4,
      fontSize: 16, fontFace: 'Arial',
      color: AVG_COLORS_HEX[i], align: 'center', valign: 'middle',
    });

    // Vertical connector
    slide.addShape(pptx.ShapeType.line, {
      x: cx, y: lineY, w: 0, h: 0.45,
      line: { color: AVG_COLORS_HEX[i], width: 1.5 },
    });

    // Circle
    slide.addShape(pptx.ShapeType.ellipse, {
      x: cx - circleSize / 2, y: lineY + 0.45, w: circleSize, h: circleSize,
      fill: { type: 'solid', color: 'FFFFFF' },
      line: { color: AVG_COLORS_HEX[i], width: 2 },
    });

    // Checkmark
    slide.addText('\u2713', {
      x: cx - circleSize / 2, y: lineY + 0.45, w: circleSize, h: circleSize,
      fontSize: 20, fontFace: 'Arial', bold: true,
      color: AVG_COLORS_HEX[i], align: 'center', valign: 'middle',
    });

    // Title
    slide.addText(step.title, {
      x: cx - 1.2, y: lineY + 1.2, w: 2.4, h: 0.35,
      fontSize: 12, fontFace: 'Arial', bold: true,
      color: AVG_COLORS_HEX[i], align: 'center',
    });

    // Value
    slide.addText(step.formattedValue, {
      x: cx - 1.2, y: lineY + 1.5, w: 2.4, h: 0.35,
      fontSize: 16, fontFace: 'Arial', bold: true,
      color: '333333', align: 'center',
    });

    // Description
    slide.addText(step.description, {
      x: cx - 1.2, y: lineY + 1.85, w: 2.4, h: 0.4,
      fontSize: 9, fontFace: 'Arial',
      color: '888888', align: 'center', lineSpacing: 13,
    });
  });

  // ── Section 3: Delivery ──
  const delY = 5.7;
  slide.addText('Delivery', {
    x: 0.7, y: delY, w: 3, h: 0.35,
    fontSize: 12, fontFace: 'Arial', bold: true,
    color: '666666',
  });

  // AWB Creation → 1st Attempt box
  slide.addShape(pptx.ShapeType.roundRect, {
    x: 1.5, y: delY + 0.45, w: 4.5, h: 0.8,
    fill: { type: 'solid', color: 'E0F2F1' },
    line: { color: DELIVERY_COLOR_HEX, width: 1.5 },
    rectRadius: 0.1,
  });
  slide.addText(delivery.awbToFirstAttempt, {
    x: 1.5, y: delY + 0.45, w: 2, h: 0.8,
    fontSize: 22, fontFace: 'Arial', bold: true,
    color: DELIVERY_COLOR_HEX, align: 'center', valign: 'middle',
  });
  slide.addText('AWB Creation → 1st Attempt', {
    x: 3.3, y: delY + 0.45, w: 2.5, h: 0.8,
    fontSize: 11, fontFace: 'Arial',
    color: '555555', align: 'left', valign: 'middle',
  });

  // AWB Creation → Delivered box
  slide.addShape(pptx.ShapeType.roundRect, {
    x: 7.3, y: delY + 0.45, w: 4.5, h: 0.8,
    fill: { type: 'solid', color: 'E0F2F1' },
    line: { color: DELIVERY_COLOR_HEX, width: 1.5 },
    rectRadius: 0.1,
  });
  slide.addText(delivery.awbToDelivered, {
    x: 7.3, y: delY + 0.45, w: 2, h: 0.8,
    fontSize: 22, fontFace: 'Arial', bold: true,
    color: DELIVERY_COLOR_HEX, align: 'center', valign: 'middle',
  });
  slide.addText('AWB Creation → Delivered', {
    x: 9.1, y: delY + 0.45, w: 2.5, h: 0.8,
    fontSize: 11, fontFace: 'Arial',
    color: '555555', align: 'left', valign: 'middle',
  });

  // Zain logo
  if (logoBase64) {
    slide.addImage({
      data: logoBase64,
      x: 0.5, y: 6.7, w: 1.4, h: 0.5,
    });
  }

  // Page number
  slide.addText('1', {
    x: 0.5, y: 6.9, w: 0.3, h: 0.3,
    fontSize: 10, fontFace: 'Arial', color: '999999',
  });

  const safePeriod = period.replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_');
  await pptx.writeFile({ fileName: `eShop_Order_Journey_${safePeriod}.pptx` });
}

// ─── MAIN PAGE ────────────────────────────────────────────────────────────────
export default function MonthlyPresentation() {
  const now = new Date();
  const [loadState, setLoadState]   = useState('loading');
  const [allOrders, setAllOrders]   = useState([]);
  const [allLogisticsOrders, setAllLogisticsOrders] = useState([]);
  const [allActivationOrders, setAllActivationOrders] = useState([]);
  const [allShipments, setAllShipments] = useState([]);
  const [agentMappings, setAgentMappings] = useState([]);
  const [logoBase64, setLogoBase64] = useState(null);
  const [selectedMonth, setSelectedMonth] = useState({
    year: now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear(),
    month: now.getMonth() === 0 ? 11 : now.getMonth() - 1,
  });

  useEffect(() => { loadData(); }, []);

  // Load Zain logo and convert to base64 for PPT embedding
  useEffect(() => {
    fetch('/zain-logo.svg')
      .then(r => r.text())
      .then(svgText => {
        const canvas = document.createElement('canvas');
        canvas.width = 400;
        canvas.height = 120;
        const ctx = canvas.getContext('2d');
        const img = new Image();
        img.onload = () => {
          ctx.drawImage(img, 0, 0, 400, 120);
          setLogoBase64(canvas.toDataURL('image/png'));
        };
        img.src = 'data:image/svg+xml;base64,' + btoa(svgText);
      })
      .catch(() => {});
  }, []);

  async function loadData() {
    setLoadState('loading');
    try {
      const importQ = query(collection(db, 'imports'), orderBy('importedAt', 'desc'), limit(1));
      const importSnap = await getDocs(importQ);

      if (importSnap.empty) {
        setLoadState('empty');
        return;
      }

      const [ordersSnap, logisticsSnap, activationSnap, shipmentsSnap, mappingsSnap] = await Promise.all([
        getDocs(query(collection(db, 'orders'), orderBy('orderDT', 'desc'), limit(10000))),
        getDocs(query(collection(db, 'logisticsOrders'), orderBy('assignDT', 'desc'), limit(10000))),
        getDocs(query(collection(db, 'activationOrders'), orderBy('assignDT', 'desc'), limit(10000))),
        getDocs(query(collection(db, 'deliveryShipments'), orderBy('shipmentDate', 'asc'))),
        getDocs(query(collection(db, 'agentMappings'), orderBy('agentCode', 'asc'))),
      ]);

      setAllOrders(ordersSnap.docs.map(d => {
        const data = d.data();
        return { ...data, orderDT: data.orderDT?.toDate ? data.orderDT.toDate() : null };
      }));

      setAllLogisticsOrders(logisticsSnap.docs.map(d => {
        const data = d.data();
        return { ...data, assignDT: data.assignDT?.toDate ? data.assignDT.toDate() : null };
      }));

      setAllActivationOrders(activationSnap.docs.map(d => {
        const data = d.data();
        return { ...data, assignDT: data.assignDT?.toDate ? data.assignDT.toDate() : null };
      }).filter(o => o.assignDT));

      setAllShipments(shipmentsSnap.docs.map(d => {
        const data = d.data();
        return {
          ...data,
          shipmentDate:  data.shipmentDate?.toDate  ? data.shipmentDate.toDate()  : (data.shipmentDate  ? new Date(data.shipmentDate)  : null),
          deliveredDate: data.deliveredDate?.toDate ? data.deliveredDate.toDate() : (data.deliveredDate ? new Date(data.deliveredDate) : null),
        };
      }));

      setAgentMappings(mappingsSnap.docs.map(d => ({ id: d.id, ...d.data() })));
      setLoadState('loaded');
    } catch (err) {
      console.error('Presentation load error:', err);
      setLoadState('empty');
    }
  }

  // Derive available months from all collections
  const monthOptions = useMemo(() => {
    const seen = new Set();
    allOrders.forEach(o => { if (o.orderDT) seen.add(`${o.orderDT.getFullYear()}-${o.orderDT.getMonth()}`); });
    allLogisticsOrders.forEach(o => { if (o.assignDT) seen.add(`${o.assignDT.getFullYear()}-${o.assignDT.getMonth()}`); });
    allActivationOrders.forEach(o => { if (o.assignDT) seen.add(`${o.assignDT.getFullYear()}-${o.assignDT.getMonth()}`); });
    allShipments.forEach(s => { if (s.shipmentDate) seen.add(`${s.shipmentDate.getFullYear()}-${s.shipmentDate.getMonth()}`); });
    [0, 1].forEach(offset => {
      const d = new Date(now.getFullYear(), now.getMonth() - offset, 1);
      seen.add(`${d.getFullYear()}-${d.getMonth()}`);
    });
    return Array.from(seen)
      .map(k => { const [y, m] = k.split('-').map(Number); return { year: y, month: m }; })
      .sort((a, b) => b.year - a.year || b.month - a.month);
  }, [allOrders, allLogisticsOrders, allActivationOrders, allShipments]);

  // Compute all presentation data
  const presData = useMemo(() => {
    if (loadState !== 'loaded') return null;

    const bounds = getMonthBounds(selectedMonth.year, selectedMonth.month);

    // Agent visibility helpers (exact match from Dashboard.jsx)
    const mappingMap = agentMappings.reduce((acc, m) => {
      if (m && m.agentCode) acc[m.agentCode.toUpperCase()] = m;
      return acc;
    }, {});

    const isVisible = (agentCode) => {
      const m = mappingMap[(agentCode || '').toUpperCase()];
      return !!(m && (m.displayName || '').trim() && m.visible !== false);
    };
    const isSalesAgent = (agentCode) => {
      const m = mappingMap[(agentCode || '').toUpperCase()];
      return !m || m.agentType === 'sales' || !m.agentType;
    };
    const isLogisticsAgent = (agentCode) => {
      const m = mappingMap[(agentCode || '').toUpperCase()];
      return !m || m.agentType === 'logistics';
    };
    const isActivationAgent = (agentCode) => {
      const m = mappingMap[(agentCode || '').toUpperCase()];
      return !m || m.agentType === 'activation';
    };

    // ── Filter by month ──
    const salesOrders = allOrders.filter(o => o.orderDT && o.orderDT >= bounds.from && o.orderDT <= bounds.to);
    const logisticsFiltered = allLogisticsOrders.filter(o => o.assignDT && o.assignDT >= bounds.from && o.assignDT <= bounds.to);
    const activationFiltered = allActivationOrders.filter(o => o.assignDT && o.assignDT >= bounds.from && o.assignDT <= bounds.to);
    const shipmentsFiltered = allShipments.filter(s => s.shipmentDate && s.shipmentDate >= bounds.from && s.shipmentDate <= bounds.to);

    // ── Filter by visible agents ──
    const visibleSalesOrders = salesOrders.filter(o => isSalesAgent(o.agentName) && isVisible(o.agentName));
    const visibleLogisticsOrders = logisticsFiltered.filter(o => isLogisticsAgent(o.agentName) && isVisible(o.agentName));
    const visibleActivationOrders = activationFiltered.filter(o => isActivationAgent(o.agentName) && isVisible(o.agentName));

    // ══════════════════════════════════════════════════════════════════════════
    // SECTION 1: COUNTS
    // ══════════════════════════════════════════════════════════════════════════
    const salesAgentMap = {};
    visibleSalesOrders.forEach(o => {
      const agent = o.agentName || '';
      if (!agent) return;
      if (!salesAgentMap[agent]) salesAgentMap[agent] = { orders: [] };
      salesAgentMap[agent].orders.push(o);
    });

    const salesAgentData = Object.values(salesAgentMap).map(a => {
      const portalOrders = a.orders.filter(o => (o.channel || '').trim().toLowerCase() === 'portal');
      const regularOrders = a.orders.filter(o => (o.channel || '').trim().toLowerCase() !== 'portal');
      const claimed = regularOrders.filter(o => o.claimed).length;
      const claimTimes = regularOrders
        .map(o => o.claimTimeSec)
        .filter(v => v != null && v >= 0 && v < 86400 && v <= BAD_HANDLING_THRESHOLD_SEC);
      return {
        claimed,
        portalCount: portalOrders.length,
        claimTimeSec: Math.round(avg(claimTimes)),
      };
    });

    const claimedOrders = salesAgentData.reduce((s, a) => s + a.claimed, 0);
    const portalOrderCount = salesAgentData.reduce((s, a) => s + a.portalCount, 0);
    const salesAvgClaimTimeSec = Math.round(avg(salesAgentData.map(a => a.claimTimeSec)));

    // ══════════════════════════════════════════════════════════════════════════
    // SECTION 2: AVERAGES (3-step timeline)
    // ══════════════════════════════════════════════════════════════════════════

    // Logistics: assign → activation assign
    const logisticsAgentMap = {};
    visibleLogisticsOrders.forEach(o => {
      const agent = o.agentName || '';
      if (!agent) return;
      if (!logisticsAgentMap[agent]) logisticsAgentMap[agent] = { orders: [] };
      logisticsAgentMap[agent].orders.push(o);
    });

    const logisticsAgentData = Object.values(logisticsAgentMap).map(a => {
      const activationTimes = a.orders
        .map(o => o.activationAssignTimeSec)
        .filter(v => v != null && v >= 0 && v <= BAD_HANDLING_THRESHOLD_SEC);
      return {
        assignTimeSec: Math.round(avg(activationTimes)),
      };
    });
    const logisticsAvgActivationTimeSec = Math.round(avg(logisticsAgentData.map(a => a.assignTimeSec)));

    // Activation: assign → complete
    const activationAgentMap = {};
    visibleActivationOrders.forEach(o => {
      const agent = o.agentName || '';
      if (!agent) return;
      if (!activationAgentMap[agent]) activationAgentMap[agent] = { orders: [] };
      activationAgentMap[agent].orders.push(o);
    });

    const activationAgentData = Object.values(activationAgentMap).map(a => {
      const handleTimes = a.orders
        .map(o => o.handleTimeSec)
        .filter(v => v != null && v >= 0 && v < 86400 && v <= BAD_HANDLING_THRESHOLD_SEC);
      return {
        handleTimeSec: Math.round(avg(handleTimes)),
      };
    });
    const activationAvgHandleTimeSec = Math.round(avg(activationAgentData.map(a => a.handleTimeSec)));

    // ══════════════════════════════════════════════════════════════════════════
    // SECTION 3: DELIVERY (from AWB creation / shipmentDate)
    // ══════════════════════════════════════════════════════════════════════════
    // awbToFirstAttemptSec and deliveryTimeSec are already stored in deliveryShipments
    const avgAwbToFirstAttemptSec = Math.round(avg(
      shipmentsFiltered.map(s => s.awbToFirstAttemptSec).filter(v => v != null)
    ));
    const avgAwbToDeliveredSec = Math.round(avg(
      shipmentsFiltered.filter(s => s.status === 'delivered').map(s => s.deliveryTimeSec).filter(v => v != null)
    ));

    return {
      counts: {
        claimedOrders,
        portalOrderCount,
      },
      averages: [
        {
          title: 'Sales',
          formattedValue: fmtTime(salesAvgClaimTimeSec),
          description: 'Creation → Claimed',
        },
        {
          title: 'Logistics',
          formattedValue: fmtTime(logisticsAvgActivationTimeSec),
          description: 'Assign → Activation Assign',
        },
        {
          title: 'Activation',
          formattedValue: fmtTime(activationAvgHandleTimeSec),
          description: 'Assign → Complete',
        },
      ],
      delivery: {
        awbToFirstAttempt: fmtTime(avgAwbToFirstAttemptSec),
        awbToDelivered: fmtTime(avgAwbToDeliveredSec),
      },
    };
  }, [loadState, allOrders, allLogisticsOrders, allActivationOrders, allShipments, agentMappings, selectedMonth]);

  const period = monthLabel(selectedMonth.year, selectedMonth.month);

  async function handleDownloadPPT() {
    if (presData) await generatePPT(presData, period, logoBase64);
  }

  return (
    <>
      <Navbar activeLink="presentation" />
      <div className="page">
        {loadState === 'loading' ? (
          <LoadingState />
        ) : loadState === 'empty' ? (
          <div className="loading-state">
            <p>No data available. Import a CSV via Admin to see data.</p>
          </div>
        ) : presData ? (
          <>
            <div className="page-header">
              <div>
                <h1>Monthly Presentation</h1>
                <p>
                  Showing data for: <strong>{period}</strong>
                </p>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '10px' }}>
                <button className="pdf-btn" onClick={handleDownloadPPT} style={{ gap: '6px' }}>
                  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                  Download as PPT
                </button>
                <div className="filter-bar">
                  {monthOptions.map(opt => {
                    const key = `${opt.year}-${opt.month}`;
                    const active = opt.year === selectedMonth.year && opt.month === selectedMonth.month;
                    return (
                      <button
                        key={key}
                        className={`filter-btn${active ? ' active' : ''}`}
                        onClick={() => setSelectedMonth(opt)}
                      >
                        {monthLabel(opt.year, opt.month)}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <SlidePreview data={presData} period={period} />
          </>
        ) : null}
      </div>
    </>
  );
}
