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
const COLORS = [
  '#7B3FA0','#2ECC8A','#3A7BD5','#E67E22','#E74C3C',
  '#1ABC9C','#9B59B6','#F39C12','#16A085','#8E44AD',
  '#C0392B','#2980B9','#27AE60','#D35400','#E91E8C',
];

// ─── DEMO DATA ─────────────────────────────────────────────────────────────────
const DEMO_AGENTS = [
  { name:'Ahmed Hassan',     role:'Activation Lead',  initials:'AH', color:COLORS[0],  total:145, claimed:138, completed:128, claimTimeSec:185, handleTimeSec:520,  status:'active',  trend:'up' },
  { name:'Maria Garcia',     role:'Activation Agent', initials:'MG', color:COLORS[1],  total:132, claimed:125, completed:115, claimTimeSec:210, handleTimeSec:680,  status:'active',  trend:'up' },
  { name:'John Smith',       role:'Activation Agent', initials:'JS', color:COLORS[2],  total:128, claimed:120, completed:108, claimTimeSec:245, handleTimeSec:720,  status:'active',  trend:'neutral' },
  { name:'Fatima Al-Rashid', role:'Senior Activator', initials:'FA', color:COLORS[3],  total:118, claimed:115, completed:112, claimTimeSec:165, handleTimeSec:480,  status:'active',  trend:'up' },
  { name:'David Chen',       role:'Activation Agent', initials:'DC', color:COLORS[4],  total:115, claimed:108, completed:98,  claimTimeSec:280, handleTimeSec:850,  status:'away',    trend:'down' },
  { name:'Sarah Johnson',    role:'Activation Agent', initials:'SJ', color:COLORS[5],  total:108, claimed:95,  completed:88,  claimTimeSec:320, handleTimeSec:920,  status:'active',  trend:'down' },
  { name:'Michael Brown',    role:'Junior Activator', initials:'MB', color:COLORS[6],  total:95,  claimed:82,  completed:72,  claimTimeSec:380, handleTimeSec:1150, status:'offline', trend:'neutral' },
  { name:'Emma Wilson',      role:'Activation Agent', initials:'EW', color:COLORS[7],  total:102, claimed:98,  completed:94,  claimTimeSec:195, handleTimeSec:560,  status:'active',  trend:'up' },
  { name:'Omar Farouk',      role:'Activation Agent', initials:'OF', color:COLORS[8],  total:88,  claimed:85,  completed:80,  claimTimeSec:225, handleTimeSec:640,  status:'active',  trend:'up' },
  { name:'Lisa Anderson',    role:'Activation Agent', initials:'LA', color:COLORS[9],  total:92,  claimed:88,  completed:82,  claimTimeSec:240, handleTimeSec:690,  status:'away',    trend:'neutral' },
];

const DEMO_MULTIPLIERS = {
  today: 0.035, yesterday: 0.033, week: 0.22,
  month: 1, mtd: 0.70, quarter: 3.1, annual: 12.5,
};

const FILTER_LABELS = {
  today:'Today', yesterday:'Yesterday', week:'This Week',
  month:'This Month', mtd:'Month to Date', quarter:'This Quarter', annual:'This Year',
};

const ROWS_PER_PAGE = 1000;

// Default SLA: 2 hours = 7200 seconds
const DEFAULT_SLA_SECONDS = 7200;

// ─── HELPERS ───────────────────────────────────────────────────────────────────
function fmtTime(sec) {
  if (!sec || isNaN(sec)) return '0m 00s';
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function avg(arr) {
  const v = arr.filter(x => x != null && !isNaN(x) && x >= 0);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}

function barColor(pct) {
  if (pct >= 80) return 'var(--emerald)';
  if (pct >= 55) return 'var(--amethyst)';
  return '#E74C3C';
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
      <p>Loading activation data…</p>
    </div>
  );
}

function HeroBadge({ data, currentRange, customDates, importMeta, loadState, slaMinutes }) {
  const totalOrders   = data.reduce((s, a) => s + a.total, 0);
  const totalClaimed  = data.reduce((s, a) => s + a.claimed, 0);
  const totalCompleted = data.reduce((s, a) => s + a.completed, 0);
  const avgClaim      = Math.round(avg(data.map(a => a.claimTimeSec)));
  const avgHandle     = Math.round(avg(data.map(a => a.handleTimeSec)));
  const completionRate = totalClaimed > 0 ? Math.round((totalCompleted / totalClaimed) * 100) : 0;
  const slaSeconds = (slaMinutes || 120) * 60;
  const isSLAExceeded = avgClaim > slaSeconds;

  const label = currentRange === 'custom'
    ? `${customDates.from} → ${customDates.to}`
    : (FILTER_LABELS[currentRange] || 'All Time');

  const src = loadState === 'loaded'
    ? (importMeta?.filename || 'Imported Data')
    : 'Demo Data';

  const cm = Math.floor(avgClaim / 60), cs = avgClaim % 60;
  const hm = Math.floor(avgHandle / 60), hs = avgHandle % 60;

  return (
    <div className="hero-badge">
      <div className="hero-badge-label">
        <span className="dot" aria-hidden="true" />
        Activation Team Overview
      </div>
      <div className="hero-badge-title">
        All Agents · {label} · {src}
      </div>

      <div className="hero-kpis" style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
        {/* Total Assigned */}
        <div className="hero-kpi">
          <div className="hero-kpi-icon" style={{ background: 'rgba(46,204,138,0.18)' }}>
            <svg viewBox="0 0 24 24" style={{ stroke: 'var(--emerald)' }} aria-hidden="true">
              <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/>
              <line x1="3" y1="6" x2="21" y2="6"/>
              <path d="M16 10a4 4 0 0 1-8 0"/>
            </svg>
          </div>
          <div className="hero-kpi-value">{totalOrders.toLocaleString()}</div>
          <div className="hero-kpi-label">Total Assigned</div>
          <span className="hero-kpi-badge badge-neu">All agents</span>
        </div>

        {/* Claimed Orders */}
        <div className="hero-kpi">
          <div className="hero-kpi-icon" style={{ background: 'rgba(123,63,160,0.18)' }}>
            <svg viewBox="0 0 24 24" style={{ stroke: 'var(--amethyst)' }} aria-hidden="true">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </div>
          <div className="hero-kpi-value">{totalClaimed.toLocaleString()}</div>
          <div className="hero-kpi-label">Claimed Orders</div>
          <span className="hero-kpi-badge badge-neu">
            {totalOrders > 0 ? Math.round((totalClaimed / totalOrders) * 100) : 0}% rate
          </span>
        </div>

        {/* Completion Rate */}
        <div className="hero-kpi">
          <div className="hero-kpi-icon" style={{ background: 'rgba(46,204,138,0.1)' }}>
            <svg viewBox="0 0 24 24" style={{ stroke: 'var(--emerald)' }} aria-hidden="true">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
              <polyline points="22 4 12 14.01 9 11.01"/>
            </svg>
          </div>
          <div className="hero-kpi-value">{completionRate}<sup>%</sup></div>
          <div className="hero-kpi-label">Completion Rate</div>
          <span className="hero-kpi-badge badge-neu">of claimed</span>
        </div>

        {/* Avg Claim Time */}
        <div className="hero-kpi">
          <div className="hero-kpi-icon" style={{ background: isSLAExceeded ? 'rgba(231,76,60,0.15)' : 'rgba(216,245,236,0.08)' }}>
            <svg viewBox="0 0 24 24" style={{ stroke: isSLAExceeded ? '#E74C3C' : 'var(--mint)' }} aria-hidden="true">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="12 6 12 12 16 14"/>
            </svg>
          </div>
          <div className="hero-kpi-value" style={{ color: isSLAExceeded ? '#E74C3C' : 'inherit' }}>
            {cm}<sup>m {String(cs).padStart(2, '0')}s</sup>
          </div>
          <div className="hero-kpi-label">Avg Claim Time</div>
          <span className="hero-kpi-badge badge-neu" style={{ color: isSLAExceeded ? '#E74C3C' : 'inherit', background: isSLAExceeded ? 'rgba(231,76,60,0.12)' : '' }}>
            {isSLAExceeded ? 'SLA Exceeded' : 'assign→claim'}
          </span>
        </div>

        {/* Avg Handle Time */}
        <div className="hero-kpi">
          <div className="hero-kpi-icon" style={{ background: 'rgba(255,193,7,0.12)' }}>
            <svg viewBox="0 0 24 24" style={{ stroke: '#ffc107' }} aria-hidden="true">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="12 6 12 12 8 14"/>
            </svg>
          </div>
          <div className="hero-kpi-value">
            {hm}<sup>m {String(hs).padStart(2, '0')}s</sup>
          </div>
          <div className="hero-kpi-label">Avg Handle Time</div>
          <span className="hero-kpi-badge badge-neu">claim→complete</span>
        </div>
      </div>
    </div>
  );
}

function AgentTable({ data, searchQuery, onSearch, sortState, onSort, page, onPage, slaMinutes }) {
  const slaSeconds = (slaMinutes || 120) * 60;
  const query2 = searchQuery.toLowerCase();
  let filtered = data.filter(a =>
    a.name.toLowerCase().includes(query2) || (a.role || '').toLowerCase().includes(query2)
  );

  filtered = [...filtered].sort((a, b) => {
    const { col, dir } = sortState;
    if (col === 'name')       return dir === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
    if (col === 'status')     return dir === 'asc' ? (a.status||'').localeCompare(b.status||'') : (b.status||'').localeCompare(a.status||'');
    if (col === 'trend')      return dir === 'asc' ? (a.trend||'').localeCompare(b.trend||'') : (b.trend||'').localeCompare(a.trend||'');
    let av, bv;
    if (col === 'total')       { av = a.total;       bv = b.total; }
    else if (col === 'claimed')     { av = a.claimed;     bv = b.claimed; }
    else if (col === 'completed')   { av = a.completed;   bv = b.completed; }
    else if (col === 'completionRate') { av = a.completed / Math.max(1, a.claimed); bv = b.completed / Math.max(1, b.claimed); }
    else if (col === 'claimTime')   { av = a.claimTimeSec;  bv = b.claimTimeSec; }
    else if (col === 'handleTime')  { av = a.handleTimeSec; bv = b.handleTimeSec; }
    else { av = a.total; bv = b.total; }
    return dir === 'asc' ? av - bv : bv - av;
  });

  const total     = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / ROWS_PER_PAGE));
  const safePage   = Math.min(page, totalPages);
  const paged      = filtered.slice((safePage - 1) * ROWS_PER_PAGE, safePage * ROWS_PER_PAGE);

  const cols = [
    { key: 'name',            label: 'Agent' },
    { key: 'total',           label: 'Total Assigned' },
    { key: 'claimed',         label: 'Claimed' },
    { key: 'completed',       label: 'Completed' },
    { key: 'completionRate',  label: 'Completion Rate' },
    { key: 'claimTime',       label: 'Avg Claim Time' },
    { key: 'handleTime',      label: 'Avg Handle Time' },
    { key: 'status',          label: 'Status' },
    { key: 'trend',           label: 'Trend' },
  ];

  function SortIcon({ colKey }) {
    const active = sortState.col === colKey;
    const arrow  = active ? (sortState.dir === 'asc' ? '↑' : '↓') : '↕';
    return <span className="sort-icon" aria-hidden="true">{arrow}</span>;
  }

  return (
    <>
      <div className="section-header">
        <div>
          <div className="section-title">Agent Breakdown</div>
          <div className="section-sub">Individual activation performance per agent</div>
        </div>
        <div className="search-wrap">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="8"/>
            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            type="text"
            className="search-input"
            placeholder="Search agent…"
            value={searchQuery}
            onChange={(e) => { onSearch(e.target.value); onPage(1); }}
            aria-label="Search agents"
          />
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {cols.map(c => (
                <th
                  key={c.key}
                  className={sortState.col === c.key ? 'sorted' : ''}
                  onClick={() => onSort(c.key)}
                >
                  {c.label} <SortIcon colKey={c.key} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {paged.length === 0 ? (
              <tr>
                <td colSpan={9} style={{ textAlign: 'center', color: 'var(--text-dim)', padding: '32px' }}>
                  No agents found
                </td>
              </tr>
            ) : paged.map((agent, i) => {
              const completionRate = agent.claimed > 0
                ? Math.round((agent.completed / agent.claimed) * 100)
                : 0;
              const statusCls = agent.status === 'active' ? 'pill-active'
                : agent.status === 'away' ? 'pill-away' : 'pill-offline';
              const statusLabel = agent.status === 'active' ? 'Active'
                : agent.status === 'away' ? 'Away' : 'Offline';

              return (
                <tr key={agent.name + i}>
                  <td>
                    <div className="agent-cell">
                      <div className="agent-avatar" style={{ background: agent.color }}>
                        {agent.initials}
                      </div>
                      <div>
                        <div className="agent-name">{agent.name}</div>
                        <div className="agent-role">{agent.role || 'Activation Agent'}</div>
                      </div>
                    </div>
                  </td>
                  <td className="num-cell">{agent.total.toLocaleString()}</td>
                  <td className="num-cell">{agent.claimed.toLocaleString()}</td>
                  <td className="num-cell">{agent.completed.toLocaleString()}</td>
                  <td>
                    <div className="mini-bar-wrap">
                      <div className="mini-bar-track">
                        <div
                          className="mini-bar-fill"
                          style={{ width: `${completionRate}%`, background: barColor(completionRate) }}
                        />
                      </div>
                      <span className="mini-bar-pct">{completionRate}%</span>
                    </div>
                  </td>
                  <td className="num-cell" style={{ 
                    color: agent.claimTimeSec > slaSeconds ? '#E74C3C' : 'inherit',
                    fontWeight: agent.claimTimeSec > slaSeconds ? 600 : 'inherit'
                  }}>
                    {fmtTime(agent.claimTimeSec)}
                    {agent.claimTimeSec > slaSeconds && (
                      <span style={{ fontSize: '10px', marginLeft: '4px', opacity: 0.8 }}>(SLA)</span>
                    )}
                  </td>
                  <td className="num-cell">{fmtTime(agent.handleTimeSec)}</td>
                  <td>
                    <span className={`status-pill ${statusCls}`}>{statusLabel}</span>
                  </td>
                  <td>
                    {agent.trend === 'up'   && <span className="trend-up">▲ Up</span>}
                    {agent.trend === 'down' && <span className="trend-down">▼ Down</span>}
                    {(!agent.trend || agent.trend === 'neutral') && <span className="trend-neu">— Neutral</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="table-footer">
          <span>
            Showing {total === 0 ? 0 : (safePage - 1) * ROWS_PER_PAGE + 1}–{Math.min(safePage * ROWS_PER_PAGE, total)} of {total} agents
          </span>
          <div className="pagination">
            <button
              className="pg-btn"
              onClick={() => onPage(safePage - 1)}
              disabled={safePage <= 1}
              aria-label="Previous page"
            >
              ‹
            </button>
            {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
              <button
                key={p}
                className={`pg-btn${p === safePage ? ' active' : ''}`}
                onClick={() => onPage(p)}
                aria-label={`Page ${p}`}
                aria-current={p === safePage ? 'page' : undefined}
              >
                {p}
              </button>
            ))}
            <button
              className="pg-btn"
              onClick={() => onPage(safePage + 1)}
              disabled={safePage >= totalPages}
              aria-label="Next page"
            >
              ›
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ─── MAIN PAGE ─────────────────────────────────────────────────────────────────
export default function ActivationPerformance() {
  const [loadState, setLoadState]     = useState('loading');
  const [importMeta, setImportMeta]   = useState(null);
  const [allOrders, setAllOrders]     = useState([]);
  const [currentRange, setCurrentRange] = useState('month');
  const [customDates, setCustomDates] = useState({ from: '', to: '' });
  const [searchQuery, setSearchQuery] = useState('');
  const [sortState, setSortState]     = useState({ col: 'total', dir: 'desc' });
  const [page, setPage]               = useState(1);
  const [slaSettings, setSlaSettings] = useState({ activation: { workingHours: DEFAULT_SLA_SECONDS / 60, nonWorkingHours: DEFAULT_SLA_SECONDS / 60 } });

  useEffect(() => {
    loadData();
    loadSLASettings();
  }, []);

  async function loadSLASettings() {
    try {
      const slaSnap = await getDocs(query(collection(db, 'slaSettings'), limit(1)));
      if (!slaSnap.empty) {
        const data = slaSnap.docs[0].data();
        setSlaSettings({
          activation: data.activation || { workingHours: 120, nonWorkingHours: 120 },
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

      // Load activation orders subcollection
      const ordersSnap = await getDocs(query(
        collection(db, 'imports', docSnap.id, 'activationOrders'), 
        orderBy('assignDT', 'desc'), 
        limit(5000)
      ));
      
      const orders = ordersSnap.docs.map(d => {
        const data = d.data();
        return {
          ...data,
          assignDT: data.assignDT?.toDate ? data.assignDT.toDate() : null,
        };
      });

      setAllOrders(orders);
      
      // Load agent mappings for dashboard display/hide settings
      const mappingsSnap = await getDocs(query(collection(db, 'agentMappings'), orderBy('agentCode', 'asc')));
      setAgentMappings(mappingsSnap.docs.map(d => ({ id: d.id, ...d.data() })));
      
      setLoadState('loaded');
      localStorage.setItem('tpw_data_source', 'live');
    } catch (err) {
      console.error('Load error:', err);
      setLoadState('demo');
      localStorage.setItem('tpw_data_source', 'demo');
    }
  }

  const agentData = useMemo(() => {
    if (loadState === 'loading') return [];

    if (loadState === 'demo' || loadState === 'error') {
      const mult = currentRange === 'custom'
        ? Math.max(1, customDates.from && customDates.to
            ? (Math.round((new Date(customDates.to) - new Date(customDates.from)) / 86400000) + 1) / 30
            : 1)
        : (DEMO_MULTIPLIERS[currentRange] ?? 1);

      return DEMO_AGENTS.map(a => ({
        ...a,
        total:         Math.max(0, Math.round(a.total * mult)),
        claimed:       Math.max(0, Math.round(a.claimed * mult)),
        completed:     Math.max(0, Math.round(a.completed * mult)),
        claimTimeSec:  Math.round(a.claimTimeSec  * (0.88 + Math.random() * 0.24)),
        handleTimeSec: Math.round(a.handleTimeSec * (0.88 + Math.random() * 0.24)),
      }));
    }

    // Live data: aggregate from allOrders
    const bounds = getRangeBounds(currentRange, customDates);
    const filteredOrders = bounds
      ? allOrders.filter(o => o.assignDT && o.assignDT >= bounds.from && o.assignDT <= bounds.to)
      : allOrders;

    const agentMap = {};
    filteredOrders.forEach((o) => {
      const name = o.agentName || '';
      if (!name) return;
      if (!agentMap[name]) agentMap[name] = { name, orders: [] };
      agentMap[name].orders.push(o);
    });

    const mappingMap = agentMappings.reduce((acc, m) => {
      if (m && m.agentCode) acc[m.agentCode] = m;
      return acc;
    }, {});

    return Object.values(agentMap).map((a, idx) => {
      const initials = a.name.split(/\s+/).map(p => p[0]).join('').slice(0, 2).toUpperCase();
      const color    = COLORS[idx % COLORS.length];
      const claimed  = a.orders.filter(o => o.claimed).length;
      const completed = a.orders.filter(o => o.completed).length;
      
      const claimTimes  = a.orders
        .map(o => o.claimTimeSec)
        .filter(v => v != null && v >= 0 && v < 86400);
      const handleTimes = a.orders
        .map(o => o.handleTimeSec)
        .filter(v => v != null && v >= 0 && v < 86400);

      const mapping = mappingMap[a.name];
      const visible = mapping ? mapping.visible !== false : true;

      return {
        name: a.name,
        role: mapping?.displayName || 'Activation Agent',
        initials,
        color,
        total:         a.orders.length,
        claimed,
        completed,
        claimTimeSec:  Math.round(avg(claimTimes)),
        handleTimeSec: Math.round(avg(handleTimes)),
        status:        'active',
        trend:         'neutral',
        visible,
      };
    }).filter(a => a.total > 0 && a.visible).sort((a, b) => b.total - a.total);
  }, [loadState, allOrders, currentRange, customDates]);

  function handleSort(col) {
    setSortState(prev => ({
      col,
      dir: prev.col === col && prev.dir === 'desc' ? 'asc' : 'desc',
    }));
    setPage(1);
  }

  function handleRangeChange(range) {
    setCurrentRange(range);
    setPage(1);
  }

  const label = currentRange === 'custom'
    ? (customDates.from && customDates.to ? `${customDates.from} → ${customDates.to}` : 'Custom Range')
    : (FILTER_LABELS[currentRange] || 'All Time');

  return (
    <>
      <Navbar activeLink="activation" />
      <div className="page">
        {loadState === 'loading' ? (
          <LoadingState />
        ) : (
          <>
            <div className="page-header">
              <div>
                <h1>Activation Agents Performance</h1>
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
                      setPage(1);
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
                      setPage(1);
                    }}
                    aria-label="Custom date to"
                  />
                </div>
              </div>
            </div>

            <HeroBadge
              data={agentData}
              currentRange={currentRange}
              customDates={customDates}
              importMeta={importMeta}
              loadState={loadState}
              slaMinutes={slaSettings?.activation?.workingHours}
            />

            <AgentTable
              data={agentData}
              searchQuery={searchQuery}
              onSearch={setSearchQuery}
              sortState={sortState}
              onSort={handleSort}
              page={page}
              onPage={setPage}
              slaMinutes={slaSettings?.activation?.workingHours}
            />
          </>
        )}
      </div>
    </>
  );
}
