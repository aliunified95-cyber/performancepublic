import React, { useState, useEffect, useMemo } from 'react';
import {
  collection,
  doc,
  onSnapshot,
  query,
  orderBy,
  setDoc,
} from 'firebase/firestore';
import { db } from '../firebase';
import Navbar from '../components/Navbar';

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const FULL_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const CURRENT_YEAR = String(new Date().getFullYear());
const CURRENT_MONTH_IDX = new Date().getMonth(); // 0-based

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function scoreBand(v) {
  if (v == null) return 'none';
  if (v > 100) return 'outstanding';
  if (v >= 75) return 'good';
  return 'poor';
}

const BAND_COLORS = {
  none:        { color: 'var(--text-dim)', bg: 'transparent' },
  outstanding: { color: '#FFD700', bg: 'rgba(255,215,0,0.25)' },
  good:        { color: '#2ECC8A', bg: 'rgba(46,204,138,0.18)' },
  poor:        { color: '#ff6b6b', bg: 'rgba(231,76,60,0.22)' },
};

function getColor(v) {
  return BAND_COLORS[scoreBand(v)] || BAND_COLORS.none;
}

function formatPct(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

// ─── YEAR PILL BUTTON ─────────────────────────────────────────────────────────
function YearPill({ year, active, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '8px 20px',
        borderRadius: 10,
        border: active ? '1.5px solid var(--amethyst)' : '1px solid var(--border)',
        background: active ? 'rgba(123,63,160,0.2)' : 'rgba(27,58,45,0.4)',
        color: active ? '#c084fc' : 'var(--text-dim)',
        fontSize: 14,
        fontWeight: active ? 700 : 500,
        cursor: 'pointer',
        transition: 'all 0.2s',
        letterSpacing: '0.02em',
      }}
    >
      {year}
    </button>
  );
}

// ─── HERO STAT CARD ───────────────────────────────────────────────────────────
function HeroCard({ title, value, sub, accent = '#2ECC8A', icon, change }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: 'linear-gradient(135deg, rgba(27,58,45,0.7) 0%, rgba(13,26,19,0.8) 100%)',
        border: `1px solid ${hovered ? accent + '44' : 'var(--border)'}`,
        borderRadius: 16,
        padding: '20px 22px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        position: 'relative',
        overflow: 'hidden',
        transition: 'all 0.25s ease',
        transform: hovered ? 'translateY(-3px)' : 'none',
        boxShadow: hovered ? `0 8px 32px ${accent}15` : 'none',
      }}
    >
      {/* Ambient glow */}
      <div style={{
        position: 'absolute', top: -20, right: -20, width: 80, height: 80,
        background: `radial-gradient(circle, ${accent}12 0%, transparent 70%)`,
        pointerEvents: 'none',
      }} />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{
          width: 36, height: 36, borderRadius: 10,
          background: `${accent}18`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 18,
        }}>
          {icon}
        </div>
        {change != null && (
          <span style={{
            fontSize: 12, fontWeight: 600,
            color: change >= 0 ? '#2ECC8A' : '#ff6b6b',
            background: change >= 0 ? 'rgba(46,204,138,0.12)' : 'rgba(231,76,60,0.12)',
            border: `1px solid ${change >= 0 ? 'rgba(46,204,138,0.25)' : 'rgba(231,76,60,0.25)'}`,
            borderRadius: 8, padding: '3px 10px',
          }}>
            {change >= 0 ? '▲' : '▼'} {Math.abs(change).toFixed(1)}%
          </span>
        )}
      </div>

      <div style={{ fontSize: 30, fontWeight: 800, color: accent, letterSpacing: '-0.5px', lineHeight: 1.1, marginTop: 4 }}>
        {value}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-mid)', fontWeight: 500 }}>{title}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: -2 }}>{sub}</div>}
    </div>
  );
}

// ─── MINI TREND SPARKLINE ─────────────────────────────────────────────────────
function MiniTrend({ values }) {
  // values: array of up to 3 numbers (oldest → newest), nulls allowed
  const pts = values.filter(v => v != null);
  if (pts.length < 2) {
    return <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>—</span>;
  }

  const W = 44, H = 24, PAD = 3;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const range = max - min || 1;

  const coords = pts.map((v, i) => ({
    x: PAD + (i / (pts.length - 1)) * (W - PAD * 2),
    y: PAD + (1 - (v - min) / range) * (H - PAD * 2),
  }));

  const polyline = coords.map(c => `${c.x},${c.y}`).join(' ');
  const last = pts[pts.length - 1];
  const first = pts[0];
  const diff = last - first;
  const trendColor = diff > 1 ? '#2ECC8A' : diff < -1 ? '#ff6b6b' : '#aaa';
  const arrow = diff > 1 ? '↑' : diff < -1 ? '↓' : '→';

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
      <svg width={W} height={H} style={{ overflow: 'visible' }}>
        <polyline
          points={polyline}
          fill="none"
          stroke={trendColor}
          strokeWidth={1.8}
          strokeLinejoin="round"
          strokeLinecap="round"
          opacity={0.8}
        />
        {coords.map((c, i) => (
          <circle key={i} cx={c.x} cy={c.y} r={i === coords.length - 1 ? 3 : 2}
            fill={i === coords.length - 1 ? trendColor : 'rgba(216,245,236,0.3)'}
            stroke={trendColor} strokeWidth={1} />
        ))}
      </svg>
      <span style={{ fontSize: 12, fontWeight: 700, color: trendColor, minWidth: 10 }}>{arrow}</span>
    </div>
  );
}

// ─── AGENT ROW BAR (mini progress bar) ────────────────────────────────────────
function MiniBar({ value, max = 120 }) {
  if (value == null) return null;
  const pct = Math.min((value / max) * 100, 100);
  const { color } = getColor(value);
  return (
    <div style={{ width: 50, height: 5, borderRadius: 3, background: 'rgba(216,245,236,0.08)', overflow: 'hidden', flexShrink: 0 }}>
      <div style={{ width: `${pct}%`, height: '100%', borderRadius: 3, background: color, transition: 'width 0.4s ease' }} />
    </div>
  );
}

// ─── SKELETON ─────────────────────────────────────────────────────────────────
function Skeleton() {
  const bar = { background: 'rgba(216,245,236,0.06)', borderRadius: 8, animation: 'sf-pulse 1.8s ease-in-out infinite' };
  return (
    <div style={{ padding: '24px 28px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 16, marginBottom: 32 }}>
        {[0,1,2,3].map(i => <div key={i} style={{ ...bar, height: 130, borderRadius: 16, animationDelay: `${i * 0.15}s` }} />)}
      </div>
      <div style={{ ...bar, height: 42, width: 320, marginBottom: 24 }} />
      {[0,1,2,3,4,5].map(i => <div key={i} style={{ ...bar, height: 52, marginBottom: 8, animationDelay: `${i * 0.08}s` }} />)}
    </div>
  );
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────
export default function SalesFigures() {
  const [agents, setAgents] = useState([]);
  const [monthKeys, setMonthKeys] = useState([]);
  const [figuresMap, setFiguresMap] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  // Filters
  const [selectedYear, setSelectedYear] = useState(CURRENT_YEAR);

  // Date range filter (combined month-year format: YYYY-MM)
  const [filterStartDate, setFilterStartDate] = useState(`${CURRENT_YEAR}-01`);
  const [filterEndDate, setFilterEndDate] = useState(`${CURRENT_YEAR}-${String(CURRENT_MONTH_IDX + 1).padStart(2, '0')}`);

  // Modal
  const [showModal, setShowModal] = useState(false);
  const [newMonthYear, setNewMonthYear] = useState('');
  const [newMonthMonth, setNewMonthMonth] = useState('');
  const [monthDraft, setMonthDraft] = useState({});
  const [draftErrors, setDraftErrors] = useState({});

  // Coaching Modal
  const [showCoachingModal, setShowCoachingModal] = useState(false);
  const [selectedAgentForModal, setSelectedAgentForModal] = useState(null);
  const [coachingNotes, setCoachingNotes] = useState({});
  const [coachingCheckboxes, setCoachingCheckboxes] = useState({});
  const [coachingNoteText, setCoachingNoteText] = useState('');
  const [coachingSaving, setCoachingSaving] = useState(false);

  // ── Firebase ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const unsub = onSnapshot(
      query(collection(db, 'agentMappings'), orderBy('agentCode', 'asc')),
      snap => { setAgents(snap.docs.map(d => ({ id: d.id, ...d.data(), visible: d.data().visible !== false }))); setLoading(false); },
      () => { setAgents([]); setLoading(false); },
    );
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, 'hrMonthlyFigures'),
      snap => {
        const keys = [], map = {};
        snap.forEach(d => { keys.push(d.id); map[d.id] = d.data().figures || {}; });
        keys.sort();
        setMonthKeys(keys);
        setFiguresMap(map);
      },
      () => { setMonthKeys([]); setFiguresMap({}); },
    );
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, 'agentCoachingNotes'),
      snap => {
        const notes = {};
        snap.forEach(d => { notes[d.id] = d.data(); });
        setCoachingNotes(notes);
      },
      () => { setCoachingNotes({}); },
    );
    return unsub;
  }, []);

  // ── Derived ─────────────────────────────────────────────────────────────────
  const salesAgents = useMemo(
    () => agents.filter(a => (a.agentType || 'sales') === 'sales'),
    [agents],
  );

  const availableYears = useMemo(() => {
    const yrs = new Set();
    monthKeys.forEach(mk => yrs.add(mk.split('-')[0]));
    return Array.from(yrs).sort().reverse();
  }, [monthKeys]);

  // Month keys that actually have data, filtered by date range
  const monthsWithData = useMemo(() => {
    return monthKeys.filter(mk => mk >= filterStartDate && mk <= filterEndDate);
  }, [monthKeys, filterStartDate, filterEndDate]);

  const visibleAgents = useMemo(() => {
    return salesAgents.filter(a => a.visible !== false);
  }, [salesAgents]);

  // Helper: agent average for the year
  function agentYearAvg(code) {
    const vals = [];
    monthsWithData.forEach(mk => {
      const v = formatPct(figuresMap[mk]?.[code]);
      if (v != null) vals.push(v);
    });
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }

  // Helper: latest month value
  function getLatestVal(code) {
    for (let i = monthsWithData.length - 1; i >= 0; i--) {
      const v = formatPct(figuresMap[monthsWithData[i]]?.[code]);
      if (v != null) return v;
    }
    return null;
  }

  // Team average by month
  const teamAvgByMonth = useMemo(() => {
    return monthsWithData.map(mk => {
      const vals = visibleAgents
        .map(a => formatPct(figuresMap[mk]?.[a.agentCode]))
        .filter(v => v != null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    });
  }, [monthsWithData, visibleAgents, figuresMap]);

  // ── HERO: last month data ───────────────────────────────────────────────────
  const heroData = useMemo(() => {
    // Find the last month that has data
    let lastMK = null, prevMK = null;
    for (let i = monthsWithData.length - 1; i >= 0; i--) {
      if (!lastMK) { lastMK = monthsWithData[i]; }
      else if (!prevMK) { prevMK = monthsWithData[i]; break; }
    }

    if (!lastMK) return { monthLabel: '—', teamAvg: null, topAgent: null, topVal: null, agentsCount: visibleAgents.length, change: null, aboveTarget: 0, belowTarget: 0 };

    const [, mo] = lastMK.split('-');
    const monthLabel = MONTH_NAMES[parseInt(mo, 10) - 1] || mo;

    // Last month values
    const lastVals = [];
    let topAgent = null, topVal = -1;
    visibleAgents.forEach(a => {
      const v = formatPct(figuresMap[lastMK]?.[a.agentCode]);
      if (v != null) {
        lastVals.push(v);
        if (v > topVal) { topVal = v; topAgent = a; }
      }
    });

    const teamAvg = lastVals.length ? lastVals.reduce((a, b) => a + b, 0) / lastVals.length : null;
    const aboveTarget = lastVals.filter(v => v >= 85).length;
    const belowTarget = lastVals.filter(v => v < 75).length;

    // Previous month for trend
    let change = null;
    if (prevMK) {
      const prevVals = visibleAgents
        .map(a => formatPct(figuresMap[prevMK]?.[a.agentCode]))
        .filter(v => v != null);
      const prevAvg = prevVals.length ? prevVals.reduce((a, b) => a + b, 0) / prevVals.length : null;
      if (teamAvg != null && prevAvg != null) change = teamAvg - prevAvg;
    }

    return { monthLabel, teamAvg, topAgent, topVal: topVal >= 0 ? topVal : null, agentsCount: visibleAgents.length, change, aboveTarget, belowTarget };
  }, [monthsWithData, visibleAgents, figuresMap]);

  // ── Modal ───────────────────────────────────────────────────────────────────
  function openModal() {
    const now = new Date();
    setNewMonthYear(String(now.getFullYear()));
    setNewMonthMonth(String(now.getMonth() + 1).padStart(2, '0'));
    const draft = {};
    salesAgents.filter(a => a.visible !== false).forEach(a => { draft[a.agentCode] = ''; });
    setMonthDraft(draft);
    setDraftErrors({});
    setSaveError('');
    setShowModal(true);
  }

  function closeModal() { setShowModal(false); setMonthDraft({}); setDraftErrors({}); setSaveError(''); }

  function validateDraft() {
    const errors = {};
    Object.entries(monthDraft).forEach(([code, val]) => {
      if (val === '' || val == null) return;
      const n = parseFloat(val);
      if (isNaN(n)) errors[code] = 'Must be a number';
      else if (n < 0) errors[code] = 'Cannot be negative';
      else if (n > 999) errors[code] = 'Too high (>999%)';
    });
    setDraftErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function saveNewMonth() {
    if (!newMonthYear || !newMonthMonth || !validateDraft()) return;
    const monthKey = `${newMonthYear}-${newMonthMonth}`;
    setSaving(true); setSaveError('');
    try {
      const figures = {};
      Object.entries(monthDraft).forEach(([code, val]) => {
        if (val !== '' && val != null) { const n = parseFloat(val); if (!isNaN(n)) figures[code] = n; }
      });
      await setDoc(doc(db, 'hrMonthlyFigures', monthKey), { figures }, { merge: true });
      closeModal();
    } catch (err) { setSaveError('Failed to save: ' + err.message); }
    setSaving(false);
  }

  // ── Coaching Modal Functions ─────────────────────────────────────────────────
  function openCoachingModal(agent) {
    setSelectedAgentForModal(agent);
    const existing = coachingNotes[agent.agentCode] || {};
    setCoachingNoteText(existing.note || '');
    setCoachingCheckboxes({
      coaching_needed: (existing.coachingStatus || []).includes('coaching_needed'),
      coaching_done: (existing.coachingStatus || []).includes('coaching_done'),
      '60_days_warning': (existing.coachingStatus || []).includes('60_days_warning'),
      'in_60_days': (existing.coachingStatus || []).includes('in_60_days'),
    });
    setShowCoachingModal(true);
  }

  function closeCoachingModal() {
    setShowCoachingModal(false);
    setSelectedAgentForModal(null);
    setCoachingCheckboxes({});
    setCoachingNoteText('');
  }

  async function saveCoachingNotes() {
    if (!selectedAgentForModal) return;
    setCoachingSaving(true);
    try {
      const selected = Object.entries(coachingCheckboxes)
        .filter(([_, checked]) => checked)
        .map(([key, _]) => key);
      await setDoc(
        doc(db, 'agentCoachingNotes', selectedAgentForModal.agentCode),
        { coachingStatus: selected, note: coachingNoteText.trim(), lastUpdated: new Date() },
        { merge: true }
      );
      closeCoachingModal();
    } catch (err) {
      console.error('Failed to save coaching notes:', err);
    }
    setCoachingSaving(false);
  }

  // ── Auto-Recognition Logic ──────────────────────────────────────────────────
  // Helper: compute quarterly averages and recognitions for an agent
  function computeQuarterlyRecognitions(agentCode) {
    const quarters = {
      Q1: ['01', '02', '03'],
      Q2: ['04', '05', '06'],
      Q3: ['07', '08', '09'],
      Q4: ['10', '11', '12'],
    };

    const recognitions = {};
    Object.entries(quarters).forEach(([quarter, months]) => {
      const vals = months
        .map(m => {
          const monthKey = `${selectedYear}-${m}`;
          return formatPct(figuresMap[monthKey]?.[agentCode]);
        })
        .filter(v => v != null);
      const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      recognitions[quarter.toLowerCase()] = avg != null && avg > 95;
    });
    return recognitions;
  }

  // Auto-update recognitions when figuresMap or selectedYear changes
  useEffect(() => {
    if (monthsWithData.length === 0 || agents.length === 0) return;

    const updateRecognitions = async () => {
      try {
        for (const agent of visibleAgents) {
          const recs = computeQuarterlyRecognitions(agent.agentCode);
          const existing = coachingNotes[agent.agentCode] || {};
          const hasChanged =
            recs.q1 !== existing.recognitionQ1 ||
            recs.q2 !== existing.recognitionQ2 ||
            recs.q3 !== existing.recognitionQ3 ||
            recs.q4 !== existing.recognitionQ4;

          if (hasChanged) {
            await setDoc(
              doc(db, 'agentCoachingNotes', agent.agentCode),
              {
                recognitionQ1: recs.q1,
                recognitionQ2: recs.q2,
                recognitionQ3: recs.q3,
                recognitionQ4: recs.q4,
              },
              { merge: true }
            );
          }
        }
      } catch (err) {
        console.error('Failed to update recognitions:', err);
      }
    };

    updateRecognitions();
  }, [figuresMap, selectedYear, visibleAgents, coachingNotes]);

  const filledCount = Object.values(monthDraft).filter(v => v !== '' && v != null).length;
  const totalAgents = Object.keys(monthDraft).length;
  const errCount = Object.keys(draftErrors).length;

  // ── Loading ─────────────────────────────────────────────────────────────────
  if (loading) return (
    <>
      <Navbar activeLink="sales-figures" />
      <div style={{ minHeight: 'calc(100vh - 50px)', background: 'var(--evergreen)' }}>
        <div style={{ padding: '32px 28px', maxWidth: 1400, margin: '0 auto' }}>
          <h1 style={{ fontSize: 24, fontWeight: 800, color: 'var(--mint)', marginBottom: 4 }}>Sales Figures</h1>
          <p style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 28 }}>Loading data...</p>
          <Skeleton />
        </div>
      </div>
      <style>{`@keyframes sf-pulse { 0%,100%{opacity:.6} 50%{opacity:.2} }`}</style>
    </>
  );

  const hasData = monthsWithData.length > 0 && visibleAgents.length > 0;

  // ── RENDER ──────────────────────────────────────────────────────────────────
  return (
    <>
      <Navbar activeLink="sales-figures" />
      <div style={{ minHeight: 'calc(100vh - 50px)', background: 'var(--evergreen)' }}>
        <div style={{ maxWidth: 1400, margin: '0 auto', padding: '28px 28px 40px' }}>

          {/* ── PAGE HEADER ──────────────────────────────────────────────── */}
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16, marginBottom: 28 }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
                <h1 style={{ fontSize: 26, fontWeight: 800, color: 'var(--mint)', margin: 0, letterSpacing: '-0.3px' }}>
                  Sales Team Target Performance
                </h1>
                <span style={{
                  fontSize: 11, fontWeight: 700,
                  background: 'linear-gradient(135deg, rgba(123,63,160,0.25), rgba(123,63,160,0.1))',
                  color: '#c084fc',
                  border: '1px solid rgba(123,63,160,0.3)',
                  borderRadius: 20, padding: '3px 12px',
                }}>
                  Sales Team
                </span>
              </div>
              <p style={{ fontSize: 13, color: 'var(--text-dim)', margin: 0 }}>
                {visibleAgents.length} agent{visibleAgents.length !== 1 ? 's' : ''} &middot; {selectedYear} &middot; {monthsWithData.length} month{monthsWithData.length !== 1 ? 's' : ''} of data
              </p>
            </div>

            <button
              onClick={openModal}
              style={{
                background: 'linear-gradient(135deg, var(--amethyst), #9b59b6)',
                border: 'none', borderRadius: 12,
                color: '#fff', padding: '10px 22px',
                fontSize: 14, fontWeight: 700, cursor: 'pointer',
                boxShadow: '0 4px 16px rgba(123,63,160,0.3)',
                transition: 'all 0.2s',
              }}
              onMouseEnter={e => e.currentTarget.style.transform = 'translateY(-1px)'}
              onMouseLeave={e => e.currentTarget.style.transform = 'none'}
            >
              + Add Month Data
            </button>
          </div>

          {/* ── HERO CARDS (Last Month Data) ─────────────────────────────── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16, marginBottom: 32 }}>
            <HeroCard
              icon="📈"
              title="Team Average"
              value={heroData.teamAvg != null ? `${heroData.teamAvg.toFixed(1)}%` : '—'}
              sub={`${heroData.monthLabel} performance`}
              accent={heroData.teamAvg != null ? getColor(heroData.teamAvg).color : '#2ECC8A'}
              change={heroData.change}
            />
            <HeroCard
              icon="🏆"
              title="Top Performer"
              value={heroData.topAgent ? (heroData.topAgent.displayName || heroData.topAgent.agentCode) : '—'}
              sub={heroData.topVal != null ? `${heroData.topVal.toFixed(1)}% in ${heroData.monthLabel}` : undefined}
              accent="#f0c060"
            />
            <HeroCard
              icon="✅"
              title="On Target"
              value={heroData.aboveTarget}
              sub={`Agents ≥ 85% in ${heroData.monthLabel}`}
              accent="#2ECC8A"
            />
            <HeroCard
              icon="⚠️"
              title="Needs Attention"
              value={heroData.belowTarget}
              sub={`Agents < 75% in ${heroData.monthLabel}`}
              accent={heroData.belowTarget > 0 ? '#ff6b6b' : '#2ECC8A'}
            />
          </div>

          {/* ── FILTERS ──────────────────────────────────────────────────── */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24, flexWrap: 'wrap',
            background: 'rgba(13,26,19,0.5)', borderRadius: 14, padding: '12px 16px',
            border: '1px solid var(--border)',
          }}>
            {/* Year pills */}
            <div style={{ display: 'flex', gap: 6, marginRight: 8 }}>
              {availableYears.map(yr => (
                <YearPill key={yr} year={yr} active={yr === selectedYear} onClick={() => {
                  setSelectedYear(yr);
                  const lastMonth = yr === CURRENT_YEAR
                    ? String(CURRENT_MONTH_IDX + 1).padStart(2, '0')
                    : '12';
                  setFilterStartDate(`${yr}-01`);
                  setFilterEndDate(`${yr}-${lastMonth}`);
                }} />
              ))}
            </div>

            <div style={{ width: 1, height: 28, background: 'var(--border)', margin: '0 4px' }} />

            {/* Date Range Filter */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, color: 'var(--text-dim)', fontWeight: 500 }}>From:</span>
              <select
                value={filterStartDate}
                onChange={e => {
                  const val = e.target.value;
                  setFilterStartDate(val);
                  if (filterEndDate < val) setFilterEndDate(val);
                }}
                style={{
                  background: 'rgba(27,58,45,0.8)', border: '1px solid var(--border)',
                  borderRadius: 6, color: 'var(--mint)', padding: '5px 8px',
                  fontSize: 12, cursor: 'pointer', outline: 'none', minWidth: 120,
                }}
              >
                {monthKeys.map(mk => {
                  const [yr, mo] = mk.split('-');
                  const label = `${MONTH_NAMES[parseInt(mo) - 1]} ${yr}`;
                  return <option key={mk} value={mk}>{label}</option>;
                })}
              </select>
              <span style={{ fontSize: 12, color: 'var(--text-dim)', fontWeight: 500, marginLeft: 4 }}>To:</span>
              <select
                value={filterEndDate}
                onChange={e => setFilterEndDate(e.target.value)}
                style={{
                  background: 'rgba(27,58,45,0.8)', border: '1px solid var(--border)',
                  borderRadius: 6, color: 'var(--mint)', padding: '5px 8px',
                  fontSize: 12, cursor: 'pointer', outline: 'none', minWidth: 120,
                }}
              >
                {monthKeys.filter(mk => mk >= filterStartDate).map(mk => {
                  const [yr, mo] = mk.split('-');
                  const label = `${MONTH_NAMES[parseInt(mo) - 1]} ${yr}`;
                  return <option key={mk} value={mk}>{label}</option>;
                })}
              </select>
            </div>

            {/* Legend */}
            <div style={{ flex: 1 }} />
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              {[
                { label: '>100%', color: '#FFD700', bg: 'rgba(255,215,0,0.25)' },
                { label: '75–100%', color: '#2ECC8A', bg: 'rgba(46,204,138,0.18)' },
                { label: '<75%', color: '#ff6b6b', bg: 'rgba(231,76,60,0.22)' },
              ].map(l => (
                <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: l.color }}>
                  <div style={{ width: 10, height: 10, borderRadius: 3, background: l.bg, border: `1px solid ${l.color}55` }} />
                  {l.label}
                </div>
              ))}
            </div>
          </div>

          {/* ── TABLE ────────────────────────────────────────────────────── */}
          {!hasData ? (
            <div style={{
              textAlign: 'center', padding: '80px 20px',
              background: 'rgba(27,58,45,0.3)', borderRadius: 16,
              border: '1px solid var(--border)',
            }}>
              <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.6 }}>📊</div>
              <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--mint)', marginBottom: 8 }}>
                {salesAgents.length ? 'No data for ' + selectedYear : 'No sales agents found'}
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-dim)', maxWidth: 440, margin: '0 auto', lineHeight: 1.7 }}>
                {salesAgents.length
                  ? 'Switch to a different year or use "Add Month Data" to enter figures.'
                  : 'Add agents with type "Sales" in Admin → Agent Mappings first.'}
              </div>
            </div>
          ) : (
            <div style={{
              borderRadius: 16, border: '1px solid var(--border)',
              background: 'rgba(13,26,19,0.5)',
            }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13, tableLayout: 'fixed' }}>
                  <thead>
                    <tr>
                      <th style={{
                        position: 'sticky', top: 0, left: 0, zIndex: 31,
                        background: 'rgba(13,26,19,0.98)', padding: '10px 12px',
                        textAlign: 'left', fontSize: 11, fontWeight: 600,
                        color: 'var(--text-dim)', textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                        borderBottom: '2px solid var(--border)',
                        width: '14%',
                      }}>
                        Agent
                      </th>
                      {monthsWithData.map((mk, i) => {
                        const moIdx = parseInt(mk.split('-')[1], 10) - 1;
                        const isLatest = i === monthsWithData.length - 1;
                        return (
                          <th key={mk} style={{
                            position: 'sticky', top: 0, zIndex: 20,
                            background: isLatest ? 'rgba(46,204,138,0.08)' : 'rgba(13,26,19,0.98)',
                            padding: '10px 4px', textAlign: 'center',
                            fontSize: 11, fontWeight: 600,
                            color: isLatest ? '#2ECC8A' : 'var(--text-dim)',
                            textTransform: 'uppercase', letterSpacing: '0.04em',
                            borderBottom: '2px solid var(--border)',
                          }}>
                            {MONTH_NAMES[moIdx]}
                          </th>
                        );
                      })}
                      <th style={{
                        position: 'sticky', top: 0, zIndex: 20,
                        background: 'rgba(123,63,160,0.1)', padding: '10px 8px',
                        textAlign: 'center', fontSize: 11, fontWeight: 700,
                        color: '#c084fc', textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                        borderBottom: '2px solid var(--border)',
                        width: '7%',
                      }}>
                        YTD Avg
                      </th>
                      <th style={{
                        position: 'sticky', top: 0, zIndex: 20,
                        background: 'rgba(46,204,138,0.06)', padding: '10px 8px',
                        textAlign: 'center', fontSize: 11, fontWeight: 700,
                        color: '#2ECC8A', textTransform: 'uppercase',
                        letterSpacing: '0.04em',
                        borderBottom: '2px solid var(--border)',
                        width: '9%', whiteSpace: 'nowrap',
                      }}>
                        3M Trend
                      </th>
                    </tr>

                    {/* Team average row */}
                    {visibleAgents.length > 1 && (
                      <tr>
                        <td style={{
                          position: 'sticky', top: 42, left: 0, zIndex: 31,
                          background: 'rgba(13,26,19,0.95)', padding: '8px 12px',
                          fontSize: 12, fontWeight: 700, color: '#c084fc',
                          borderBottom: '2px solid rgba(123,63,160,0.3)',
                        }}>
                          Team Average
                        </td>
                        {teamAvgByMonth.map((avg, i) => {
                          const isLatest = i === teamAvgByMonth.length - 1;
                          return (
                            <td key={i} style={{
                              position: 'sticky', top: 42, zIndex: 20,
                              background: isLatest ? 'rgba(46,204,138,0.05)' : 'rgba(13,26,19,0.95)',
                              padding: '8px 4px', textAlign: 'center',
                              borderBottom: '2px solid rgba(123,63,160,0.3)',
                            }}>
                              {avg != null
                                ? <span style={{ color: getColor(avg).color, fontWeight: 700, fontSize: 13 }}>{avg.toFixed(1)}%</span>
                                : <span style={{ color: 'var(--text-dim)' }}>—</span>}
                            </td>
                          );
                        })}
                        <td style={{
                          position: 'sticky', top: 42, zIndex: 20,
                          background: 'rgba(123,63,160,0.08)', padding: '8px 6px',
                          textAlign: 'center', borderBottom: '2px solid rgba(123,63,160,0.3)',
                        }}>
                          {(() => {
                            const allAvgs = visibleAgents.map(a => agentYearAvg(a.agentCode)).filter(v => v != null);
                            const overall = allAvgs.length ? allAvgs.reduce((a, b) => a + b, 0) / allAvgs.length : null;
                            if (overall == null) return <span style={{ color: 'var(--text-dim)' }}>—</span>;
                            const c = getColor(overall);
                            return <span style={{ color: c.color, fontWeight: 700, fontSize: 13 }}>{overall.toFixed(1)}%</span>;
                          })()}
                        </td>
                        <td style={{
                          position: 'sticky', top: 42, zIndex: 20,
                          background: 'rgba(46,204,138,0.04)', padding: '8px 6px',
                          textAlign: 'center', borderBottom: '2px solid rgba(123,63,160,0.3)',
                        }}>
                          {(() => {
                            const last3 = monthsWithData.slice(-3);
                            const vals = last3.map(mk => {
                              const avgs = visibleAgents.map(a => formatPct(figuresMap[mk]?.[a.agentCode])).filter(v => v != null);
                              return avgs.length ? avgs.reduce((a, b) => a + b, 0) / avgs.length : null;
                            });
                            return <MiniTrend values={vals} />;
                          })()}
                        </td>
                      </tr>
                    )}
                  </thead>

                  <tbody>
                    {visibleAgents.map((agent, idx) => {
                      const even = idx % 2 === 0;
                      const hidden = agent.visible === false;
                      const avg = agentYearAvg(agent.agentCode);
                      const avgColor = getColor(avg);

                      return (
                        <tr
                          key={agent.agentCode}
                          style={{
                            opacity: hidden ? 0.5 : 1,
                            transition: 'background 0.15s',
                          }}
                          onMouseEnter={e => e.currentTarget.style.background = 'rgba(216,245,236,0.04)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                        >
                          {/* Agent name */}
                          <td style={{
                            position: 'sticky', left: 0, zIndex: 10,
                            background: even ? 'rgba(27,58,45,0.5)' : 'rgba(27,58,45,0.3)',
                            padding: '8px 12px',
                            borderBottom: '1px solid rgba(216,245,236,0.04)',
                          }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              {hidden && (
                                <span style={{
                                  fontSize: 9, fontWeight: 700,
                                  background: 'rgba(231,76,60,0.15)', color: '#ff6b6b',
                                  borderRadius: 4, padding: '2px 6px', textTransform: 'uppercase',
                                }}>
                                  Hidden
                                </span>
                              )}
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                                <button
                                  onClick={() => openCoachingModal(agent)}
                                  style={{
                                    background: 'transparent', border: 'none',
                                    fontWeight: 600, color: hidden ? 'var(--text-dim)' : 'var(--mint)', fontSize: 13,
                                    cursor: 'pointer', padding: 0, font: 'inherit',
                                    textDecoration: 'underline', textDecorationColor: 'rgba(46,204,138,0.3)', textUnderlineOffset: 3,
                                    textAlign: 'left',
                                  }}
                                  title="Click to add coaching notes"
                                >
                                  {agent.displayName || agent.agentCode || '—'}
                                </button>
                                {(() => {
                                  const cn = coachingNotes[agent.agentCode] || {};
                                  const statuses = cn.coachingStatus || [];
                                  const STATUS_LABELS = {
                                    coaching_needed: 'Coaching Needed',
                                    coaching_done: 'Coaching Done',
                                    '60_days_warning': '60 Days Warning',
                                    in_60_days: 'In 60 Days',
                                  };
                                  const items = [
                                    ...statuses.map(s => STATUS_LABELS[s] || s),
                                    ...(cn.note ? [cn.note] : []),
                                  ];
                                  return items.map((item, i) => (
                                    <span key={i} style={{
                                      fontSize: 11, color: '#ff6b6b', fontWeight: 500,
                                      lineHeight: 1.3, maxWidth: 160,
                                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                      display: 'block',
                                    }} title={item}>
                                      {item}
                                    </span>
                                  ));
                                })()}
                              </div>
                            </div>
                          </td>

                          {/* Monthly values */}
                          {monthsWithData.map((mk, mi) => {
                            const raw = figuresMap[mk]?.[agent.agentCode];
                            const v = formatPct(raw);
                            const c = getColor(v);
                            const isLatest = mi === monthsWithData.length - 1;
                            return (
                              <td key={mk} style={{
                                padding: '8px 2px', textAlign: 'center',
                                borderBottom: '1px solid rgba(216,245,236,0.04)',
                                background: isLatest && !hidden ? 'rgba(46,204,138,0.03)' : 'transparent',
                              }}>
                                {v != null ? (
                                  <span style={{
                                    color: hidden ? 'var(--text-dim)' : c.color,
                                    fontWeight: hidden ? 400 : (v >= 95 || v < 75 ? 700 : 500),
                                    fontSize: 12,
                                    padding: '2px 5px',
                                    borderRadius: 5,
                                    background: hidden ? 'transparent' : c.bg,
                                    display: 'inline-block',
                                  }}>
                                    {v.toFixed(1)}%
                                  </span>
                                ) : (
                                  <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>—</span>
                                )}
                              </td>
                            );
                          })}

                          {/* YTD Avg */}
                          <td style={{
                            padding: '8px 6px', textAlign: 'center',
                            background: hidden ? 'rgba(27,58,45,0.15)' : 'rgba(123,63,160,0.06)',
                            borderBottom: '1px solid rgba(216,245,236,0.04)',
                          }}>
                            {avg != null ? (
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                                <span style={{ color: avgColor.color, fontWeight: 700, fontSize: 12 }}>{avg.toFixed(1)}%</span>
                                <MiniBar value={avg} />
                              </div>
                            ) : (
                              <span style={{ color: 'var(--text-dim)' }}>—</span>
                            )}
                          </td>

                          {/* 3 Months Trend */}
                          <td style={{
                            padding: '8px 4px', textAlign: 'center',
                            background: hidden ? 'rgba(27,58,45,0.15)' : 'rgba(46,204,138,0.03)',
                            borderBottom: '1px solid rgba(216,245,236,0.04)',
                          }}>
                            {(() => {
                              const last3 = monthsWithData.slice(-3);
                              const vals = last3.map(mk => formatPct(figuresMap[mk]?.[agent.agentCode]));
                              return <MiniTrend values={vals} />;
                            })()}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

              {/* Table footer */}
              <div style={{
                padding: '10px 16px',
                borderTop: '1px solid var(--border)',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                fontSize: 11, color: 'var(--text-dim)',
              }}>
                <span>Figures shown as % of target</span>
                <span>{visibleAgents.length} agents &middot; {monthsWithData.length} months</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── ADD MONTH MODAL ──────────────────────────────────────────── */}
      {showModal && (
        <div
          style={{
            position: 'fixed', inset: 0,
            background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000,
          }}
          onClick={e => { if (e.target === e.currentTarget) closeModal(); }}
        >
          <div style={{
            background: 'linear-gradient(160deg, rgba(27,58,45,0.98), rgba(13,26,19,0.99))',
            border: '1px solid rgba(216,245,236,0.12)',
            borderRadius: 20, padding: 28, width: '92%', maxWidth: 800,
            maxHeight: '88vh', display: 'flex', flexDirection: 'column',
            boxShadow: '0 32px 80px rgba(0,0,0,0.5)',
          }}>
            {/* Modal header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: 'var(--mint)' }}>Add Month Data</h2>
                <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-dim)' }}>Enter % of target for each agent</p>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{
                  fontSize: 12, color: 'var(--text-dim)',
                  background: 'rgba(27,58,45,0.8)', borderRadius: 20, padding: '4px 14px',
                  border: '1px solid var(--border)',
                }}>
                  <span style={{ color: filledCount > 0 ? '#2ECC8A' : 'var(--text-dim)', fontWeight: 700 }}>{filledCount}</span> / {totalAgents}
                </span>
                <button
                  onClick={closeModal}
                  style={{
                    background: 'rgba(231,76,60,0.12)', border: '1px solid rgba(231,76,60,0.25)',
                    borderRadius: 8, color: '#ff6b6b', fontSize: 18, fontWeight: 700,
                    cursor: 'pointer', padding: '2px 10px', lineHeight: 1,
                  }}
                >×</button>
              </div>
            </div>

            {/* Month selector */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--text-dim)', marginBottom: 4, fontWeight: 500 }}>Year</label>
                <select
                  value={newMonthYear}
                  onChange={e => setNewMonthYear(e.target.value)}
                  style={{
                    background: 'rgba(27,58,45,0.8)', border: '1px solid var(--border)',
                    borderRadius: 8, color: 'var(--mint)', padding: '7px 12px', fontSize: 13, outline: 'none',
                  }}
                >
                  {Array.from({ length: 5 }, (_, i) => 2024 + i).map(y => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--text-dim)', marginBottom: 4, fontWeight: 500 }}>Month</label>
                <select
                  value={newMonthMonth}
                  onChange={e => setNewMonthMonth(e.target.value)}
                  style={{
                    background: 'rgba(27,58,45,0.8)', border: '1px solid var(--border)',
                    borderRadius: 8, color: 'var(--mint)', padding: '7px 12px', fontSize: 13, outline: 'none', minWidth: 120,
                  }}
                >
                  {FULL_MONTHS.map((m, i) => <option key={m} value={String(i + 1).padStart(2, '0')}>{m}</option>)}
                </select>
              </div>
              <div style={{
                padding: '7px 14px', background: 'rgba(46,204,138,0.1)',
                border: '1px solid rgba(46,204,138,0.25)', borderRadius: 8,
                fontSize: 13, color: '#2ECC8A', fontWeight: 600,
              }}>
                {MONTH_NAMES[parseInt(newMonthMonth, 10) - 1]} {newMonthYear}
              </div>
            </div>

            {saveError && (
              <div style={{
                background: 'rgba(231,76,60,0.12)', border: '1px solid rgba(231,76,60,0.3)',
                borderRadius: 8, padding: '10px 14px', marginBottom: 12, fontSize: 13, color: '#ff6b6b',
              }}>
                {saveError}
              </div>
            )}

            {/* Entry list */}
            <div style={{ flex: 1, overflow: 'auto', marginBottom: 16, borderRadius: 12, border: '1px solid var(--border)' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead style={{ position: 'sticky', top: 0, background: 'rgba(13,26,19,0.97)', zIndex: 10 }}>
                  <tr>
                    <th style={{ padding: '10px 14px', textAlign: 'left', borderBottom: '1px solid var(--border)', fontSize: 11, color: 'var(--text-dim)', fontWeight: 600 }}>Agent</th>
                    <th style={{ padding: '10px 14px', textAlign: 'right', borderBottom: '1px solid var(--border)', fontSize: 11, color: 'var(--text-dim)', fontWeight: 600 }}>Figure (%)</th>
                    <th style={{ padding: '10px 14px', textAlign: 'center', borderBottom: '1px solid var(--border)', fontSize: 11, color: 'var(--text-dim)', fontWeight: 600, width: 80 }}>Preview</th>
                  </tr>
                </thead>
                <tbody>
                  {salesAgents
                    .filter(a => a.visible !== false)
                    .sort((a, b) => (a.displayName || a.agentCode || '').localeCompare(b.displayName || b.agentCode || ''))
                    .map((agent, idx) => {
                      const val = monthDraft[agent.agentCode] ?? '';
                      const num = parseFloat(val);
                      const hasVal = val !== '' && !isNaN(num);
                      const hasError = !!draftErrors[agent.agentCode];
                      const prevColor = hasVal ? getColor(num).color : 'var(--text-dim)';
                      return (
                        <tr key={agent.agentCode} style={{ background: idx % 2 === 0 ? 'rgba(27,58,45,0.3)' : 'transparent' }}>
                          <td style={{ padding: '9px 14px', borderBottom: '1px solid rgba(216,245,236,0.04)', fontWeight: 600 }}>
                            {agent.displayName || agent.agentCode}
                          </td>
                          <td style={{ padding: '9px 14px', borderBottom: '1px solid rgba(216,245,236,0.04)', textAlign: 'right' }}>
                            <input
                              type="number"
                              step="0.01" min="0" max="999"
                              placeholder="e.g. 96.2"
                              value={val}
                              onChange={e => {
                                setMonthDraft(prev => ({ ...prev, [agent.agentCode]: e.target.value }));
                                if (draftErrors[agent.agentCode])
                                  setDraftErrors(prev => { const n = { ...prev }; delete n[agent.agentCode]; return n; });
                              }}
                              style={{
                                background: 'rgba(27,58,45,0.7)', border: `1px solid ${hasError ? 'rgba(231,76,60,0.5)' : 'var(--border)'}`,
                                borderRadius: 8, color: 'var(--mint)', padding: '7px 11px',
                                fontSize: 13, outline: 'none', width: 110, textAlign: 'right',
                              }}
                            />
                            {hasError && <div style={{ fontSize: 10, color: '#ff6b6b', marginTop: 2 }}>{draftErrors[agent.agentCode]}</div>}
                          </td>
                          <td style={{ padding: '9px 14px', borderBottom: '1px solid rgba(216,245,236,0.04)', textAlign: 'center', fontWeight: hasVal ? 700 : 400, color: prevColor, fontFamily: 'monospace' }}>
                            {hasVal ? `${num.toFixed(1)}%` : '—'}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>

            {/* Modal actions */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: errCount > 0 ? '#ff6b6b' : 'transparent' }}>
                {errCount > 0 ? `${errCount} error${errCount !== 1 ? 's' : ''} — fix before saving` : '.'}
              </span>
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  onClick={closeModal}
                  style={{
                    background: 'rgba(27,58,45,0.6)', border: '1px solid var(--border)',
                    borderRadius: 10, color: 'var(--text-dim)', padding: '9px 20px',
                    fontSize: 13, cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={saveNewMonth}
                  disabled={saving}
                  style={{
                    background: 'linear-gradient(135deg, var(--amethyst), #9b59b6)',
                    border: 'none', borderRadius: 10,
                    color: '#fff', padding: '9px 22px',
                    fontSize: 13, fontWeight: 700, cursor: 'pointer',
                    opacity: saving ? 0.6 : 1,
                  }}
                >
                  {saving ? 'Saving...' : `Save ${MONTH_NAMES[parseInt(newMonthMonth, 10) - 1]} ${newMonthYear}`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Coaching Modal */}
      {showCoachingModal && selectedAgentForModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
          backdropFilter: 'blur(4px)',
        }}>
          <div style={{
            background: 'linear-gradient(135deg, rgba(27,58,45,0.95) 0%, rgba(13,26,19,0.95) 100%)',
            border: '1px solid var(--border)', borderRadius: 16, padding: '28px 32px',
            maxWidth: 420, width: '90%', boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
          }}>
            <h2 style={{
              fontSize: 18, fontWeight: 700, color: 'var(--mint)', marginBottom: 24,
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              📝 Coaching Notes
            </h2>

            <div style={{ marginBottom: 20 }}>
              <p style={{ fontSize: 13, color: 'var(--text-mid)', marginBottom: 12 }}>
                Agent: <strong style={{ color: 'var(--mint)' }}>{selectedAgentForModal.displayName || selectedAgentForModal.agentCode}</strong>
              </p>
            </div>

            {/* Note text */}
            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 12, color: 'var(--text-dim)', fontWeight: 600, display: 'block', marginBottom: 6 }}>
                Note
              </label>
              <textarea
                value={coachingNoteText}
                onChange={e => setCoachingNoteText(e.target.value)}
                placeholder="Add a note for this agent..."
                rows={3}
                style={{
                  width: '100%', boxSizing: 'border-box',
                  background: 'rgba(13,26,19,0.7)', border: '1px solid var(--border)',
                  borderRadius: 8, color: '#ff6b6b', padding: '8px 12px',
                  fontSize: 13, fontFamily: 'inherit', resize: 'vertical', outline: 'none',
                }}
              />
            </div>

            {/* Checkboxes */}
            <div style={{ marginBottom: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
              {[
                { key: 'coaching_needed', label: 'Coaching Needed' },
                { key: 'coaching_done', label: 'Coaching Done' },
                { key: '60_days_warning', label: '60 Days Warning' },
                { key: 'in_60_days', label: 'In 60 Days' },
              ].map(item => (
                <label
                  key={item.key}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
                    padding: '10px 12px', borderRadius: 8,
                    background: coachingCheckboxes[item.key] ? 'rgba(46,204,138,0.1)' : 'transparent',
                    border: coachingCheckboxes[item.key] ? '1px solid rgba(46,204,138,0.3)' : '1px solid transparent',
                    transition: 'all 0.2s',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={coachingCheckboxes[item.key] || false}
                    onChange={e => setCoachingCheckboxes(prev => ({ ...prev, [item.key]: e.target.checked }))}
                    style={{
                      width: 18, height: 18, cursor: 'pointer', accentColor: '#2ECC8A',
                    }}
                  />
                  <span style={{ fontSize: 13, color: 'var(--text-mid)', fontWeight: 500 }}>
                    {item.label}
                  </span>
                </label>
              ))}
            </div>

            {/* Buttons */}
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={closeCoachingModal}
                disabled={coachingSaving}
                style={{
                  flex: 1, background: 'rgba(27,58,45,0.6)', border: '1px solid var(--border)',
                  borderRadius: 10, color: 'var(--text-dim)', padding: '10px 16px',
                  fontSize: 13, cursor: 'pointer', fontWeight: 500,
                }}
              >
                Cancel
              </button>
              <button
                onClick={saveCoachingNotes}
                disabled={coachingSaving}
                style={{
                  flex: 1, background: 'linear-gradient(135deg, var(--amethyst), #9b59b6)',
                  border: 'none', borderRadius: 10, color: '#fff', padding: '10px 16px',
                  fontSize: 13, fontWeight: 700, cursor: 'pointer',
                  opacity: coachingSaving ? 0.6 : 1,
                }}
              >
                {coachingSaving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`@keyframes sf-pulse { 0%,100%{opacity:.6} 50%{opacity:.2} }`}</style>
    </>
  );
}
