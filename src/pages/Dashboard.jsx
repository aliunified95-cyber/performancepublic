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
import { calculateSLAMetrics, formatMinutes, WORKING_HOURS } from '../utils/sla';

// ─── COLORS ────────────────────────────────────────────────────────────────────
const STAGE_COLORS = {
  created: '#3A7BD5',     // Blue
  claimed: '#7B3FA0',     // Purple
  logistics: '#E67E22',   // Orange
  activation: '#2ECC8A',  // Emerald
  total: '#1ABC9C',       // Teal
};

// Default SLA times in seconds (2 hours = 7200 seconds)
const DEFAULT_SLA = {
  sales: { workingHours: 7200, nonWorkingHours: 7200 },
  logistics: { workingHours: 7200, nonWorkingHours: 7200 },
  activation: { workingHours: 7200, nonWorkingHours: 7200 },
};

// ─── DEMO DATA ─────────────────────────────────────────────────────────────────
const DEMO_STATS = {
  totalOrders: 1250,
  claimedOrders: 1180,
  logisticsAssigned: 1150,
  activationAssigned: 1080,
  avgClaimTimeSec: 285,           // ~5 minutes
  avgLogisticsAssignTimeSec: 420, // ~7 minutes
  avgActivationAssignTimeSec: 1800, // ~30 minutes
  avgTotalJourneySec: 2520,       // ~42 minutes
};

const DEMO_MULTIPLIERS = {
  today: 0.035, yesterday: 0.033, week: 0.22,
  month: 1, mtd: 0.70, quarter: 3.1, annual: 12.5,
};

const FILTER_LABELS = {
  today:'Today', yesterday:'Yesterday', week:'This Week',
  month:'This Month', mtd:'Month to Date', quarter:'This Quarter', annual:'This Year',
};

// Bad handling threshold: 1000 minutes = 60000 seconds
const BAD_HANDLING_THRESHOLD_SEC = 60000;

// ─── HELPERS ───────────────────────────────────────────────────────────────────
function fmtTime(sec) {
  if (!sec || isNaN(sec)) return '0m 00s';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function fmtTimeShort(sec) {
  if (!sec || isNaN(sec)) return '0m';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function avg(arr) {
  const v = arr.filter(x => x != null && !isNaN(x) && x >= 0 && x <= BAD_HANDLING_THRESHOLD_SEC);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}

function getRangeBounds(range, customDates) {
  const now  = new Date();
  const y    = now.getFullYear();
  const mo   = now.getMonth();
  const d    = now.getDate();

  if (range === 'today')     return { from: new Date(y, mo, d, 0, 0, 0),      to: new Date(y, mo, d, 23, 59, 59) };
  if (range === 'yesterday') return { from: new Date(y, mo, d - 1, 0, 0, 0),  to: new Date(y, mo, d - 1, 23, 59, 59) };
  if (range === 'week')      return { from: new Date(y, mo, d - now.getDay()), to: now };
  if (range === 'month')     return { from: new Date(y, mo, 1),                to: now };
  if (range === 'mtd')       return { from: new Date(y, mo, 1),                to: now };
  if (range === 'quarter')   return { from: new Date(y, Math.floor(mo / 3) * 3, 1), to: now };
  if (range === 'annual')    return { from: new Date(y, 0, 1),                 to: now };
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

function JourneyStage({ 
  icon, 
  title, 
  count, 
  avgTime, 
  color, 
  isLast, 
  conversionRate,
  subtitle,
  slaExceeded,
  slaMinutes,
  showSLA = true
}) {
  // Check if SLA is exceeded
  const displayColor = slaExceeded ? '#E74C3C' : color;
  
  return (
    <div className="journey-stage">
      <div className="stage-header">
        <div className="stage-icon-wrap" style={{ background: `${displayColor}20`, borderColor: `${displayColor}40` }}>
          <div className="stage-icon" style={{ color: displayColor }}>
            {icon}
          </div>
        </div>
        {!isLast && (
          <div className="stage-connector" style={{ background: `linear-gradient(90deg, ${displayColor}, rgba(216,245,236,0.1))` }} />
        )}
      </div>
      <div className="stage-content">
        <div className="stage-title">{title}</div>
        <div className="stage-avg-main" style={{ color: displayColor }}>{avgTime > 0 ? fmtTime(avgTime) : '—'}</div>
        {showSLA && slaExceeded && (
          <div className="stage-sla-warning">SLA Exceeded</div>
        )}
        <div className="stage-count-sub">{count.toLocaleString()} orders</div>
        {subtitle && <div className="stage-subtitle">{subtitle}</div>}
        {conversionRate !== null && conversionRate !== undefined && (
          <div className="stage-conversion">
            <span className="conversion-badge" style={{ background: `${displayColor}20`, color: displayColor }}>
              {conversionRate}% conversion
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function TotalJourneyCard({ avgTotalTime, totalOrders }) {
  return (
    <div className="total-journey-card">
      <div className="total-journey-header">
        <div className="total-journey-icon" style={{ background: `${STAGE_COLORS.total}20` }}>
          <svg viewBox="0 0 24 24" style={{ stroke: STAGE_COLORS.total }} aria-hidden="true">
            <circle cx="12" cy="12" r="10"/>
            <polyline points="12 6 12 12 16 14"/>
          </svg>
        </div>
        <div>
          <div className="total-journey-title">Total Journey Time</div>
          <div className="total-journey-subtitle">End-to-end order processing</div>
        </div>
      </div>
      <div className="total-journey-time" style={{ color: STAGE_COLORS.total }}>
        {fmtTime(avgTotalTime)}
      </div>
      <div className="total-journey-avg">
        <span>Average across {totalOrders.toLocaleString()} orders</span>
      </div>
      <div className="total-journey-note">
        * Excluding orders with claim time &gt; 1000 min (bad handling)
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
    totalOrders, 
    claimedOrders, 
    logisticsAssigned, 
    activationAssigned,
    avgClaimTimeSec,
    avgLogisticsAssignTimeSec,
    avgActivationAssignTimeSec,
    avgTotalJourneySec,
    salesSLA,
    logisticsSLA,
    activationSLA,
  } = data;

  const claimRate = totalOrders > 0 ? Math.round((claimedOrders / totalOrders) * 100) : 0;
  const logisticsRate = claimedOrders > 0 ? Math.round((logisticsAssigned / claimedOrders) * 100) : 0;
  const activationRate = logisticsAssigned > 0 ? Math.round((activationAssigned / logisticsAssigned) * 100) : 0;

  return (
    <div className="hero-badge dashboard-hero">
      <div className="hero-badge-label">
        <span className="dot" aria-hidden="true" />
        Team Performance Overview
      </div>
      <div className="hero-badge-title">
        Full Order Journey · {label} · {src}
      </div>

      <div className="journey-container">
        <div className="journey-stages">
          <JourneyStage
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/>
                <line x1="3" y1="6" x2="21" y2="6"/>
                <path d="M16 10a4 4 0 0 1-8 0"/>
              </svg>
            }
            title="Orders Created"
            count={totalOrders}
            avgTime={0}
            color={STAGE_COLORS.created}
            conversionRate={null}
            subtitle="Starting point"
            showSLA={false}
          />

          <JourneyStage
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            }
            title="Orders Claimed"
            count={claimedOrders}
            avgTime={avgClaimTimeSec}
            color={STAGE_COLORS.claimed}
            conversionRate={claimRate}
            subtitle="Sales claim"
            slaExceeded={salesSLA?.avgWorkingMinutes > 120}
            slaMinutes={salesSLA?.avgWorkingMinutes}
          />

          <JourneyStage
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
            avgTime={avgLogisticsAssignTimeSec}
            color={STAGE_COLORS.logistics}
            conversionRate={logisticsRate}
            subtitle="Logistics assignment"
            slaExceeded={logisticsSLA?.avgWorkingMinutes > 120}
            slaMinutes={logisticsSLA?.avgWorkingMinutes}
          />

          <JourneyStage
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                <path d="M2 17l10 5 10-5"/>
                <path d="M2 12l10 5 10-5"/>
              </svg>
            }
            title="Assigned to Activation"
            count={activationAssigned}
            avgTime={avgActivationAssignTimeSec}
            color={STAGE_COLORS.activation}
            isLast={true}
            conversionRate={activationRate}
            subtitle="Activation assignment"
            slaExceeded={activationSLA?.avgWorkingMinutes > 120}
            slaMinutes={activationSLA?.avgWorkingMinutes}
          />
        </div>

        <TotalJourneyCard 
          avgTotalTime={avgTotalJourneySec} 
          totalOrders={totalOrders}
        />
      </div>
    </div>
  );
}

// ─── MAIN PAGE ─────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const [loadState, setLoadState]     = useState('loading');
  const [importMeta, setImportMeta]   = useState(null);
  const [allOrders, setAllOrders]     = useState([]);
  const [currentRange, setCurrentRange] = useState('month');
  const [customDates, setCustomDates] = useState({ from: '', to: '' });
  const [slaSettings, setSlaSettings] = useState(DEFAULT_SLA);

  useEffect(() => {
    loadData();
    loadSLASettings();
  }, []);

  async function loadSLASettings() {
    try {
      const slaSnap = await getDocs(query(collection(db, 'slaSettings'), limit(1)));
      if (!slaSnap.empty) {
        const data = slaSnap.docs[0].data();
        // Convert minutes to seconds
        setSlaSettings({
          sales: {
            workingHours: (data.sales?.workingHours || 120) * 60,
            nonWorkingHours: (data.sales?.nonWorkingHours || 120) * 60,
          },
          logistics: {
            workingHours: (data.logistics?.workingHours || 120) * 60,
            nonWorkingHours: (data.logistics?.nonWorkingHours || 120) * 60,
          },
          activation: {
            workingHours: (data.activation?.workingHours || 120) * 60,
            nonWorkingHours: (data.activation?.nonWorkingHours || 120) * 60,
          },
        });
      }
    } catch (err) {
      console.error('Error loading SLA:', err);
    }
  }

  async function loadData() {
    setLoadState('loading');
    try {
      const q    = query(collection(db, 'imports'), orderBy('importedAt', 'desc'), limit(1));
      const snap = await getDocs(q);

      if (snap.empty) {
        setLoadState('demo');
        localStorage.setItem('tpw_data_source', 'demo');
        return;
      }

      const docSnap   = snap.docs[0];
      const meta      = { id: docSnap.id, ...docSnap.data() };
      setImportMeta(meta);

      // Load orders with all timestamps for journey calculation
      const ordersSnap = await getDocs(query(
        collection(db, 'imports', docSnap.id, 'orders'), 
        orderBy('orderDT', 'desc'), 
        limit(5000)
      ));
      
      const orders = ordersSnap.docs.map(d => {
        const data = d.data();
        return {
          ...data,
          orderDT: data.orderDT?.toDate ? data.orderDT.toDate() : null,
          claimDT: data.claimDT?.toDate ? data.claimDT.toDate() : null,
          logisticsAssignDT: data.logisticsAssignDT?.toDate ? data.logisticsAssignDT.toDate() : null,
          activationAssignDT: data.activationAssignDT?.toDate ? data.activationAssignDT.toDate() : null,
        };
      });

      setAllOrders(orders);
      setLoadState('loaded');
      localStorage.setItem('tpw_data_source', 'live');
    } catch (err) {
      console.error('Load error:', err);
      setLoadState('demo');
      localStorage.setItem('tpw_data_source', 'demo');
    }
  }

  const stats = useMemo(() => {
    if (loadState === 'loading') return DEMO_STATS;

    if (loadState === 'demo' || loadState === 'error') {
      const mult = currentRange === 'custom'
        ? Math.max(1, customDates.from && customDates.to
            ? (Math.round((new Date(customDates.to) - new Date(customDates.from)) / 86400000) + 1) / 30
            : 1)
        : (DEMO_MULTIPLIERS[currentRange] ?? 1);

      return {
        totalOrders: Math.round(DEMO_STATS.totalOrders * mult),
        claimedOrders: Math.round(DEMO_STATS.claimedOrders * mult),
        logisticsAssigned: Math.round(DEMO_STATS.logisticsAssigned * mult),
        activationAssigned: Math.round(DEMO_STATS.activationAssigned * mult),
        avgClaimTimeSec: Math.round(DEMO_STATS.avgClaimTimeSec * (0.88 + Math.random() * 0.24)),
        avgLogisticsAssignTimeSec: Math.round(DEMO_STATS.avgLogisticsAssignTimeSec * (0.88 + Math.random() * 0.24)),
        avgActivationAssignTimeSec: Math.round(DEMO_STATS.avgActivationAssignTimeSec * (0.88 + Math.random() * 0.24)),
        avgTotalJourneySec: Math.round(DEMO_STATS.avgTotalJourneySec * (0.88 + Math.random() * 0.24)),
      };
    }

    // Live data calculation
    const bounds = getRangeBounds(currentRange, customDates);
    const filteredOrders = bounds
      ? allOrders.filter(o => o.orderDT && o.orderDT >= bounds.from && o.orderDT <= bounds.to)
      : allOrders;

    // Filter out bad handling orders (> 1000 min claim time)
    const validOrders = filteredOrders.filter(o => {
      if (!o.claimTimeSec) return true;
      return o.claimTimeSec <= BAD_HANDLING_THRESHOLD_SEC;
    });

    const totalOrders = validOrders.length;
    const claimedOrders = validOrders.filter(o => o.claimed).length;
    const logisticsAssigned = validOrders.filter(o => o.logisticsAssignDT).length;
    const activationAssigned = validOrders.filter(o => o.activationAssignDT).length;

    // Calculate SLA metrics using working minutes
    const slaConfig = {
      sales: { workingHours: (slaSettings?.sales?.workingHours || 120), nonWorkingHours: (slaSettings?.sales?.nonWorkingHours || 120) },
      logistics: { workingHours: (slaSettings?.logistics?.workingHours || 120), nonWorkingHours: (slaSettings?.logistics?.nonWorkingHours || 120) },
      activation: { workingHours: (slaSettings?.activation?.workingHours || 120), nonWorkingHours: (slaSettings?.activation?.nonWorkingHours || 120) },
    };

    // Calculate SLA metrics for each department
    const salesSLA = calculateSLAMetrics(validOrders, 'sales', slaConfig.sales);
    const logisticsSLA = calculateSLAMetrics(validOrders.filter(o => o.logisticsAssignDT), 'logistics', slaConfig.logistics);
    const activationSLA = calculateSLAMetrics(validOrders.filter(o => o.activationAssignDT), 'activation', slaConfig.activation);

    // Convert working minutes to seconds for display
    const avgClaimTimeSec = salesSLA.avgWorkingMinutes * 60;
    const avgLogisticsAssignTimeSec = logisticsSLA.avgWorkingMinutes * 60;
    const avgActivationAssignTimeSec = activationSLA.avgWorkingMinutes * 60;

    const totalJourneyTimes = validOrders
      .filter(o => o.orderDT && o.activationAssignDT)
      .map(o => (o.activationAssignDT - o.orderDT) / 1000)
      .filter(t => t >= 0 && t < 86400 * 7); // Max 7 days

    return {
      totalOrders,
      claimedOrders,
      logisticsAssigned,
      activationAssigned,
      avgClaimTimeSec,
      avgLogisticsAssignTimeSec,
      avgActivationAssignTimeSec,
      avgTotalJourneySec: Math.round(avg(totalJourneyTimes)),
      // SLA data
      salesSLA,
      logisticsSLA,
      activationSLA,
    };
  }, [loadState, allOrders, currentRange, customDates]);

  function handleRangeChange(range) {
    setCurrentRange(range);
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
                      (demo mode — import a CSV via Admin to see live data)
                    </span>
                  )}
                </p>
              </div>

              {/* Filter bar */}
              <div className="filter-bar">
                {['today','yesterday','week','month','mtd','quarter','annual'].map(r => (
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
                    }}
                    aria-label="Custom date to"
                  />
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
