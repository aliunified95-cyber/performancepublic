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

// ─── COLORS ────────────────────────────────────────────────────────────────────
const COLORS = {
  claimed:    '#7B3FA0',  // Purple  – Sales
  logistics:  '#E67E22',  // Orange  – Logistics
  activation: '#2ECC8A',  // Emerald – Activation
  total:      '#1ABC9C',  // Teal    – Total
};

// Bad handling threshold: 1000 minutes = 60000 seconds
const BAD_HANDLING_THRESHOLD_SEC = 60000;

// No demo data - only real imported data is displayed

const FILTER_LABELS = {
  today:'Today', yesterday:'Yesterday', week:'This Week',
  lastmonth:'Last Month', month:'This Month', mtd:'Month to Date', quarter:'This Quarter', annual:'This Year',
};

// ─── HELPERS ───────────────────────────────────────────────────────────────────
function fmtTime(sec) {
  if (!sec || isNaN(sec)) return '0m 00s';
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

function getRangeBounds(range, customDates) {
  const now = new Date();
  const y   = now.getFullYear();
  const mo  = now.getMonth();
  const d   = now.getDate();

  if (range === 'today')     return { from: new Date(y, mo, d, 0, 0, 0),      to: new Date(y, mo, d, 23, 59, 59) };
  if (range === 'yesterday') return { from: new Date(y, mo, d - 1, 0, 0, 0),  to: new Date(y, mo, d - 1, 23, 59, 59) };
  if (range === 'week')      return { from: new Date(y, mo, d - now.getDay()), to: now };
  if (range === 'month')     return { from: new Date(y, mo, 1),                to: now };
  if (range === 'mtd')       return { from: new Date(y, mo, 1),                to: now };
  if (range === 'quarter')   return { from: new Date(y, Math.floor(mo / 3) * 3, 1), to: now };
  if (range === 'annual')    return { from: new Date(y, 0, 1),                 to: now };
  if (range === 'lastmonth') return { from: new Date(y, mo - 1, 1, 0, 0, 0),  to: new Date(y, mo, 0, 23, 59, 59) };
  if (range === 'custom' && customDates.from && customDates.to) {
    return {
      from: new Date(customDates.from + 'T00:00:00'),
      to:   new Date(customDates.to   + 'T23:59:59'),
    };
  }
  return null;
}

// ─── SUB-COMPONENTS ────────────────────────────────────────────────────────────
function LoadingState() {
  return (
    <div className="loading-state">
      <div className="spinner-lg" aria-hidden="true" />
      <p>Loading dashboard data…</p>
    </div>
  );
}

function StageCard({ icon, title, count, avgTime, color, timeLabel, isLast }) {
  return (
    <div className="journey-stage">
      <div className="stage-header">
        <div className="stage-icon-wrap" style={{ background: `${color}20`, borderColor: `${color}40` }}>
          <div className="stage-icon" style={{ color }}>{icon}</div>
        </div>
        {!isLast && (
          <div className="stage-connector" style={{ background: `linear-gradient(90deg, ${color}, rgba(216,245,236,0.1))` }} />
        )}
      </div>
      <div className="stage-content">
        <div className="stage-title">{title}</div>
        <div className="stage-avg-main" style={{ color }}>{avgTime > 0 ? fmtTime(avgTime) : '—'}</div>
        <div className="stage-count-sub">{count.toLocaleString()} orders</div>
        <div className="stage-subtitle">{timeLabel}</div>
      </div>
    </div>
  );
}

function HandlingSection({ sales, logistics, activation, total }) {
  const items = [
    { label: 'Sales Handling Time',      time: sales,      color: COLORS.claimed,    sub: 'claim → logistics assign' },
    { label: 'Logistics Handling Time',  time: logistics,   color: COLORS.logistics,  sub: 'claim → activation assign' },
    { label: 'Activation Handling Time', time: activation,  color: COLORS.activation, sub: 'claim → complete' },
    { label: 'Total Handling Time',      time: total,       color: COLORS.total,      sub: 'combined average', isTotal: true },
  ];

  return (
    <div className="dash-handling-section">
      <div className="dash-handling-header">Handling Times</div>
      <div className="dash-handling-row">
        {items.map(item => (
          <div
            key={item.label}
            className="dash-handling-card"
            style={{ borderColor: item.isTotal ? `${item.color}50` : `${item.color}30` }}
          >
            <div className="dash-handling-label">{item.label}</div>
            <div className="dash-handling-time" style={{ color: item.color }}>
              {item.time > 0 ? fmtTime(item.time) : '—'}
            </div>
            <div className="dash-handling-sub">{item.sub}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function HeroBadge({ data, currentRange, customDates, importMeta, loadState }) {
  const label = currentRange === 'custom'
    ? `${customDates.from} → ${customDates.to}`
    : (FILTER_LABELS[currentRange] || 'All Time');

  const src = loadState === 'loaded'
    ? (importMeta?.filename || 'Imported Data')
    : 'Demo Data';

  const {
    claimedOrders,
    logisticsAssigned,
    activationAssigned,
    salesAvgClaimTimeSec,
    salesAvgAssignTimeSec,
    logisticsAvgClaimTimeSec,
    logisticsAvgActivationTimeSec,
    activationAvgClaimTimeSec,
    activationAvgHandleTimeSec,
    totalHandlingTimeSec,
  } = data;

  return (
    <div className="hero-badge dashboard-hero">
      <div className="hero-badge-label">
        <span className="dot" aria-hidden="true" />
        Team Performance Overview
      </div>
      <div className="hero-badge-title">
        Full Order Journey · {label} · {src}
      </div>

      {/* ── Pipeline stages ── */}
      <div className="journey-stages" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <StageCard
          icon={
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          }
          title="Orders Claimed"
          count={claimedOrders}
          avgTime={salesAvgClaimTimeSec}
          color={COLORS.claimed}
          timeLabel="avg claim time"
        />

        <StageCard
          icon={
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="1" y="3" width="15" height="13"/>
              <polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/>
              <circle cx="5.5" cy="18.5" r="2.5"/>
              <circle cx="18.5" cy="18.5" r="2.5"/>
            </svg>
          }
          title="Assigned to Logistics"
          count={logisticsAssigned}
          avgTime={logisticsAvgClaimTimeSec}
          color={COLORS.logistics}
          timeLabel="avg claim time"
        />

        <StageCard
          isLast
          icon={
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L2 7l10 5 10-5-10-5z"/>
              <path d="M2 17l10 5 10-5"/>
              <path d="M2 12l10 5 10-5"/>
            </svg>
          }
          title="Assigned to Activation"
          count={activationAssigned}
          avgTime={activationAvgClaimTimeSec}
          color={COLORS.activation}
          timeLabel="time to attend"
        />
      </div>

      {/* ── Handling times ── */}
      <HandlingSection
        sales={salesAvgAssignTimeSec}
        logistics={logisticsAvgActivationTimeSec}
        activation={activationAvgHandleTimeSec}
        total={totalHandlingTimeSec}
      />
    </div>
  );
}

// ─── MAIN PAGE ─────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const [loadState, setLoadState]         = useState('loading');
  const [importMeta, setImportMeta]       = useState(null);
  const [allOrders, setAllOrders]         = useState([]);
  const [allLogisticsOrders, setAllLogisticsOrders] = useState([]);
  const [allActivationOrders, setAllActivationOrders] = useState([]);
  const [currentRange, setCurrentRange]   = useState(() => localStorage.getItem('tpw_filter_range') || 'month');
  const [customDates, setCustomDates]     = useState(() => ({
    from: localStorage.getItem('tpw_filter_from') || '',
    to:   localStorage.getItem('tpw_filter_to')   || '',
  }));

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoadState('loading');
    try {
      // Check if there are any imports first
      const q    = query(collection(db, 'imports'), orderBy('importedAt', 'desc'), limit(1));
      const snap = await getDocs(q);

      if (snap.empty) {
        setLoadState('demo');
        localStorage.setItem('tpw_data_source', 'demo');
        return;
      }

      const docSnap = snap.docs[0];
      const meta    = { id: docSnap.id, ...docSnap.data() };
      setImportMeta(meta);

      // Load from global collections (deduplicated across all imports)
      // Limited to recent 30000 for performance with large datasets
      const [ordersSnap, logisticsSnap, activationSnap] = await Promise.all([
        getDocs(query(
          collection(db, 'orders'),
          orderBy('orderDT', 'desc'),
          limit(10000)
        )),
        getDocs(query(
          collection(db, 'logisticsOrders'),
          orderBy('assignDT', 'desc'),
          limit(10000)
        )),
        getDocs(query(
          collection(db, 'activationOrders'),
          orderBy('assignDT', 'desc'),
          limit(10000)
        )),
      ]);

      const orders = ordersSnap.docs.map(d => {
        const data = d.data();
        return {
          ...data,
          orderDT: data.orderDT?.toDate ? data.orderDT.toDate() : null,
        };
      });

      const logisticsOrders = logisticsSnap.docs.map(d => {
        const data = d.data();
        return {
          ...data,
          assignDT: data.assignDT?.toDate ? data.assignDT.toDate() : null,
        };
      });

      const activationOrders = activationSnap.docs.map(d => {
        const data = d.data();
        return {
          ...data,
          assignDT: data.assignDT?.toDate ? data.assignDT.toDate() : null,
        };
      }).filter(o => o.assignDT);

      setAllOrders(orders);
      setAllLogisticsOrders(logisticsOrders);
      setAllActivationOrders(activationOrders);
      setLoadState('loaded');
      localStorage.setItem('tpw_data_source', 'live');
    } catch (err) {
      console.error('Load error:', err);
      setLoadState('demo');
      localStorage.setItem('tpw_data_source', 'demo');
    }
  }

  const stats = useMemo(() => {
    if (loadState === 'loading' || loadState === 'demo' || loadState === 'error') {
      // No demo data - return zeros when no real data available
      return {
        claimedOrders:                0,
        logisticsAssigned:            0,
        activationAssigned:           0,
        salesAvgClaimTimeSec:         0,
        salesAvgAssignTimeSec:        0,
        logisticsAvgClaimTimeSec:     0,
        logisticsAvgActivationTimeSec: 0,
        activationAvgClaimTimeSec:    0,
        activationAvgHandleTimeSec:   0,
        totalHandlingTimeSec:         0,
      };
    }

    // ── Live data ──────────────────────────────────────────────────────────────
    const bounds = getRangeBounds(currentRange, customDates);

    const salesOrders = bounds
      ? allOrders.filter(o => o.orderDT && o.orderDT >= bounds.from && o.orderDT <= bounds.to)
      : allOrders;

    const logisticsFiltered = bounds
      ? allLogisticsOrders.filter(o => o.assignDT && o.assignDT >= bounds.from && o.assignDT <= bounds.to)
      : allLogisticsOrders;

    const activationFiltered = bounds
      ? allActivationOrders.filter(o => o.assignDT && o.assignDT >= bounds.from && o.assignDT <= bounds.to)
      : allActivationOrders;

    // Counts
    const claimedOrders    = salesOrders.filter(o => o.claimed).length;
    const logisticsAssigned  = logisticsFiltered.length;
    const activationAssigned = activationFiltered.length;

    // Sales metrics — same filtering as AgentsPerformance
    const salesClaimTimes  = salesOrders
      .map(o => o.claimTimeSec)
      .filter(v => v != null && v >= 0 && v < 86400 && v <= BAD_HANDLING_THRESHOLD_SEC);
    const salesAssignTimes = salesOrders
      .map(o => o.assignTimeSec)
      .filter(v => v != null && v >= 0 && v < 86400 && v <= BAD_HANDLING_THRESHOLD_SEC);

    // Logistics metrics — same filtering as LogisticsPerformance
    const logisticsClaimTimes = logisticsFiltered
      .map(o => o.claimTimeSec)
      .filter(v => v != null && v >= 0 && v < 86400 && v <= BAD_HANDLING_THRESHOLD_SEC);
    const logisticsActivationTimes = logisticsFiltered
      .map(o => o.activationAssignTimeSec)
      .filter(v => v != null && v >= 0 && v <= BAD_HANDLING_THRESHOLD_SEC);

    // Activation metrics — same filtering as ActivationPerformance
    const activationClaimTimes = activationFiltered
      .map(o => o.claimTimeSec)
      .filter(v => v != null && v >= 0 && v < 86400 && v <= BAD_HANDLING_THRESHOLD_SEC);
    const activationHandleTimes = activationFiltered
      .map(o => o.handleTimeSec)
      .filter(v => v != null && v >= 0 && v < 86400 && v <= BAD_HANDLING_THRESHOLD_SEC);

    const salesAvgAssignTimeSec         = Math.round(avg(salesAssignTimes));
    const logisticsAvgActivationTimeSec = Math.round(avg(logisticsActivationTimes));
    const activationAvgHandleTimeSec    = Math.round(avg(activationHandleTimes));

    return {
      claimedOrders,
      logisticsAssigned,
      activationAssigned,
      salesAvgClaimTimeSec:         Math.round(avg(salesClaimTimes)),
      salesAvgAssignTimeSec,
      logisticsAvgClaimTimeSec:     Math.round(avg(logisticsClaimTimes)),
      logisticsAvgActivationTimeSec,
      activationAvgClaimTimeSec:    Math.round(avg(activationClaimTimes)),
      activationAvgHandleTimeSec,
      totalHandlingTimeSec:         salesAvgAssignTimeSec + logisticsAvgActivationTimeSec + activationAvgHandleTimeSec,
    };
  }, [loadState, allOrders, allLogisticsOrders, allActivationOrders, currentRange, customDates]);

  function handleRangeChange(range) {
    setCurrentRange(range);
    localStorage.setItem('tpw_filter_range', range);
  }

  const label = currentRange === 'custom'
    ? (customDates.from && customDates.to ? `${customDates.from} → ${customDates.to}` : 'Custom Range')
    : (FILTER_LABELS[currentRange] || 'All Time');

  return (
    <>
      <Navbar activeLink="dashboard" />
      <div className="page dashboard-page">
        {loadState === 'loading' ? (
          <LoadingState />
        ) : (
          <>
            <div className="page-header">
              <div>
                <h1>Team Performance Dashboard</h1>
                <p>
                  Showing data for: <strong>{label}</strong>
                  {loadState === 'demo' && (
                    <span style={{ color: 'rgba(216,245,236,0.4)', marginLeft: '8px' }}>
                      (no data — import a CSV via Admin to see data)
                    </span>
                  )}
                </p>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '10px' }}>
                <button className="pdf-btn" onClick={() => window.print()}>
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                  Save as PDF
                </button>
                <div className="filter-bar">
                  {['today','yesterday','week','lastmonth','month','mtd','quarter','annual'].map(r => (
                    <button
                      key={r}
                      className={`filter-btn${currentRange === r ? ' active' : ''}`}
                      onClick={() => handleRangeChange(r)}
                    >
                      {FILTER_LABELS[r]}
                    </button>
                  ))}
                  <div className="filter-separator" />
                  <div className="filter-custom">
                    <span>From</span>
                    <input
                      type="date"
                      value={customDates.from}
                      onChange={(e) => {
                        setCustomDates(d => ({ ...d, from: e.target.value }));
                        setCurrentRange('custom');
                        localStorage.setItem('tpw_filter_range', 'custom');
                        localStorage.setItem('tpw_filter_from', e.target.value);
                      }}
                      aria-label="Custom date from"
                    />
                    <span>To</span>
                    <input
                      type="date"
                      value={customDates.to}
                      onChange={(e) => {
                        setCustomDates(d => ({ ...d, to: e.target.value }));
                        setCurrentRange('custom');
                        localStorage.setItem('tpw_filter_range', 'custom');
                        localStorage.setItem('tpw_filter_to', e.target.value);
                      }}
                      aria-label="Custom date to"
                    />
                  </div>
                </div>
              </div>
            </div>

            <HeroBadge
              data={stats}
              currentRange={currentRange}
              customDates={customDates}
              importMeta={importMeta}
              loadState={loadState}
            />
          </>
        )}
      </div>
    </>
  );
}
