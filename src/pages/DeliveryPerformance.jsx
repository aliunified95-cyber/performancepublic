import React, { useState, useEffect, useMemo } from 'react';
import {
  collection,
  query,
  orderBy,
  getDocs,
} from 'firebase/firestore';
import { db } from '../firebase';
import Navbar from '../components/Navbar';

// ─── HELPERS ───────────────────────────────────────────────────────────────────
function fmtTime(sec) {
  if (!sec || isNaN(sec) || sec <= 0) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

function avg(arr) {
  const v = arr.filter(x => x != null && !isNaN(x) && x > 0);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}

function pct(num, den) {
  if (!den) return 0;
  return Math.round((num / den) * 100);
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

function fmtDate(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-GB', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
  });
}

// ─── DAY DETAIL MODAL ──────────────────────────────────────────────────────────
function DayDetailModal({ isOpen, onClose, dayData }) {
  useEffect(() => {
    if (!isOpen) return;
    function handleEsc(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', handleEsc);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleEsc);
      document.body.style.overflow = '';
    };
  }, [isOpen, onClose]);

  const stats = useMemo(() => {
    if (!dayData) return null;
    const { shipments } = dayData;
    const created      = shipments.length;
    const delivered    = shipments.filter(s => s.status === 'delivered').length;
    const undelivered  = created - delivered;
    const attempt1     = shipments.filter(s => s.status === 'delivered' && s.attempt === 1).length;
    const attempt2     = shipments.filter(s => s.status === 'delivered' && s.attempt === 2).length;
    const attempt3plus = shipments.filter(s => s.status === 'delivered' && s.attempt >= 3).length;
    const avgDeliveryTimeSec = Math.round(avg(
      shipments.filter(s => s.status === 'delivered').map(s => s.deliveryTimeSec)
    ));

    // Problem code breakdown — collect ALL problem codes from ALL attempt columns
    // for ALL shipments (includes failed attempts even on ultimately-delivered orders)
    const problemMap = {};
    shipments.forEach(s => {
      [s.prob1, s.prob2, s.prob3].forEach(code => {
        if (code && code.trim()) {
          problemMap[code.trim()] = (problemMap[code.trim()] || 0) + 1;
        }
      });
    });
    const totalProblems = Object.values(problemMap).reduce((a, b) => a + b, 0);
    const problemBreakdown = Object.entries(problemMap)
      .sort((a, b) => b[1] - a[1])
      .map(([code, count]) => ({ code, count, pct: pct(count, totalProblems) }));

    return { created, delivered, undelivered, attempt1, attempt2, attempt3plus, avgDeliveryTimeSec, problemBreakdown, totalProblems };
  }, [dayData]);

  if (!isOpen || !dayData || !stats) return null;

  const ATTEMPT_COLORS = ['var(--emerald)', '#ffc107', '#E74C3C'];

  return (
    <div
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        backgroundColor: 'rgba(0,0,0,0.72)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000, padding: '20px',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: 'linear-gradient(145deg, #1a1a2e 0%, #16213e 100%)',
        borderRadius: '16px',
        border: '1px solid rgba(216,245,236,0.1)',
        boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)',
        maxWidth: '820px',
        width: '100%',
        maxHeight: '90vh',
        overflow: 'auto',
        animation: 'modalSlideIn 0.3s ease-out',
      }}>
        {/* Header */}
        <div style={{
          padding: '22px 24px 16px',
          borderBottom: '1px solid rgba(216,245,236,0.1)',
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
            <div style={{
              width: '48px', height: '48px', borderRadius: '12px',
              background: 'rgba(46,204,138,0.15)', display: 'flex',
              alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--emerald)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
                <line x1="16" y1="2" x2="16" y2="6"/>
                <line x1="8" y1="2" x2="8" y2="6"/>
                <line x1="3" y1="10" x2="21" y2="10"/>
              </svg>
            </div>
            <div>
              <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 700 }}>
                {fmtDate(dayData.date)}
              </h2>
              <p style={{ margin: '2px 0 0', fontSize: '13px', color: 'rgba(216,245,236,0.5)' }}>
                {stats.created.toLocaleString()} shipments · {stats.delivered.toLocaleString()} delivered
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'rgba(216,245,236,0.08)', border: 'none', color: '#D8F5EC',
              width: '32px', height: '32px', borderRadius: '8px', cursor: 'pointer',
              fontSize: '18px', display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
            }}
            aria-label="Close modal"
          >
            ×
          </button>
        </div>

        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>

          {/* Summary KPIs */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px' }}>
            {[
              { label: 'Created', value: stats.created.toLocaleString(), color: '#3A7BD5', bg: 'rgba(58,123,213,0.1)' },
              { label: 'Delivered', value: stats.delivered.toLocaleString(), sub: `${pct(stats.delivered, stats.created)}% rate`, color: 'var(--emerald)', bg: 'rgba(46,204,138,0.1)' },
              { label: 'Undelivered', value: stats.undelivered.toLocaleString(), sub: `${pct(stats.undelivered, stats.created)}% of total`, color: stats.undelivered > 0 ? '#E74C3C' : 'var(--text-dim)', bg: stats.undelivered > 0 ? 'rgba(231,76,60,0.08)' : 'rgba(216,245,236,0.04)' },
              { label: 'Avg Delivery Time', value: fmtTime(stats.avgDeliveryTimeSec), color: '#ffc107', bg: 'rgba(255,193,7,0.08)' },
            ].map(({ label, value, sub, color, bg }) => (
              <div key={label} style={{ background: bg, borderRadius: '10px', padding: '14px', border: '1px solid rgba(216,245,236,0.06)' }}>
                <div style={{ fontSize: '11px', color: 'rgba(216,245,236,0.4)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>{label}</div>
                <div style={{ fontSize: '22px', fontWeight: 700, color }}>{value}</div>
                {sub && <div style={{ fontSize: '11px', color: 'rgba(216,245,236,0.4)', marginTop: '3px' }}>{sub}</div>}
              </div>
            ))}
          </div>

          {/* Attempt breakdown */}
          <div style={{ background: 'rgba(216,245,236,0.03)', borderRadius: '10px', padding: '16px', border: '1px solid rgba(216,245,236,0.06)' }}>
            <div style={{ fontSize: '12px', fontWeight: 600, color: 'rgba(216,245,236,0.4)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '14px' }}>
              Delivery Attempts (of delivered)
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px' }}>
              {[
                { label: '1st Attempt', count: stats.attempt1 },
                { label: '2nd Attempt', count: stats.attempt2 },
                { label: '3rd+ Attempt', count: stats.attempt3plus },
              ].map(({ label, count }, i) => {
                const rate = pct(count, stats.delivered);
                return (
                  <div key={label}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                      <span style={{ fontSize: '13px' }}>{label}</span>
                      <span style={{ fontSize: '13px', fontWeight: 600, color: ATTEMPT_COLORS[i] }}>
                        {count.toLocaleString()} <span style={{ fontWeight: 400, color: 'rgba(216,245,236,0.5)', fontSize: '11px' }}>({rate}%)</span>
                      </span>
                    </div>
                    <div style={{ height: '6px', borderRadius: '3px', background: 'rgba(216,245,236,0.08)' }}>
                      <div style={{ height: '100%', borderRadius: '3px', width: `${rate}%`, background: ATTEMPT_COLORS[i], transition: 'width 0.4s ease' }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Problem code breakdown */}
          {stats.problemBreakdown.length > 0 && (
            <div style={{ background: 'rgba(231,76,60,0.04)', borderRadius: '10px', padding: '16px', border: '1px solid rgba(231,76,60,0.12)' }}>
              <div style={{ fontSize: '12px', fontWeight: 600, color: 'rgba(231,76,60,0.7)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '14px' }}>
                Failed Attempt Reasons · {stats.totalProblems.toLocaleString()} recorded failures
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {stats.problemBreakdown.map(({ code, count, pct: p }) => (
                  <div key={code}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '5px' }}>
                      <span style={{ fontSize: '13px', color: '#D8F5EC' }}>{code}</span>
                      <span style={{ fontSize: '13px', fontWeight: 600, flexShrink: 0, marginLeft: '12px' }}>
                        {count.toLocaleString()}
                        <span style={{ fontSize: '11px', color: 'rgba(216,245,236,0.4)', marginLeft: '5px' }}>{p}%</span>
                      </span>
                    </div>
                    <div style={{ height: '6px', borderRadius: '3px', background: 'rgba(216,245,236,0.08)' }}>
                      <div style={{ height: '100%', borderRadius: '3px', width: `${p}%`, background: '#E74C3C', transition: 'width 0.4s ease' }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Shipment list */}
          <div>
            <div style={{ fontSize: '12px', fontWeight: 600, color: 'rgba(216,245,236,0.4)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '12px' }}>
              Shipments ({dayData.shipments.length.toLocaleString()})
            </div>
            <div style={{ maxHeight: '280px', overflowY: 'auto', borderRadius: '8px', border: '1px solid rgba(216,245,236,0.08)' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                <thead>
                  <tr style={{ background: 'rgba(216,245,236,0.05)', position: 'sticky', top: 0 }}>
                    {['AWB (Order No.)', 'Status', 'Attempt', 'Delivery Time', 'Problem Code'].map(h => (
                      <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: 'rgba(216,245,236,0.5)', fontSize: '11px', whiteSpace: 'nowrap', borderBottom: '1px solid rgba(216,245,236,0.08)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {dayData.shipments.map((s, i) => (
                    <tr key={s.awb + i} style={{ borderBottom: '1px solid rgba(216,245,236,0.04)' }}>
                      <td style={{ padding: '8px 12px', fontFamily: 'monospace', fontSize: '11px', color: '#3A7BD5' }}>{s.awb || '—'}</td>
                      <td style={{ padding: '8px 12px' }}>
                        <span style={{
                          padding: '2px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: 600,
                          background: s.status === 'delivered' ? 'rgba(46,204,138,0.15)' : 'rgba(231,76,60,0.15)',
                          color: s.status === 'delivered' ? 'var(--emerald)' : '#E74C3C',
                        }}>
                          {s.status === 'delivered' ? 'Delivered' : 'Undelivered'}
                        </span>
                      </td>
                      <td style={{ padding: '8px 12px', color: s.attempt ? ['var(--emerald)', '#ffc107', '#E74C3C'][Math.min(s.attempt - 1, 2)] : 'var(--text-dim)' }}>
                        {s.attempt ? `${s.attempt}${s.attempt >= 3 ? '+' : ''}` : '—'}
                      </td>
                      <td style={{ padding: '8px 12px', color: 'rgba(216,245,236,0.7)' }}>
                        {fmtTime(s.deliveryTimeSec)}
                      </td>
                      <td style={{ padding: '8px 12px', color: s.problemCode ? '#E74C3C' : 'var(--text-dim)', fontSize: '11px' }}>
                        {s.problemCode || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── SUB-COMPONENTS ────────────────────────────────────────────────────────────
function LoadingState() {
  return (
    <div className="loading-state">
      <div className="spinner-lg" aria-hidden="true" />
      <p>Loading delivery data…</p>
    </div>
  );
}

function EmptyState() {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', padding: '80px 24px', gap: '16px',
      color: 'rgba(216,245,236,0.4)',
    }}>
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <rect x="1" y="3" width="15" height="13" rx="1"/>
        <path d="M16 8h4l3 3v5h-7V8z"/>
        <circle cx="5.5" cy="18.5" r="2.5"/>
        <circle cx="18.5" cy="18.5" r="2.5"/>
      </svg>
      <p style={{ fontSize: '15px', margin: 0 }}>No delivery data for this period</p>
      <p style={{ fontSize: '13px', margin: 0 }}>Upload a delivery report via Admin → Delivery Upload</p>
    </div>
  );
}

function HeroBadge({ stats, periodLabel }) {
  const {
    created, delivered, undelivered,
    attempt1, attempt2, attempt3plus,
    avgDeliveryTimeSec, avgAwbToFirstAttemptSec,
  } = stats;

  const deliveryRate   = pct(delivered, created);
  const attempt1Pct   = pct(attempt1, delivered);
  const attempt2Pct   = pct(attempt2, delivered);
  const attempt3Pct   = pct(attempt3plus, delivered);
  const undeliveredPct = pct(undelivered, created);

  const dh = Math.floor(avgDeliveryTimeSec / 3600);
  const dm = Math.floor((avgDeliveryTimeSec % 3600) / 60);
  const fh = Math.floor(avgAwbToFirstAttemptSec / 3600);
  const fm = Math.floor((avgAwbToFirstAttemptSec % 3600) / 60);

  return (
    <div className="hero-badge">
      <div className="hero-badge-label">
        <span className="dot" aria-hidden="true" />
        Delivery Performance Overview
      </div>
      <div className="hero-badge-title">All Shipments · {periodLabel}</div>

      <div className="hero-kpis" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        {/* Created */}
        <div className="hero-kpi">
          <div className="hero-kpi-icon" style={{ background: 'rgba(58,123,213,0.18)' }}>
            <svg viewBox="0 0 24 24" style={{ stroke: '#3A7BD5' }} fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="1" y="3" width="15" height="13" rx="1"/>
              <path d="M16 8h4l3 3v5h-7V8z"/>
              <circle cx="5.5" cy="18.5" r="2.5"/>
              <circle cx="18.5" cy="18.5" r="2.5"/>
            </svg>
          </div>
          <div className="hero-kpi-value">{created.toLocaleString()}</div>
          <div className="hero-kpi-label">Created Shipments</div>
          <span className="hero-kpi-badge badge-neu">Total AWBs</span>
        </div>

        {/* Delivered */}
        <div className="hero-kpi">
          <div className="hero-kpi-icon" style={{ background: 'rgba(46,204,138,0.18)' }}>
            <svg viewBox="0 0 24 24" style={{ stroke: 'var(--emerald)' }} fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </div>
          <div className="hero-kpi-value">{delivered.toLocaleString()}</div>
          <div className="hero-kpi-label">Delivered</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', marginTop: '4px' }}>
            <span className="hero-kpi-badge" style={{ background: 'rgba(46,204,138,0.12)', color: 'var(--emerald)' }}>
              {deliveryRate}% success rate
            </span>
            <span className="hero-kpi-badge" style={{ background: 'rgba(231,76,60,0.12)', color: '#E74C3C' }}>
              {undelivered.toLocaleString()} undelivered ({undeliveredPct}%)
            </span>
          </div>
        </div>

        {/* Avg Delivery Time */}
        <div className="hero-kpi">
          <div className="hero-kpi-icon" style={{ background: 'rgba(255,193,7,0.12)' }}>
            <svg viewBox="0 0 24 24" style={{ stroke: '#ffc107' }} fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="12 6 12 12 16 14"/>
            </svg>
          </div>
          <div className="hero-kpi-value">
            {avgDeliveryTimeSec > 0 ? <>{dh}<sup>h {String(dm).padStart(2, '0')}m</sup></> : '—'}
          </div>
          <div className="hero-kpi-label">Avg Delivery Time</div>
          <span className="hero-kpi-badge badge-neu">creation → delivery</span>
        </div>

        {/* Avg AWB to 1st Attempt */}
        <div className="hero-kpi">
          <div className="hero-kpi-icon" style={{ background: 'rgba(0,188,212,0.15)' }}>
            <svg viewBox="0 0 24 24" style={{ stroke: '#00BCD4' }} fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="12 6 12 12 16 14"/>
              <circle cx="12" cy="12" r="3" fill="none"/>
            </svg>
          </div>
          <div className="hero-kpi-value">
            {avgAwbToFirstAttemptSec > 0 ? <>{fh}<sup>h {String(fm).padStart(2, '0')}m</sup></> : '—'}
          </div>
          <div className="hero-kpi-label">Avg AWB → 1st Attempt</div>
          <span className="hero-kpi-badge" style={{ background: 'rgba(0,188,212,0.12)', color: '#00BCD4' }}>creation → 1st attempt</span>
        </div>
      </div>

      {/* Attempt breakdown row */}
      <div className="hero-kpis" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginTop: '12px' }}>
        {[
          { label: '1st Attempt Delivered', count: attempt1, pctVal: attempt1Pct, color: 'var(--emerald)', bg: 'rgba(46,204,138,0.12)' },
          { label: '2nd Attempt Delivered', count: attempt2, pctVal: attempt2Pct, color: '#ffc107',       bg: 'rgba(255,193,7,0.12)' },
          { label: '3rd+ Attempt Delivered', count: attempt3plus, pctVal: attempt3Pct, color: '#E74C3C', bg: 'rgba(231,76,60,0.12)' },
        ].map(({ label, count, pctVal, color, bg }) => (
          <div className="hero-kpi" key={label}>
            <div className="hero-kpi-value">{count.toLocaleString()}</div>
            <div className="hero-kpi-label">{label}</div>
            <span className="hero-kpi-badge" style={{ background: bg, color }}>{pctVal}% of delivered</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DailyBreakdown({ rows, onRowClick }) {
  const [sortCol, setSortCol] = useState('date');
  const [sortDir, setSortDir] = useState('desc');

  function handleSort(col) {
    setSortDir(prev => sortCol === col && prev === 'desc' ? 'asc' : 'desc');
    setSortCol(col);
  }

  const sorted = [...rows].sort((a, b) => {
    const dir = sortDir === 'asc' ? 1 : -1;
    if (sortCol === 'date') return dir * (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    return dir * ((a[sortCol] || 0) - (b[sortCol] || 0));
  });

  function SortIcon({ col }) {
    if (sortCol !== col) return <span className="sort-icon" aria-hidden="true">↕</span>;
    return <span className="sort-icon" aria-hidden="true">{sortDir === 'asc' ? '↑' : '↓'}</span>;
  }

  const cols = [
    { key: 'date',               label: 'Date' },
    { key: 'created',            label: 'Created' },
    { key: 'delivered',          label: 'Delivered' },
    { key: 'undelivered',        label: 'Undelivered' },
    { key: 'deliveryRate',       label: 'Delivery Rate' },
    { key: 'attempt1',           label: '1st Attempt' },
    { key: 'attempt2',           label: '2nd Attempt' },
    { key: 'attempt3plus',       label: '3rd+ Attempt' },
    { key: 'avgDeliveryTimeSec',      label: 'Avg Delivery Time' },
    { key: 'avgAwbToFirstAttemptSec', label: 'Avg AWB → 1st Attempt' },
  ];

  return (
    <>
      <div className="section-header">
        <div>
          <div className="section-title">Daily Breakdown</div>
          <div className="section-sub">Click any row to see full day detail and non-delivery reasons</div>
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {cols.map(c => (
                <th
                  key={c.key}
                  className={sortCol === c.key ? 'sorted' : ''}
                  onClick={() => handleSort(c.key)}
                  style={{ cursor: 'pointer' }}
                >
                  {c.label} <SortIcon col={c.key} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={10} style={{ textAlign: 'center', color: 'var(--text-dim)', padding: '32px' }}>
                  No daily data available
                </td>
              </tr>
            ) : sorted.map((row, i) => {
              const rate = pct(row.delivered, row.created);
              const rateColor = rate >= 80 ? 'var(--emerald)' : rate >= 55 ? '#ffc107' : '#E74C3C';
              return (
                <tr
                  key={row.date + i}
                  onClick={() => onRowClick(row)}
                  style={{ cursor: 'pointer' }}
                  title="Click to see day breakdown"
                >
                  <td style={{ fontWeight: 600, color: '#3A7BD5' }}>
                    {new Date(row.date + 'T00:00:00').toLocaleDateString('en-GB', {
                      weekday: 'short', day: '2-digit', month: 'short',
                    })}
                    <span style={{ fontSize: '10px', marginLeft: '6px', color: 'rgba(216,245,236,0.3)', fontWeight: 400 }}>↗</span>
                  </td>
                  <td className="num-cell">{row.created.toLocaleString()}</td>
                  <td className="num-cell" style={{ color: 'var(--emerald)' }}>{row.delivered.toLocaleString()}</td>
                  <td className="num-cell" style={{ color: row.undelivered > 0 ? '#E74C3C' : 'var(--text-dim)' }}>
                    {row.undelivered.toLocaleString()}
                  </td>
                  <td>
                    <div className="mini-bar-wrap">
                      <div className="mini-bar-track">
                        <div className="mini-bar-fill" style={{ width: `${rate}%`, background: rateColor }} />
                      </div>
                      <span className="mini-bar-pct">{rate}%</span>
                    </div>
                  </td>
                  <td className="num-cell">
                    {row.attempt1.toLocaleString()}
                    <span style={{ color: 'var(--text-dim)', fontSize: '11px', marginLeft: '4px' }}>
                      ({pct(row.attempt1, row.delivered)}%)
                    </span>
                  </td>
                  <td className="num-cell">
                    {row.attempt2.toLocaleString()}
                    <span style={{ color: 'var(--text-dim)', fontSize: '11px', marginLeft: '4px' }}>
                      ({pct(row.attempt2, row.delivered)}%)
                    </span>
                  </td>
                  <td className="num-cell">
                    {row.attempt3plus.toLocaleString()}
                    <span style={{ color: row.attempt3plus > 0 ? '#E74C3C' : 'var(--text-dim)', fontSize: '11px', marginLeft: '4px' }}>
                      ({pct(row.attempt3plus, row.delivered)}%)
                    </span>
                  </td>
                  <td className="num-cell">{fmtTime(row.avgDeliveryTimeSec)}</td>
                  <td className="num-cell" style={{ color: row.avgAwbToFirstAttemptSec > 0 ? '#00BCD4' : 'var(--text-dim)' }}>
                    {fmtTime(row.avgAwbToFirstAttemptSec)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ─── MAIN PAGE ─────────────────────────────────────────────────────────────────
export default function DeliveryPerformance() {
  const now = new Date();
  const [loadState, setLoadState]       = useState('loading');
  const [allShipments, setAllShipments] = useState([]);
  const [selectedMonth, setSelectedMonth] = useState({
    year:  now.getFullYear(),
    month: now.getMonth(),
  });
  const [selectedDay, setSelectedDay]   = useState(null);
  const [isDayModalOpen, setIsDayModalOpen] = useState(false);

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoadState('loading');
    try {
      const snap = await getDocs(
        query(collection(db, 'deliveryShipments'), orderBy('shipmentDate', 'asc'))
      );
      if (snap.empty) { setLoadState('empty'); return; }
      const rows = snap.docs.map(d => {
        const data = d.data();
        return {
          ...data,
          shipmentDate:  data.shipmentDate?.toDate  ? data.shipmentDate.toDate()  : (data.shipmentDate  ? new Date(data.shipmentDate)  : null),
          deliveredDate: data.deliveredDate?.toDate ? data.deliveredDate.toDate() : (data.deliveredDate ? new Date(data.deliveredDate) : null),
        };
      });
      setAllShipments(rows);
      setLoadState('loaded');
    } catch (err) {
      console.error('Delivery load error:', err);
      setLoadState('empty');
    }
  }

  // Available months derived from data
  const availableMonths = useMemo(() => {
    const seen = new Set();
    allShipments.forEach(s => {
      if (s.shipmentDate) {
        const d = s.shipmentDate;
        seen.add(`${d.getFullYear()}-${d.getMonth()}`);
      }
    });
    return Array.from(seen)
      .map(k => { const [y, m] = k.split('-').map(Number); return { year: y, month: m }; })
      .sort((a, b) => b.year - a.year || b.month - a.month);
  }, [allShipments]);

  // Filter to selected month
  const filteredShipments = useMemo(() => {
    const { from, to } = getMonthBounds(selectedMonth.year, selectedMonth.month);
    return allShipments.filter(s => s.shipmentDate && s.shipmentDate >= from && s.shipmentDate <= to);
  }, [allShipments, selectedMonth]);

  // Hero stats
  const stats = useMemo(() => {
    const created       = filteredShipments.length;
    const delivered     = filteredShipments.filter(s => s.status === 'delivered').length;
    const undelivered   = created - delivered;
    const attempt1      = filteredShipments.filter(s => s.status === 'delivered' && s.attempt === 1).length;
    const attempt2      = filteredShipments.filter(s => s.status === 'delivered' && s.attempt === 2).length;
    const attempt3plus  = filteredShipments.filter(s => s.status === 'delivered' && s.attempt >= 3).length;
    const avgDeliveryTimeSec      = Math.round(avg(filteredShipments.filter(s => s.status === 'delivered').map(s => s.deliveryTimeSec)));
    const avgAwbToFirstAttemptSec = Math.round(avg(filteredShipments.map(s => s.awbToFirstAttemptSec).filter(v => v != null)));
    return { created, delivered, undelivered, attempt1, attempt2, attempt3plus, avgDeliveryTimeSec, avgAwbToFirstAttemptSec };
  }, [filteredShipments]);

  // Daily breakdown rows — include raw shipments per day for modal
  const dailyRows = useMemo(() => {
    const byDate = {};
    filteredShipments.forEach(s => {
      if (!s.shipmentDate) return;
      const d = s.shipmentDate;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      if (!byDate[key]) {
        byDate[key] = { date: key, created: 0, delivered: 0, undelivered: 0, attempt1: 0, attempt2: 0, attempt3plus: 0, deliveryTimes: [], firstAttemptTimes: [], shipments: [] };
      }
      const row = byDate[key];
      row.created++;
      row.shipments.push(s);
      if (s.status === 'delivered') {
        row.delivered++;
        if (s.attempt === 1) row.attempt1++;
        else if (s.attempt === 2) row.attempt2++;
        else if (s.attempt >= 3) row.attempt3plus++;
        if (s.deliveryTimeSec > 0) row.deliveryTimes.push(s.deliveryTimeSec);
      } else {
        row.undelivered++;
      }
      if (s.awbToFirstAttemptSec > 0) row.firstAttemptTimes.push(s.awbToFirstAttemptSec);
    });
    return Object.values(byDate).map(r => ({
      ...r,
      deliveryRate:             pct(r.delivered, r.created),
      avgDeliveryTimeSec:       Math.round(avg(r.deliveryTimes)),
      avgAwbToFirstAttemptSec:  Math.round(avg(r.firstAttemptTimes)),
    }));
  }, [filteredShipments]);

  // Month options: always include current + last, plus any from data
  const monthOptions = useMemo(() => {
    const opts = new Map();
    [0, 1].forEach(offset => {
      const d = new Date(now.getFullYear(), now.getMonth() - offset, 1);
      opts.set(`${d.getFullYear()}-${d.getMonth()}`, { year: d.getFullYear(), month: d.getMonth() });
    });
    availableMonths.forEach(({ year, month }) => opts.set(`${year}-${month}`, { year, month }));
    return Array.from(opts.values()).sort((a, b) => b.year - a.year || b.month - a.month);
  }, [availableMonths]);

  function handleDayClick(row) {
    setSelectedDay(row);
    setIsDayModalOpen(true);
  }

  const periodLabel = monthLabel(selectedMonth.year, selectedMonth.month);

  return (
    <>
      <Navbar activeLink="delivery" />
      <div className="page">
        {loadState === 'loading' ? (
          <LoadingState />
        ) : (
          <>
            <div className="page-header">
              <div>
                <h1>Delivery Performance</h1>
                <p>
                  Showing data for: <strong>{periodLabel}</strong>
                  {loadState === 'empty' && (
                    <span style={{ color: 'rgba(216,245,236,0.4)', marginLeft: '8px' }}>
                      (no data — upload via Admin → Delivery Upload)
                    </span>
                  )}
                </p>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '10px' }}>
                <span className="print-generated">
                  <strong>Delivery Performance</strong>
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
                <div className="filter-bar">
                  {monthOptions.map(({ year, month }) => {
                    const active = selectedMonth.year === year && selectedMonth.month === month;
                    return (
                      <button
                        key={`${year}-${month}`}
                        className={`filter-btn${active ? ' active' : ''}`}
                        onClick={() => setSelectedMonth({ year, month })}
                      >
                        {monthLabel(year, month)}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {loadState === 'empty' || filteredShipments.length === 0 ? (
              <EmptyState />
            ) : (
              <>
                <HeroBadge stats={stats} periodLabel={periodLabel} />
                <DailyBreakdown rows={dailyRows} onRowClick={handleDayClick} />
              </>
            )}

            <div className="print-footer">
              <span>Team Performance System</span>
              <span>{periodLabel}</span>
              <span className="print-footer-sig">Automated report developed by Ali Isa Mohsen 36030791</span>
            </div>
          </>
        )}
      </div>

      <DayDetailModal
        isOpen={isDayModalOpen}
        onClose={() => { setIsDayModalOpen(false); setSelectedDay(null); }}
        dayData={selectedDay}
      />
    </>
  );
}
