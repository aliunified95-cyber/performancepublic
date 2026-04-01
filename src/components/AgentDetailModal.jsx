import React, { useEffect, useMemo } from 'react';

// Time buckets for percentile breakdown
const TIME_BUCKETS = [
  { label: '< 15 min', max: 900, color: '#2ECC8A' },        // Green
  { label: '15-30 min', max: 1800, color: '#27AE60' },      // Light green
  { label: '30-60 min', max: 3600, color: '#F39C12' },      // Yellow
  { label: '1-2 hours', max: 7200, color: '#E67E22' },      // Orange
  { label: '2-4 hours', max: 14400, color: '#E74C3C' },     // Red
  { label: '4-8 hours', max: 28800, color: '#C0392B' },     // Dark red
  { label: '8-16 hours', max: 57600, color: '#8E44AD' },    // Purple
  { label: '> 16 hours', max: Infinity, color: '#7B3FA0' }, // Bad handling
];

function fmtTime(sec) {
  if (!sec || isNaN(sec)) return '0h 00m';
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

function fmtTimeShort(sec) {
  if (!sec || isNaN(sec)) return '0m';
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function avg(arr) {
  const v = arr.filter(x => x != null && !isNaN(x) && x >= 0);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}

function median(arr) {
  const v = arr.filter(x => x != null && !isNaN(x) && x >= 0).sort((a, b) => a - b);
  if (!v.length) return 0;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 !== 0 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function percentile(arr, p) {
  const v = arr.filter(x => x != null && !isNaN(x) && x >= 0).sort((a, b) => a - b);
  if (!v.length) return 0;
  const index = Math.ceil((p / 100) * v.length) - 1;
  return v[Math.max(0, index)];
}

function getBucketCounts(timeValues) {
  const validTimes = timeValues.filter(v => v != null && !isNaN(v) && v >= 0);
  if (!validTimes.length) return { buckets: TIME_BUCKETS.map(b => ({ ...b, count: 0, percentage: 0 })), total: 0 };
  
  const buckets = TIME_BUCKETS.map((bucket, idx) => {
    const prevMax = idx === 0 ? 0 : TIME_BUCKETS[idx - 1].max;
    const count = validTimes.filter(v => v > prevMax && v <= bucket.max).length;
    return {
      ...bucket,
      count,
      percentage: Math.round((count / validTimes.length) * 100),
    };
  });
  
  return { buckets, total: validTimes.length };
}

export default function AgentDetailModal({ isOpen, onClose, agent, teamType, timeField }) {
  // Handle ESC key to close modal
  useEffect(() => {
    function handleEsc(e) {
      if (e.key === 'Escape') onClose();
    }
    if (isOpen) {
      document.addEventListener('keydown', handleEsc);
      document.body.style.overflow = 'hidden';
    }
    return () => {
      document.removeEventListener('keydown', handleEsc);
      document.body.style.overflow = '';
    };
  }, [isOpen, onClose]);

  const timeData = useMemo(() => {
    if (!agent || !agent.orders) return null;
    
    // Get the appropriate time values based on the team type
    let timeValues = [];
    let metricLabel = '';
    
    switch (teamType) {
      case 'sales':
        timeValues = agent.orders.map(o => o.claimTimeSec).filter(v => v != null);
        metricLabel = 'Claim Time (Order Creation → First Claim)';
        break;
      case 'logistics':
        if (timeField === 'activationAssignTimeSec') {
          timeValues = agent.orders.map(o => o.activationAssignTimeSec).filter(v => v != null);
          metricLabel = 'Time to Activation (Claim → Activation Assignment)';
        } else {
          timeValues = agent.orders.map(o => o.claimTimeSec).filter(v => v != null);
          metricLabel = 'Claim Time (Assignment → First Claim)';
        }
        break;
      case 'activation':
        if (timeField === 'handleTimeSec') {
          timeValues = agent.orders.map(o => o.handleTimeSec).filter(v => v != null);
          metricLabel = 'Handle Time (Claim → Completion)';
        } else {
          timeValues = agent.orders.map(o => o.claimTimeSec).filter(v => v != null);
          metricLabel = 'Claim Time (Assignment → First Claim)';
        }
        break;
      default:
        timeValues = agent.orders.map(o => o.claimTimeSec).filter(v => v != null);
        metricLabel = 'Claim Time';
    }
    
    const { buckets, total } = getBucketCounts(timeValues);
    const validTimes = timeValues.filter(v => v != null && !isNaN(v) && v >= 0);
    
    return {
      buckets,
      total,
      metricLabel,
      average: avg(validTimes),
      median: median(validTimes),
      p90: percentile(validTimes, 90),
      p95: percentile(validTimes, 95),
      min: validTimes.length ? Math.min(...validTimes) : 0,
      max: validTimes.length ? Math.max(...validTimes) : 0,
    };
  }, [agent, teamType, timeField]);

  if (!isOpen || !agent || !timeData) return null;

  const hasData = timeData.total > 0;

  return (
    <div 
      className="modal-overlay" 
      onClick={(e) => e.target === e.currentTarget && onClose()}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.7)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: '20px',
      }}
    >
      <div 
        className="modal-content"
        style={{
          background: 'linear-gradient(145deg, #1a1a2e 0%, #16213e 100%)',
          borderRadius: '16px',
          border: '1px solid rgba(216, 245, 236, 0.1)',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
          maxWidth: '700px',
          width: '100%',
          maxHeight: '90vh',
          overflow: 'auto',
          animation: 'modalSlideIn 0.3s ease-out',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '24px 24px 16px',
          borderBottom: '1px solid rgba(216, 245, 236, 0.1)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <div 
              className="agent-avatar"
              style={{ 
                background: agent.color,
                width: '56px',
                height: '56px',
                fontSize: '22px',
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: '50%',
                color: '#fff',
              }}
            >
              {agent.initials}
            </div>
            <div>
              <h2 style={{ 
                margin: 0, 
                fontSize: '22px', 
                fontWeight: 600,
                color: 'var(--mint)',
              }}>
                {agent.name}
              </h2>
              <p style={{ 
                margin: '4px 0 0', 
                color: 'var(--text-dim)',
                fontSize: '14px',
              }}>
                {agent.role || `${teamType.charAt(0).toUpperCase() + teamType.slice(1)} Agent`} • {timeData.total.toLocaleString()} orders
              </p>
            </div>
          </div>
          <button 
            onClick={onClose}
            style={{
              background: 'rgba(216, 245, 236, 0.05)',
              border: '1px solid rgba(216, 245, 236, 0.1)',
              borderRadius: '8px',
              width: '36px',
              height: '36px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              color: 'var(--mint)',
              fontSize: '20px',
              transition: 'all 0.2s',
            }}
            onMouseEnter={(e) => {
              e.target.style.background = 'rgba(231, 76, 60, 0.2)';
              e.target.style.borderColor = 'rgba(231, 76, 60, 0.4)';
            }}
            onMouseLeave={(e) => {
              e.target.style.background = 'rgba(216, 245, 236, 0.05)';
              e.target.style.borderColor = 'rgba(216, 245, 236, 0.1)';
            }}
          >
            ×
          </button>
        </div>

        {/* Content */}
        <div style={{ padding: '24px' }}>
          {/* Metric Label */}
          <div style={{
            background: 'rgba(123, 63, 160, 0.15)',
            border: '1px solid rgba(123, 63, 160, 0.3)',
            borderRadius: '8px',
            padding: '12px 16px',
            marginBottom: '20px',
          }}>
            <span style={{ color: 'var(--text-dim)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Showing Distribution For
            </span>
            <div style={{ color: 'var(--mint)', fontSize: '14px', fontWeight: 500, marginTop: '4px' }}>
              {timeData.metricLabel}
            </div>
          </div>

          {/* Statistics Row */}
          {hasData && (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: '12px',
              marginBottom: '24px',
            }}>
              {[
                { label: 'Average', value: fmtTime(timeData.average), color: '#3A7BD5' },
                { label: 'Median', value: fmtTime(timeData.median), color: '#2ECC8A' },
                { label: '90th %ile', value: fmtTime(timeData.p90), color: '#F39C12' },
                { label: '95th %ile', value: fmtTime(timeData.p95), color: '#E67E22' },
              ].map((stat, idx) => (
                <div key={idx} style={{
                  background: 'rgba(216, 245, 236, 0.03)',
                  border: '1px solid rgba(216, 245, 236, 0.08)',
                  borderRadius: '10px',
                  padding: '12px',
                  textAlign: 'center',
                }}>
                  <div style={{ 
                    fontSize: '11px', 
                    color: 'var(--text-dim)', 
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px',
                    marginBottom: '4px',
                  }}>
                    {stat.label}
                  </div>
                  <div style={{ 
                    fontSize: '16px', 
                    fontWeight: 600,
                    color: stat.color,
                  }}>
                    {stat.value}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Distribution Header */}
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '12px',
          }}>
            <h3 style={{ 
              margin: 0, 
              fontSize: '14px', 
              fontWeight: 600,
              color: 'var(--mint)',
            }}>
              Time Distribution
            </h3>
            <span style={{ fontSize: '12px', color: 'var(--text-dim)' }}>
              Click an agent row to view details
            </span>
          </div>

          {/* Distribution Bars */}
          {hasData ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {timeData.buckets.map((bucket, idx) => {
                const prevMax = idx === 0 ? 0 : TIME_BUCKETS[idx - 1].max;
                const isBadHandling = bucket.max === Infinity;
                
                return (
                  <div key={bucket.label} style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                  }}>
                    {/* Label */}
                    <div style={{ 
                      width: '90px', 
                      fontSize: '12px',
                      color: isBadHandling ? '#E74C3C' : 'var(--text-dim)',
                      fontWeight: isBadHandling ? 500 : 400,
                    }}>
                      {bucket.label}
                      {isBadHandling && <span style={{ fontSize: '10px', marginLeft: '4px' }}>(Bad)</span>}
                    </div>
                    
                    {/* Bar Container */}
                    <div style={{ 
                      flex: 1,
                      height: '24px',
                      background: 'rgba(216, 245, 236, 0.05)',
                      borderRadius: '4px',
                      overflow: 'hidden',
                      position: 'relative',
                    }}>
                      {/* Fill */}
                      <div style={{
                        width: `${bucket.percentage}%`,
                        height: '100%',
                        background: bucket.color,
                        borderRadius: '4px',
                        transition: 'width 0.5s ease-out',
                        opacity: bucket.count > 0 ? 1 : 0.3,
                      }} />
                    </div>
                    
                    {/* Stats */}
                    <div style={{
                      width: '100px',
                      textAlign: 'right',
                      fontSize: '12px',
                    }}>
                      <span style={{ 
                        fontWeight: 600,
                        color: bucket.count > 0 ? 'var(--mint)' : 'var(--text-dim)',
                      }}>
                        {bucket.count}
                      </span>
                      <span style={{ 
                        color: 'var(--text-dim)',
                        marginLeft: '6px',
                      }}>
                        ({bucket.percentage}%)
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{
              textAlign: 'center',
              padding: '40px 20px',
              color: 'var(--text-dim)',
            }}>
              <svg 
                viewBox="0 0 24 24" 
                style={{ 
                  width: '48px', 
                  height: '48px', 
                  stroke: 'currentColor',
                  fill: 'none',
                  strokeWidth: 1.5,
                  marginBottom: '12px',
                  opacity: 0.5,
                }}
              >
                <circle cx="12" cy="12" r="10"/>
                <path d="M8 12h8"/>
              </svg>
              <p>No time data available for this agent</p>
            </div>
          )}

          {/* Footer Note */}
          {hasData && (
            <div style={{
              marginTop: '20px',
              padding: '12px 16px',
              background: 'rgba(216, 245, 236, 0.03)',
              borderRadius: '8px',
              fontSize: '12px',
              color: 'var(--text-dim)',
              lineHeight: 1.5,
            }}>
              <strong style={{ color: 'var(--mint)' }}>Note:</strong> This distribution shows the breakdown of {timeData.total.toLocaleString()} orders by processing time. 
              Orders taking longer than 16 hours are classified as "Bad Handling" and excluded from average calculations on the main dashboard.
            </div>
          )}
        </div>
      </div>
      
      <style>{`
        @keyframes modalSlideIn {
          from {
            opacity: 0;
            transform: translateY(-20px) scale(0.95);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
      `}</style>
    </div>
  );
}
