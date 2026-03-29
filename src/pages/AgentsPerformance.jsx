import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
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
  { name:'Sarah Mitchell',  role:'Senior Agent', initials:'SM', color:COLORS[0],  total:178, claimed:162, claimTimeSec:198,  assignTimeSec:52,  status:'active',  trend:'up' },
  { name:'James Okafor',    role:'Sales Agent',  initials:'JO', color:COLORS[1],  total:154, claimed:138, claimTimeSec:245,  assignTimeSec:67,  status:'active',  trend:'up' },
  { name:'Priya Sharma',    role:'Sales Agent',  initials:'PS', color:COLORS[2],  total:143, claimed:121, claimTimeSec:302,  assignTimeSec:74,  status:'away',    trend:'down' },
  { name:'Carlos Reyes',    role:'Senior Agent', initials:'CR', color:COLORS[3],  total:137, claimed:130, claimTimeSec:180,  assignTimeSec:48,  status:'active',  trend:'up' },
  { name:'Yuki Tanaka',     role:'Sales Agent',  initials:'YT', color:COLORS[4],  total:129, claimed:107, claimTimeSec:355,  assignTimeSec:91,  status:'active',  trend:'neutral' },
  { name:'Amara Diallo',    role:'Sales Agent',  initials:'AD', color:COLORS[5],  total:124, claimed:110, claimTimeSec:270,  assignTimeSec:60,  status:'offline', trend:'down' },
  { name:'Liam Brennan',    role:'Junior Agent', initials:'LB', color:COLORS[6],  total:108, claimed:88,  claimTimeSec:420,  assignTimeSec:110, status:'active',  trend:'up' },
  { name:'Fatima Al-Zahra', role:'Sales Agent',  initials:'FA', color:COLORS[7],  total:101, claimed:91,  claimTimeSec:315,  assignTimeSec:80,  status:'away',    trend:'neutral' },
  { name:'Noah Williams',   role:'Junior Agent', initials:'NW', color:COLORS[8],  total:96,  claimed:74,  claimTimeSec:480,  assignTimeSec:120, status:'offline', trend:'down' },
  { name:'Elena Kovacs',    role:'Sales Agent',  initials:'EK', color:COLORS[9],  total:114, claimed:98,  claimTimeSec:260,  assignTimeSec:58,  status:'active',  trend:'up' },
];

const DEMO_MULTIPLIERS = {
  today: 0.035, yesterday: 0.033, week: 0.22,
  month: 1, mtd: 0.70, quarter: 3.1, annual: 12.5,
};

const FILTER_LABELS = {
  today:'Today', yesterday:'Yesterday', week:'This Week',
  month:'This Month', mtd:'Month to Date', quarter:'This Quarter', annual:'This Year',
};

const ROWS_PER_PAGE = 10;

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
      <p>Loading performance data…</p>
    </div>
  );
}

function HeroBadge({ data, currentRange, customDates, importMeta, loadState }) {
  const totalOrders  = data.reduce((s, a) => s + a.total, 0);
  const totalClaimed = data.reduce((s, a) => s + a.claimed, 0);
  const avgClaim     = Math.round(avg(data.map(a => a.claimTimeSec)));
  const avgAssign    = Math.round(avg(data.map(a => a.assignTimeSec)));

  const label = currentRange === 'custom'
    ? `${customDates.from} → ${customDates.to}`
    : (FILTER_LABELS[currentRange] || 'All Time');

  const src = loadState === 'loaded'
    ? (importMeta?.filename || 'Imported Data')
    : 'Demo Data';

  const cm = Math.floor(avgClaim / 60);
  const cs = avgClaim % 60;
  const am = Math.floor(avgAssign / 60);
  const as2 = avgAssign % 60;

  return (
    <div className="hero-badge">
      <div className="hero-badge-label">
        <span className="dot" aria-hidden="true" />
        Team Overview
      </div>
      <div className="hero-badge-title">
        All Agents · {label} · {src}
      </div>

      <div className="hero-kpis">
        {/* Total Orders */}
        <div className="hero-kpi">
          <div className="hero-kpi-icon" style={{ background: 'rgba(46,204,138,0.18)' }}>
            <svg viewBox="0 0 24 24" style={{ stroke: 'var(--emerald)' }} aria-hidden="true">
              <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/>
              <line x1="3" y1="6" x2="21" y2="6"/>
              <path d="M16 10a4 4 0 0 1-8 0"/>
            </svg>
          </div>
          <div className="hero-kpi-value">{totalOrders.toLocaleString()}</div>
          <div className="hero-kpi-label">Total Orders</div>
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

        {/* Avg Claim Time */}
        <div className="hero-kpi">
          <div className="hero-kpi-icon" style={{ background: 'rgba(216,245,236,0.08)' }}>
            <svg viewBox="0 0 24 24" style={{ stroke: 'var(--mint)' }} aria-hidden="true">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="12 6 12 12 16 14"/>
            </svg>
          </div>
          <div className="hero-kpi-value">
            {cm}<sup>m {String(cs).padStart(2, '0')}s</sup>
          </div>
          <div className="hero-kpi-label">Avg Claim Time</div>
          <span className="hero-kpi-badge badge-neu">team avg</span>
        </div>

        {/* Avg Assignment Time */}
        <div className="hero-kpi">
          <div className="hero-kpi-icon" style={{ background: 'rgba(46,204,138,0.1)' }}>
            <svg viewBox="0 0 24 24" style={{ stroke: 'var(--emerald)' }} aria-hidden="true">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
              <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
          </div>
          <div className="hero-kpi-value">
            {am}<sup>m {String(as2).padStart(2, '0')}s</sup>
          </div>
          <div className="hero-kpi-label">Avg Assignment Time</div>
          <span className="hero-kpi-badge badge-neu">team avg</span>
        </div>
      </div>
    </div>
  );
}

function AgentTable({ data, searchQuery, onSearch, sortState, onSort, page, onPage }) {
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
    if (col === 'total')      { av = a.total;        bv = b.total; }
    else if (col === 'claimed')    { av = a.claimed;      bv = b.claimed; }
    else if (col === 'claimRate')  { av = a.claimed / Math.max(1, a.total); bv = b.claimed / Math.max(1, b.total); }
    else if (col === 'claimTime')  { av = a.claimTimeSec;  bv = b.claimTimeSec; }
    else if (col === 'assignTime') { av = a.assignTimeSec; bv = b.assignTimeSec; }
    else { av = a.total; bv = b.total; }
    return dir === 'asc' ? av - bv : bv - av;
  });

  const total     = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / ROWS_PER_PAGE));
  const safePage   = Math.min(page, totalPages);
  const paged      = filtered.slice((safePage - 1) * ROWS_PER_PAGE, safePage * ROWS_PER_PAGE);

  const cols = [
    { key: 'name',       label: 'Agent' },
    { key: 'total',      label: 'Total Orders' },
    { key: 'claimed',    label: 'Claimed' },
    { key: 'claimRate',  label: 'Claim Rate' },
    { key: 'claimTime',  label: 'Avg Claim Time' },
    { key: 'assignTime', label: 'Avg Assign Time' },
    { key: 'status',     label: 'Status' },
    { key: 'trend',      label: 'Trend' },
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
          <div className="section-sub">Individual performance per agent</div>
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
                <td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-dim)', padding: '32px' }}>
                  No agents found
                </td>
              </tr>
            ) : paged.map((agent, i) => {
              const claimRate = agent.total > 0
                ? Math.round((agent.claimed / agent.total) * 100)
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
                        <div className="agent-role">{agent.role || 'Sales Agent'}</div>
                      </div>
                    </div>
                  </td>
                  <td className="num-cell">{agent.total.toLocaleString()}</td>
                  <td className="num-cell">{agent.claimed.toLocaleString()}</td>
                  <td>
                    <div className="mini-bar-wrap">
                      <div className="mini-bar-track">
                        <div
                          className="mini-bar-fill"
                          style={{ width: `${claimRate}%`, background: barColor(claimRate) }}
                        />
                      </div>
                      <span className="mini-bar-pct">{claimRate}%</span>
                    </div>
                  </td>
                  <td className="num-cell">{fmtTime(agent.claimTimeSec)}</td>
                  <td className="num-cell">{fmtTime(agent.assignTimeSec)}</td>
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
export default function AgentsPerformance() {
  const [loadState, setLoadState]     = useState('loading');
  const [importMeta, setImportMeta]   = useState(null);
  const [allOrders, setAllOrders]     = useState([]);
  const [currentRange, setCurrentRange] = useState('month');
  const [customDates, setCustomDates] = useState({ from: '', to: '' });
  const [searchQuery, setSearchQuery] = useState('');
  const [sortState, setSortState]     = useState({ col: 'total', dir: 'desc' });
  const [page, setPage]               = useState(1);

  useEffect(() => {
    loadData();
  }, []);

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

      // Load orders subcollection
      const ordersSnap = await getDocs(collection(db, 'imports', docSnap.id, 'orders'));
      const orders = ordersSnap.docs.map(d => {
        const data = d.data();
        return {
          ...data,
          orderDT: data.orderDT?.toDate ? data.orderDT.toDate() : null,
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
        claimTimeSec:  Math.round(a.claimTimeSec  * (0.88 + Math.random() * 0.24)),
        assignTimeSec: Math.round(a.assignTimeSec * (0.88 + Math.random() * 0.24)),
      }));
    }

    // Live data: aggregate from allOrders
    const bounds = getRangeBounds(currentRange, customDates);
    const filteredOrders = bounds
      ? allOrders.filter(o => o.orderDT && o.orderDT >= bounds.from && o.orderDT <= bounds.to)
      : allOrders;

    const agentMap = {};
    filteredOrders.forEach((o, idx) => {
      const name = o.agentName || '';
      if (!name) return;
      if (!agentMap[name]) agentMap[name] = { name, orders: [] };
      agentMap[name].orders.push(o);
    });

    return Object.values(agentMap).map((a, idx) => {
      const initials = a.name.split(/\s+/).map(p => p[0]).join('').slice(0, 2).toUpperCase();
      const color    = COLORS[idx % COLORS.length];
      const claimed  = a.orders.filter(o => o.claimed).length;
      const claimTimes  = a.orders.map(o => o.claimTimeSec).filter(v => v != null && v >= 0 && v < 86400);
      const assignTimes = a.orders.map(o => o.assignTimeSec).filter(v => v != null && v >= 0 && v < 86400);

      return {
        name,
        role:          'Sales Agent',
        initials,
        color,
        total:         a.orders.length,
        claimed,
        claimTimeSec:  Math.round(avg(claimTimes)),
        assignTimeSec: Math.round(avg(assignTimes)),
        status:        'active',
        trend:         'neutral',
      };
    }).filter(a => a.total > 0).sort((a, b) => b.total - a.total);
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
      <Navbar activeLink="performance" />
      <div className="page">
        {loadState === 'loading' ? (
          <LoadingState />
        ) : (
          <>
            <div className="page-header">
              <div>
                <h1>Sales Agents Performance</h1>
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
            />

            <AgentTable
              data={agentData}
              searchQuery={searchQuery}
              onSearch={setSearchQuery}
              sortState={sortState}
              onSort={handleSort}
              page={page}
              onPage={setPage}
            />
          </>
        )}
      </div>
    </>
  );
}
