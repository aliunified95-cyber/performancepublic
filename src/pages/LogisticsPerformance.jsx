import React, { useState, useEffect, useMemo } from 'react';
import {
  collection,
  query,
  orderBy,
  limit,
  getDocs,
  where,
} from 'firebase/firestore';
import { db } from '../firebase';
import Navbar from '../components/Navbar';
import AgentDetailModal from '../components/AgentDetailModal';

// ─── COLORS ────────────────────────────────────────────────────────────────────
const COLORS = [
  '#7B3FA0','#2ECC8A','#3A7BD5','#E67E22','#E74C3C',
  '#1ABC9C','#9B59B6','#F39C12','#16A085','#8E44AD',
  '#C0392B','#2980B9','#27AE60','#D35400','#E91E8C',
];

// No demo data - only real imported data is displayed

const FILTER_LABELS = {
  today:'Today', yesterday:'Yesterday', week:'This Week',
  lastmonth:'Last Month', month:'This Month', mtd:'Month to Date', quarter:'This Quarter', annual:'This Year',
};

const ROWS_PER_PAGE = 1000;

// Default SLA: 2 hours = 7200 seconds
const DEFAULT_SLA_SECONDS = 7200;

// ─── HELPERS ───────────────────────────────────────────────────────────────────
function fmtTime(sec) {
  if (!sec || isNaN(sec)) return '0h 00m';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
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
  if (range === 'lastmonth') return { from: new Date(y, mo - 1, 1, 0, 0, 0),  to: new Date(y, mo, 0, 23, 59, 59) };
  if (range === 'custom' && customDates.from && customDates.to) {
    return {
      from: new Date(customDates.from + 'T00:00:00'),
      to:   new Date(customDates.to   + 'T23:59:59'),
    };
  }
  return null;
}

function getPrevRangeBounds(range) {
  const now = new Date();
  const y   = now.getFullYear();
  const mo  = now.getMonth();
  const d   = now.getDate();

  if (range === 'today')     return { from: new Date(y, mo, d - 1, 0, 0, 0),     to: new Date(y, mo, d - 1, 23, 59, 59) };
  if (range === 'yesterday') return { from: new Date(y, mo, d - 2, 0, 0, 0),     to: new Date(y, mo, d - 2, 23, 59, 59) };
  if (range === 'week') {
    const weekStart = new Date(y, mo, d - now.getDay());
    const prevEnd   = new Date(weekStart.getTime() - 1000);
    const prevStart = new Date(weekStart.getTime() - 7 * 86400000);
    return { from: prevStart, to: prevEnd };
  }
  if (range === 'month' || range === 'mtd') return { from: new Date(y, mo - 1, 1, 0, 0, 0), to: new Date(y, mo, 0, 23, 59, 59) };
  if (range === 'lastmonth')                return { from: new Date(y, mo - 2, 1, 0, 0, 0), to: new Date(y, mo - 1, 0, 23, 59, 59) };
  if (range === 'quarter') {
    const qStart = Math.floor(mo / 3) * 3;
    return { from: new Date(y, qStart - 3, 1, 0, 0, 0), to: new Date(y, qStart, 0, 23, 59, 59) };
  }
  if (range === 'annual') return { from: new Date(y - 1, 0, 1, 0, 0, 0), to: new Date(y - 1, 11, 31, 23, 59, 59) };
  return null;
}

function getPrevRangeLabel(range) {
  if (range === 'today')                    return 'yesterday';
  if (range === 'yesterday')                return 'day before';
  if (range === 'week')                     return 'last week';
  if (range === 'month' || range === 'mtd') return 'last month';
  if (range === 'lastmonth')                return 'month before';
  if (range === 'quarter')                  return 'last quarter';
  if (range === 'annual')                   return 'last year';
  return null;
}

// ─── SUB-COMPONENTS ────────────────────────────────────────────────────────────
function LoadingState() {
  return (
    <div className="loading-state">
      <div className="spinner-lg" aria-hidden="true" />
      <p>Loading logistics data…</p>
    </div>
  );
}

function HeroBadge({ data, currentRange, customDates, importMeta, loadState, slaMinutes }) {
  const totalOrders    = data.reduce((s, a) => s + a.total, 0);
  const totalClaimed   = data.reduce((s, a) => s + a.claimed, 0);
  const totalBadHandling = data.reduce((s, a) => s + (a.badHandlingCount || 0), 0);
  const avgClaim       = Math.round(avg(data.map(a => a.avgClaimTimeSec)));
  const avgActivation  = Math.round(avg(data.map(a => a.activationAssignTimeSec)));
  const avgAssignToAwb = Math.round(avg(data.map(a => a.avgAssignToAwbSec).filter(v => v > 0)));
  const claimRate      = totalOrders > 0 ? Math.round((totalClaimed / totalOrders) * 100) : 0;
  const slaSeconds = (slaMinutes || 120) * 60;
  const isSLAExceeded = avgClaim > slaSeconds;

  const label = currentRange === 'custom'
    ? `${customDates.from} → ${customDates.to}`
    : (FILTER_LABELS[currentRange] || 'All Time');

  const src = loadState === 'loaded'
    ? (importMeta?.filename || 'Imported Data')
    : 'Demo Data';

  const ch = Math.floor(avgClaim / 3600);
  const cm = Math.floor((avgClaim % 3600) / 60);
  const ah = Math.floor(avgActivation / 3600);
  const am = Math.floor((avgActivation % 3600) / 60);
  const wh = Math.floor(avgAssignToAwb / 3600);
  const wm = Math.floor((avgAssignToAwb % 3600) / 60);

  return (
    <div className="hero-badge">
      <div className="hero-badge-label">
        <span className="dot" aria-hidden="true" />
        Logistics Team Overview
      </div>
      <div className="hero-badge-title">
        All Agents · {label} · {src}
      </div>

      <div className="hero-kpis" style={{ gridTemplateColumns: 'repeat(7, 1fr)' }}>
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
            {claimRate}% rate
          </span>
        </div>

        {/* Avg Claim Time */}
        <div className="hero-kpi">
          <div className="hero-kpi-icon" style={{ background: isSLAExceeded ? 'rgba(231,76,60,0.15)' : 'rgba(216,245,236,0.08)' }}>
            <svg viewBox="0 0 24 24" style={{ stroke: isSLAExceeded ? '#E74C3C' : 'var(--mint)' }} aria-hidden="true">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="12 6 12 12 16 14"/>
            </svg>
          </div>
          <div className={`hero-kpi-value${isSLAExceeded ? ' sla-exceeded' : ''}`} style={{ color: isSLAExceeded ? '#E74C3C' : 'inherit' }}>
            {ch}<sup>h {String(cm).padStart(2, '0')}m</sup>
          </div>
          <div className="hero-kpi-label">Avg Claim Time</div>
          <span className={`hero-kpi-badge badge-neu${isSLAExceeded ? ' sla-exceeded' : ''}`} style={{ color: isSLAExceeded ? '#E74C3C' : 'inherit', background: isSLAExceeded ? 'rgba(231,76,60,0.12)' : '' }}>
            {isSLAExceeded ? 'SLA Exceeded' : 'assign→claim'}
          </span>
        </div>

        {/* Avg Time to Activation */}
        <div className="hero-kpi">
          <div className="hero-kpi-icon" style={{ background: 'rgba(255,193,7,0.12)' }}>
            <svg viewBox="0 0 24 24" style={{ stroke: '#ffc107' }} aria-hidden="true">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="12 6 12 12 8 14"/>
            </svg>
          </div>
          <div className="hero-kpi-value">
            {ah}<sup>h {String(am).padStart(2, '0')}m</sup>
          </div>
          <div className="hero-kpi-label">Avg to Activation</div>
          <span className="hero-kpi-badge badge-neu">claim→activation</span>
        </div>

        {/* Claim Rate */}
        <div className="hero-kpi">
          <div className="hero-kpi-icon" style={{ background: 'rgba(46,204,138,0.1)' }}>
            <svg viewBox="0 0 24 24" style={{ stroke: 'var(--emerald)' }} aria-hidden="true">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
              <polyline points="22 4 12 14.01 9 11.01"/>
            </svg>
          </div>
          <div className="hero-kpi-value">{claimRate}<sup>%</sup></div>
          <div className="hero-kpi-label">Claim Rate</div>
          <span className="hero-kpi-badge badge-neu">of assigned</span>
        </div>

        {/* Bad Handling Count */}
        <div className="hero-kpi">
          <div className="hero-kpi-icon" style={{ background: 'rgba(231,76,60,0.18)' }}>
            <svg viewBox="0 0 24 24" style={{ stroke: '#E74C3C' }} aria-hidden="true">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
          </div>
          <div className={`hero-kpi-value${totalBadHandling > 0 ? ' sla-exceeded' : ''}`} style={{ color: totalBadHandling > 0 ? '#E74C3C' : 'inherit' }}>
            {totalBadHandling.toLocaleString()}
          </div>
          <div className="hero-kpi-label">Bad Handling</div>
          <span className="hero-kpi-badge badge-neu">&gt; 1000 min</span>
        </div>

        {/* Avg Assign → AWB Creation */}
        <div className="hero-kpi">
          <div className="hero-kpi-icon" style={{ background: 'rgba(0,188,212,0.15)' }}>
            <svg viewBox="0 0 24 24" style={{ stroke: '#00BCD4' }} fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="1" y="3" width="15" height="13" rx="1"/>
              <path d="M16 8h4l3 3v5h-7V8z"/>
              <circle cx="5.5" cy="18.5" r="2.5"/>
              <circle cx="18.5" cy="18.5" r="2.5"/>
            </svg>
          </div>
          <div className="hero-kpi-value" style={{ color: avgAssignToAwb > 0 ? '#00BCD4' : 'inherit' }}>
            {avgAssignToAwb > 0 ? <>{wh}<sup>h {String(wm).padStart(2, '0')}m</sup></> : '—'}
          </div>
          <div className="hero-kpi-label">Avg Assign → AWB</div>
          <span className="hero-kpi-badge" style={{ background: 'rgba(0,188,212,0.12)', color: '#00BCD4' }}>assignment → AWB creation</span>
        </div>
      </div>
    </div>
  );
}

function AgentTable({ data, searchQuery, onSearch, sortState, onSort, page, onPage, slaMinutes, onAgentClick, compLabel }) {
  const slaSeconds = (slaMinutes || 120) * 60;
  const query2 = searchQuery.toLowerCase();
  let filtered = data.filter(a =>
    a.name.toLowerCase().includes(query2) || (a.role || '').toLowerCase().includes(query2)
  );

  filtered = [...filtered].sort((a, b) => {
    const { col, dir } = sortState;
    if (col === 'name')       return dir === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
    if (col === 'status')     return dir === 'asc' ? (a.status||'').localeCompare(b.status||'') : (b.status||'').localeCompare(a.status||'');
    if (col === 'trend')      return dir === 'asc' ? (a.trendPct||0) - (b.trendPct||0) : (b.trendPct||0) - (a.trendPct||0);
    let av, bv;
    if (col === 'total')              { av = a.total;              bv = b.total; }
    else if (col === 'claimed')       { av = a.claimed;            bv = b.claimed; }
    else if (col === 'claimRate')     { av = a.claimed / Math.max(1, a.total); bv = b.claimed / Math.max(1, b.total); }
    else if (col === 'claimTime')     { av = a.avgClaimTimeSec;    bv = b.avgClaimTimeSec; }
    else if (col === 'activationTime'){ av = a.activationAssignTimeSec; bv = b.activationAssignTimeSec; }
    else if (col === 'assignToAwb')   { av = a.avgAssignToAwbSec || 0; bv = b.avgAssignToAwbSec || 0; }
    else if (col === 'badHandling')   { av = a.badHandlingCount || 0; bv = b.badHandlingCount || 0; }
    else { av = a.total; bv = b.total; }
    return dir === 'asc' ? av - bv : bv - av;
  });

  const total     = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / ROWS_PER_PAGE));
  const safePage   = Math.min(page, totalPages);
  const paged      = filtered.slice((safePage - 1) * ROWS_PER_PAGE, safePage * ROWS_PER_PAGE);

  const cols = [
    { key: 'name',           label: 'Agent' },
    { key: 'total',          label: 'Total Assigned' },
    { key: 'claimed',        label: 'Claimed' },
    { key: 'claimRate',      label: 'Claim Rate' },
    { key: 'claimTime',      label: 'Avg Claim Time' },
    { key: 'activationTime', label: 'Avg to Activation' },
    { key: 'assignToAwb',    label: 'Avg Assign → AWB' },
    { key: 'badHandling',    label: 'Bad Handling' },
    { key: 'status',         label: 'Status' },
    { key: 'trend',          label: 'Trend' },
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
          <div className="section-sub">Individual logistics performance per agent</div>
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
                <td colSpan={10} style={{ textAlign: 'center', color: 'var(--text-dim)', padding: '32px' }}>
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
                    <div 
                      className="agent-cell" 
                      onClick={() => onAgentClick(agent)}
                      style={{ cursor: 'pointer' }}
                      title="Click to view detailed breakdown"
                    >
                      <div className="agent-avatar" style={{ background: agent.color }}>
                        {agent.initials}
                      </div>
                      <div>
                        <div className="agent-name" style={{ color: '#3A7BD5' }}>{agent.name}</div>
                        <div className="agent-role">{agent.role || 'Logistics Agent'}</div>
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
                  <td className={`num-cell${agent.avgClaimTimeSec > slaSeconds ? ' sla-exceeded' : ''}`} style={{
                    color: agent.avgClaimTimeSec > slaSeconds ? '#E74C3C' : 'inherit',
                    fontWeight: agent.avgClaimTimeSec > slaSeconds ? 600 : 'inherit'
                  }}>
                    {fmtTime(agent.avgClaimTimeSec)}
                    {agent.avgClaimTimeSec > slaSeconds && (
                      <span style={{ fontSize: '10px', marginLeft: '4px', opacity: 0.8 }}>(SLA)</span>
                    )}
                  </td>
                  <td className="num-cell">{fmtTime(agent.activationAssignTimeSec)}</td>
                  <td className="num-cell" style={{ color: agent.avgAssignToAwbSec > 0 ? '#00BCD4' : 'var(--text-dim)' }}>
                    {agent.avgAssignToAwbSec > 0 ? fmtTime(agent.avgAssignToAwbSec) : '—'}
                  </td>
                  <td className="num-cell">
                    {(agent.badHandlingCount || 0) > 0 ? (
                      <span className="sla-exceeded" style={{ color: '#E74C3C', fontWeight: 600 }}>
                        {agent.badHandlingCount}
                      </span>
                    ) : (
                      <span style={{ color: 'var(--text-dim)' }}>0</span>
                    )}
                  </td>
                  <td>
                    <span className={`status-pill ${statusCls}`}>{statusLabel}</span>
                  </td>
                  <td>
                    {agent.trend === 'improving' && (
                      <div>
                        <span className="trend-up">
                          ▲ Improving {agent.trendPct !== 0 && <span style={{ fontSize: '10px', opacity: 0.8 }}>{Math.abs(agent.trendPct)}%</span>}
                        </span>
                        {compLabel && <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginTop: '2px' }}>vs {compLabel}</div>}
                      </div>
                    )}
                    {agent.trend === 'declining' && (
                      <div>
                        <span className="trend-down">
                          ▼ Declining {agent.trendPct !== 0 && <span style={{ fontSize: '10px', opacity: 0.8 }}>{Math.abs(agent.trendPct)}%</span>}
                        </span>
                        {compLabel && <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginTop: '2px' }}>vs {compLabel}</div>}
                      </div>
                    )}
                    {(!agent.trend || agent.trend === 'neutral') && (
                      <div>
                        <span className="trend-neu">— Neutral</span>
                        {compLabel && <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginTop: '2px' }}>vs {compLabel}</div>}
                      </div>
                    )}
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
export default function LogisticsPerformance() {
  const [loadState, setLoadState]     = useState('loading');
  const [importMeta, setImportMeta]   = useState(null);
  const [allOrders, setAllOrders]     = useState([]);
  const [awbMap, setAwbMap]           = useState({});
  const [agentMappings, setAgentMappings] = useState([]);
  const [currentRange, setCurrentRange] = useState(() => localStorage.getItem('tpw_filter_range') || 'month');
  const [customDates, setCustomDates] = useState(() => ({
    from: localStorage.getItem('tpw_filter_from') || '',
    to:   localStorage.getItem('tpw_filter_to')   || '',
  }));
  const [searchQuery, setSearchQuery] = useState('');
  const [sortState, setSortState]     = useState({ col: 'total', dir: 'desc' });
  const [page, setPage]               = useState(1);
  const [slaSettings, setSlaSettings] = useState({ logistics: { workingHours: DEFAULT_SLA_SECONDS / 60, nonWorkingHours: DEFAULT_SLA_SECONDS / 60 } });
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

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
          logistics: data.logistics || { workingHours: 120, nonWorkingHours: 120 },
        });
      }
    } catch (err) {
      console.error('Error loading SLA:', err);
    }
  }

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

      const docSnap   = snap.docs[0];
      const meta      = { id: docSnap.id, ...docSnap.data() };
      setImportMeta(meta);

      // Load from global logisticsOrders collection (deduplicated across all imports)
      // Limited to recent 30000 for performance with large datasets
      const ordersSnap = await getDocs(query(
        collection(db, 'logisticsOrders'), 
        orderBy('assignDT', 'desc'), 
        limit(10000)
      ));
      
      const orders = ordersSnap.docs.map(d => {
        const data = d.data();
        return {
          ...data,
          assignDT: data.assignDT?.toDate ? data.assignDT.toDate() : null,
          effectiveAssignDT: data.effectiveAssignDT?.toDate ? data.effectiveAssignDT.toDate() : null,
          claimDT: data.claimDT?.toDate ? data.claimDT.toDate() : null,
          activationAssignDT: data.activationAssignDT?.toDate ? data.activationAssignDT.toDate() : null,
        };
      });

      setAllOrders(orders);

      // Load delivery shipments to compute assign→AWB time (join by awb === orderNo)
      const deliverySnap = await getDocs(query(collection(db, 'deliveryShipments'), orderBy('shipmentDate', 'desc'), limit(10000)));
      const map = {};
      deliverySnap.docs.forEach(d => {
        const data = d.data();
        if (data.awb && data.awbToLogisticsSec != null) {
          map[data.awb] = data.awbToLogisticsSec;
        }
      });
      setAwbMap(map);

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
      // No demo data - return empty array when no real data available
      return [];
    }

    // Live data: aggregate from allOrders
    // Use effectiveAssignDT for filtering (accounts for working hours adjustment)
    const bounds = getRangeBounds(currentRange, customDates);
    const filteredOrders = bounds
      ? allOrders.filter(o => {
          const filterDT = o.effectiveAssignDT || o.assignDT;
          return filterDT && filterDT >= bounds.from && filterDT <= bounds.to;
        })
      : allOrders;

    // Previous period for trend comparison
    const prevBounds = getPrevRangeBounds(currentRange);
    const prevOrdersByAgent = {};
    if (prevBounds) {
      allOrders
        .filter(o => {
          const filterDT = o.effectiveAssignDT || o.assignDT;
          return filterDT && filterDT >= prevBounds.from && filterDT <= prevBounds.to;
        })
        .forEach(o => {
          const name = o.agentName || '';
          if (!name) return;
          if (!prevOrdersByAgent[name]) prevOrdersByAgent[name] = [];
          prevOrdersByAgent[name].push(o);
        });
    }

    const agentMap = {};
    filteredOrders.forEach((o) => {
      const name = o.agentName || '';
      if (!name) return;
      if (!agentMap[name]) agentMap[name] = { name, orders: [] };
      agentMap[name].orders.push(o);
    });

    const mappingMap = agentMappings.reduce((acc, m) => {
      if (m && m.agentCode) acc[m.agentCode.toUpperCase()] = m;
      return acc;
    }, {});

    // Filter by agent type: only show logistics agents in this dashboard
    const logisticsAgents = Object.values(agentMap).filter(a => {
      const mapping = mappingMap[(a.name || '').toUpperCase()];
      // If no mapping exists, default to showing (legacy behavior)
      // If mapping exists, only show if agentType is 'logistics'
      return !mapping || mapping.agentType === 'logistics' || !mapping.agentType;
    });

    return logisticsAgents.map((a, idx) => {
      const initials = a.name.split(/\s+/).map(p => p[0]).join('').slice(0, 2).toUpperCase();
      const color    = COLORS[idx % COLORS.length];
      const claimed  = a.orders.filter(o => o.claimed).length;
      
      // Calculate bad handling: orders with claim time > 1000 minutes (60000 seconds)
      const badHandlingCount = a.orders.filter(o => o.claimTimeSec != null && o.claimTimeSec > 60000).length;
      
      // Filter out bad handling times from average calculation
      const claimTimes = a.orders
        .map(o => o.claimTimeSec)
        .filter(v => v != null && v >= 0 && v < 86400 && v <= 60000);

      const activationTimes = a.orders
        .map(o => o.activationAssignTimeSec)
        .filter(v => v != null && v >= 0 && v <= 60000); // Exclude bad handling (>60000s)

      const assignToAwbTimes = a.orders
        .map(o => awbMap[o.orderNo])
        .filter(v => v != null && v >= 0);

      const mapping = mappingMap[(a.name || '').toUpperCase()];
      const visible = mapping ? mapping.visible !== false : true;

      const currentAvgClaim = Math.round(avg(claimTimes));

      // Compute previous period avg claim time for trend
      let trend = 'neutral';
      let trendPct = 0;
      if (prevBounds) {
        const prevOrders = prevOrdersByAgent[a.name] || [];
        const prevClaimTimes = prevOrders
          .map(o => o.claimTimeSec)
          .filter(v => v != null && v >= 0 && v < 86400 && v <= 60000);
        const prevAvgClaim = Math.round(avg(prevClaimTimes));
        if (prevAvgClaim > 0 && currentAvgClaim > 0) {
          const pct = ((currentAvgClaim - prevAvgClaim) / prevAvgClaim) * 100;
          trendPct = Math.round(pct);
          if (pct < -3)     trend = 'improving';
          else if (pct > 3) trend = 'declining';
        }
      }

      return {
        name: a.name,
        role: mapping?.displayName || 'Logistics Agent',
        initials,
        color,
        total:         a.orders.length,
        claimed,
        avgClaimTimeSec: currentAvgClaim,
        activationAssignTimeSec: Math.round(avg(activationTimes)),
        avgAssignToAwbSec: Math.round(avg(assignToAwbTimes)),
        badHandlingCount,
        status:        'active',
        trend,
        trendPct,
        visible,
        orders:        a.orders, // Pass orders for modal
      };
    }).filter(a => a.total > 0 && a.visible).sort((a, b) => b.total - a.total);
  }, [loadState, allOrders, awbMap, agentMappings, currentRange, customDates]);

  function handleAgentClick(agent) {
    setSelectedAgent(agent);
    setIsModalOpen(true);
  }

  function handleCloseModal() {
    setIsModalOpen(false);
    setSelectedAgent(null);
  }

  function handleSort(col) {
    setSortState(prev => ({
      col,
      dir: prev.col === col && prev.dir === 'desc' ? 'asc' : 'desc',
    }));
    setPage(1);
  }

  function handleRangeChange(range) {
    setCurrentRange(range);
    localStorage.setItem('tpw_filter_range', range);
    setPage(1);
  }

  const label = currentRange === 'custom'
    ? (customDates.from && customDates.to ? `${customDates.from} → ${customDates.to}` : 'Custom Range')
    : (FILTER_LABELS[currentRange] || 'All Time');

  return (
    <>
      <Navbar activeLink="logistics" />
      <div className="page">
        {loadState === 'loading' ? (
          <LoadingState />
        ) : (
          <>
            <div className="page-header">
              <div>
                <h1>Logistics Agents Performance</h1>
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
                <span className="print-generated">
                  <strong>Logistics Performance</strong>
                  Generated: {new Date().toLocaleString('en-GB')}
                </span>
                <button className="pdf-btn" onClick={() => window.print()}>
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                  Save as PDF
                </button>
                {/* Filter bar */}
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
                        localStorage.setItem('tpw_filter_range', 'custom');
                        localStorage.setItem('tpw_filter_to', e.target.value);
                        setPage(1);
                      }}
                      aria-label="Custom date to"
                    />
                  </div>
                </div>
              </div>
            </div>

            <HeroBadge
              data={agentData}
              currentRange={currentRange}
              customDates={customDates}
              importMeta={importMeta}
              loadState={loadState}
              slaMinutes={slaSettings?.logistics?.workingHours}
            />

            <AgentTable
              data={agentData}
              searchQuery={searchQuery}
              onSearch={setSearchQuery}
              sortState={sortState}
              onSort={handleSort}
              page={page}
              onPage={setPage}
              slaMinutes={slaSettings?.logistics?.workingHours}
              onAgentClick={handleAgentClick}
              compLabel={getPrevRangeLabel(currentRange)}
            />

            <AgentDetailModal
              isOpen={isModalOpen}
              onClose={handleCloseModal}
              agent={selectedAgent}
              teamType="logistics"
            />

            <div className="print-footer">
              <span>Team Performance System</span>
              <span>{label}</span>
              <span className="print-footer-sig">Automated report developed by Ali Isa Mohsen 36030791</span>
            </div>
          </>
        )}
      </div>
    </>
  );
}
