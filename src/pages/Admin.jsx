import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  collection,
  doc,
  addDoc,
  setDoc,
  updateDoc,
  deleteField,
  writeBatch,
  getDocs,
  onSnapshot,
  query,
  orderBy,
  where,
  serverTimestamp,
  Timestamp,
  limit,
  getDoc,
} from 'firebase/firestore';
import { signOut } from 'firebase/auth';
import { db, auth } from '../firebase';
import Navbar from '../components/Navbar';
import DeliveryUploadTab from '../components/DeliveryUploadTab';
import { WORKING_HOURS } from '../utils/sla';

// ─── COLUMN DEFINITIONS ────────────────────────────────────────────────────────
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

const ALL_COLS = [
  'ORDER_CREATION_DATE','ORDER_CREATION_time','HOURS_TYPE','ORDER_CREATION_DATE_TIME1',
  'CHANNEL_ORDER_NO','LOG_USER','CHANNEL','REMEDY_REFERENCE','ID_NO','CONT_CATEGORY',
  'DELIVERY_METHOD','HIR_STATUS','ESHOP_ORDER_STATUS','APPROVED_ORDER_TYPE',
  'DEVICE_STATUS_REASON1','DEVICE_SERVICE1','DEVICE_STATUS_REASON2','DEVICE_SERVICE2',
  'DEVICE_STATUS_REASON3','DEVICE_SERVICE3','PLAN_STATUS_REASON1','NEW_EXISTING_FLAG1',
  'PLAN_PACKAGE1','PLAN_STATUS_REASON2','NEW_EXISTING_FLAG2','PLAN_PACKAGE2',
  'PLAN_STATUS_REASON3','NEW_EXISTING_FLAG3','PLAN_PACKAGE3','ACTION_DATE_TIME',
  'ACTION_DATE','ACTION_TIME','SALESMAN_ID','SALES_GROUP','SALES_CLAIM_DATE_FIRST',
  'SALES_CLAIM_TIME_FIRST','SALES_USER_FIRST','SALES_CLAIM_DATE_LAST',
  'SALES_CLAIM_TIME_LAST','SALES_USER_LAST','SALES_DUR_CLM_ASSIGN',
  'SALES_DUR_CREATION_CLAIM','SALES_DUR_ACTION_ASSIGN','SALES_DUR_CREATION_ASSIGN',
  'LOGISTICS_ASSIGN_DATE_1','LOGISTICS_ASSIGN_TIME_1','LOGISTICS_ASSIGN_DATE',
  'LOGISTICS_ASSIGN_TIME','LOGISTICS_GROUP','LOGISTICS_CLAIM_DATE_FIRST',
  'LOGISTICS_CLAIM_TIME_FIRST','LOGISTICS_USER_FIRST','LOGISTICS_CLAIM_DATE_LAST',
  'LOGISTICS_CLAIM_TIME_LAST','LOGISTICS_USER_LAST','LOGISTICS_LOGGED_DEVICE1',
  'LOGISTICS_LOGGED_DEVICE2','LOGISTICS_LOGGED_DEVICE3','LOGISTICS_LOGGED_PLAN1',
  'LOGISTICS_LOGGED_PLAN2','LOGISTICS_LOGGED_PLAN3','LOGISTICS_DUR_CLM_ASSIGN',
  'LOGISTICS_DUR_ASSIGN_ASSING','DELIVERY_ASSIGN_DATE','DELIVERY_ASSIGN_TIME',
  'DELIVERY_GROUP','DELIVERY_USER','DELIVERY_ASSIGN_DATE_LAST','DELIVERY_ASSIGN_TIME_LAST',
  'DELIVERY_USER_LAST','DELIVERY_TIME','DELIVERY_STATUS','DELIVERY_DUR_ASSIGN_ASSIGN',
  'DUR_ASSIGN_LOGIST_ASSIGN_ACT','ACTIVATION_ASSIGN_DATE','ACTIVATION_ASSIGN_TIME',
  'ACTIVATION_GROUP','ACTIVATION_CLAIM_DATE','ACTIVATION_CLAIM_TIME','ACTIVATION_USER',
  'TABS_ACTION_DATETIME_ID','TABS_ACTION_USER_ID','TABS_ACTION_DATETIME_SERIAL',
  'TABS_ACTION_USER_SERIAL','TABS_DEVICE_DETAILS','TABS_PLAN_DETAILS','COMPLETE_DATE',
  'COMPLETE_TIME','COMPLETE_USER','ACTIVATION_DUR_CLM_TABS','ACTIVATION_DUR_CLM_COMPLETE',
  'ACTIVATION_DUR_ASSIGN_TABS','ACTIVATION_DUR_ASSIGN_COMPLETE','DUR_CREATE_TABS',
  'DUR_CREATE_COMPLETE','ORDER_HANDLER_GROUP','ORDER_HANDLER','CRM_ORDER_STATUS',
  'REJECTION_REASON','REJECTION_CATEGORY','DRIVER_NOTE','DELIVERY_SLOT',
  'Delivery_Accuracy','COUPON_CODES','cust_address','AUTH_CODE','PAYMENT_METHOD','AMOUNT_RECEIVED',
];

// ─── CSV PARSER ────────────────────────────────────────────────────────────────
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

// ─── DATE/TIME HELPERS ─────────────────────────────────────────────────────────
function parseDateTime(dateStr, timeStr) {
  if (!dateStr) return null;
  dateStr = dateStr.trim();
  timeStr = (timeStr || '').trim();

  // If dateStr contains a space, it may be a combined "date time" value (e.g. "3/29/2026 1:47 PM")
  const spaceIdx = dateStr.indexOf(' ');
  if (spaceIdx > 0) {
    if (!timeStr) timeStr = dateStr.slice(spaceIdx + 1).trim();
    dateStr = dateStr.slice(0, spaceIdx);
  }

  // Convert 12-hour AM/PM to 24-hour
  const ampmMatch = timeStr.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])$/);
  if (ampmMatch) {
    let h = parseInt(ampmMatch[1], 10);
    const m = ampmMatch[2], s = ampmMatch[3] || '00', ampm = ampmMatch[4].toUpperCase();
    if (ampm === 'AM' && h === 12) h = 0;
    if (ampm === 'PM' && h !== 12) h += 12;
    timeStr = `${String(h).padStart(2, '0')}:${m}:${s}`;
  }

  // Normalize HH:MM (no seconds) to HH:MM:SS
  if (/^\d{1,2}:\d{2}$/.test(timeStr)) timeStr += ':00';

  let d = new Date(`${dateStr}T${timeStr || '00:00:00'}`);
  if (!isNaN(d)) return d;

  // Handle DD-Mon-YYYY or Mon-DD-YYYY (e.g. "29-Mar-2026", "29-MAR-26")
  const MON = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
  const monMatch = dateStr.match(/^(\d{1,2})[\/\-\s]([A-Za-z]{3,})[\/\-\s](\d{2,4})$/);
  if (monMatch) {
    const monNum = MON[monMatch[2].slice(0,3).toLowerCase()];
    if (monNum) {
      const day = parseInt(monMatch[1], 10);
      const yr  = parseInt(monMatch[3], 10);
      const iso = `${yr < 100 ? 2000 + yr : yr}-${String(monNum).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
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
      if (a > 31)      iso = `${a}-${String(b).padStart(2,'0')}-${String(c).padStart(2,'0')}`;      // YYYY/MM/DD
      else if (a > 12) iso = `${c < 100 ? 2000+c : c}-${String(b).padStart(2,'0')}-${String(a).padStart(2,'0')}`;  // DD/MM/YYYY
      else             iso = `${c < 100 ? 2000+c : c}-${String(a).padStart(2,'0')}-${String(b).padStart(2,'0')}`;  // MM/DD/YYYY
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

// ─── SALES EFFECTIVE START TIME ───────────────────────────────────────────────
// Rule: if HOURS_TYPE is non-working, the SLA clock starts at 09:00 AM the
// NEXT calendar day (sales working hours: 09:00 – 22:00).
// If HOURS_TYPE is working, the clock starts at the actual order creation time.
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

// ─── EFFECTIVE START TIME FOR LOGISTICS/ACTIVATION ────────────────────────────
// Rule: If assigned outside working hours, the SLA clock starts at 09:00 AM
// on the next working day. If within working hours, clock starts at actual time.
// Example: Assigned at 10 PM, claimed at 11 AM next day = 2 hours (11 AM - 9 AM)
function getEffectiveStartTime(assignDT, department) {
  if (!assignDT) return null;
  
  const config = WORKING_HOURS[department];
  if (!config) return assignDT;
  
  const hour = assignDT.getHours();
  
  // If before working hours (e.g., 8 AM), start from 9 AM same day
  if (hour < config.start) {
    const sameDay9AM = new Date(assignDT);
    sameDay9AM.setHours(config.start, 0, 0, 0);
    return sameDay9AM;
  }
  
  // If after working hours (e.g., 10 PM), start from 9 AM next day
  if (hour >= config.end) {
    const nextDay9AM = new Date(assignDT);
    nextDay9AM.setDate(nextDay9AM.getDate() + 1);
    nextDay9AM.setHours(config.start, 0, 0, 0);
    return nextDay9AM;
  }
  
  // Within working hours, use actual time
  return assignDT;
}

function fmtTime(sec) {
  if (sec == null || isNaN(sec)) return '—';
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

// ─── ROW PROCESSOR ────────────────────────────────────────────────────────────
function getRowAgentName(row) {
  return (row['SALESMAN_ID'] || row['SALES_USER_FIRST'] || row['LOGISTICS_USER_FIRST'] || row['LOGISTICS_USER_LAST'] || row['DELIVERY_USER'] || row['ACTIVATION_USER'] || '').trim();
}

// Extract ALL agents from a row with their default types from the report
function extractAllAgentsFromRow(row) {
  const agents = [];
  
  // Sales agents
  const salesAgent = (row['SALES_USER_FIRST'] || row['SALESMAN_ID'] || '').trim();
  if (salesAgent) {
    agents.push({ agentCode: salesAgent, agentType: 'sales' });
  }
  
  // Logistics agents
  const logisticsAgent = (row['LOGISTICS_USER_FIRST'] || row['LOGISTICS_USER_LAST'] || '').trim();
  if (logisticsAgent) {
    agents.push({ agentCode: logisticsAgent, agentType: 'logistics' });
  }
  
  // Activation agents
  const activationAgent = (row['ACTIVATION_USER'] || '').trim();
  if (activationAgent) {
    agents.push({ agentCode: activationAgent, agentType: 'activation' });
  }
  
  // Delivery agents
  const deliveryAgent = (row['DELIVERY_USER'] || '').trim();
  if (deliveryAgent) {
    agents.push({ agentCode: deliveryAgent, agentType: 'logistics' });
  }
  
  return agents;
}

function processRows(rows) {
  const agentMap = {};

  rows.forEach(row => {
    const agent = getRowAgentName(row);
    if (!agent) return;

    if (!agentMap[agent]) agentMap[agent] = { name: agent, orders: [] };

    const orderDT   = parseDateTime(row['ORDER_CREATION_DATE_TIME1'] || row['ORDER_CREATION_DATE'], row['ORDER_CREATION_time']);
    const claimDT   = parseDateTime(row['SALES_CLAIM_DATE_FIRST'], row['SALES_CLAIM_TIME_FIRST']);
    const assignDT  = parseDateTime(row['LOGISTICS_ASSIGN_DATE_1'], row['LOGISTICS_ASSIGN_TIME_1']);

    const claimed       = !!claimDT;
    const claimTimeSec  = diffSeconds(orderDT, claimDT);
    const assignTimeSec = diffSeconds(claimDT, assignDT);

    agentMap[agent].orders.push({
      orderNo:      row['CHANNEL_ORDER_NO'] || '',
      channel:      row['CHANNEL'] || '',
      status:       row['ESHOP_ORDER_STATUS'] || '',
      hoursType:    row['HOURS_TYPE'] || '',
      claimed,
      claimTimeSec,
      assignTimeSec,
      orderDT,
    });
  });

  return Object.values(agentMap).map(a => {
    const claimTimes  = a.orders.map(o => o.claimTimeSec).filter(v => v != null && v >= 0 && v < 86400);
    const assignTimes = a.orders.map(o => o.assignTimeSec).filter(v => v != null && v >= 0 && v < 86400);
    return {
      name:          a.name,
      role:          a.name,
      initials:      a.name.split(/\s+/).map(p => p[0]).join('').slice(0, 2).toUpperCase(),
      total:         a.orders.length,
      claimed:       a.orders.filter(o => o.claimed).length,
      claimTimeSec:  Math.round(avgArr(claimTimes)  ?? 0),
      assignTimeSec: Math.round(avgArr(assignTimes) ?? 0),
    };
  }).sort((a, b) => b.total - a.total);
}

function computeSummary(agents, rows) {
  const totalOrders  = rows.length;
  const totalClaimed = agents.reduce((s, a) => s + a.claimed, 0);
  const avgClaim     = Math.round(avgArr(agents.map(a => a.claimTimeSec).filter(v => v > 0)) ?? 0);
  const avgAssign    = Math.round(avgArr(agents.map(a => a.assignTimeSec).filter(v => v > 0)) ?? 0);

  const dates = rows
    .map(r => parseDateTime(r['ORDER_CREATION_DATE'], r['ORDER_CREATION_time']))
    .filter(Boolean)
    .sort((a, b) => a - b);

  const dateFrom = dates[0]     ? dates[0].toLocaleDateString()     : '—';
  const dateTo   = dates.at(-1) ? dates.at(-1).toLocaleDateString() : '—';

  // Count agents by type
  const salesAgents = agents.filter(a => a.agentType === 'sales' || !a.agentType).length;
  const logisticsAgents = agents.filter(a => a.agentType === 'logistics').length;
  const activationAgents = agents.filter(a => a.agentType === 'activation').length;

  return { 
    totalOrders, 
    totalClaimed, 
    avgClaimTimeSec: avgClaim, 
    avgAssignTimeSec: avgAssign, 
    dateFrom, 
    dateTo,
    salesAgents,
    logisticsAgents,
    activationAgents
  };
}

// ─── SUB-COMPONENTS ────────────────────────────────────────────────────────────

function StepsBar({ step }) {
  const steps = [
    { label: 'Upload',   sub: 'Select CSV file' },
    { label: 'Validate', sub: 'Check columns' },
    { label: 'Preview',  sub: 'Review data' },
    { label: 'Import',   sub: 'Save & apply' },
  ];

  return (
    <div className="steps-bar">
      {steps.map((s, i) => {
        const n = i + 1;
        let cls = '';
        if (n < step)  cls = 'done';
        if (n === step) cls = 'active';

        return (
          <React.Fragment key={n}>
            <div className={`step${cls ? ' ' + cls : ''}`}>
              <div className="step-circle">
                {n < step ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                ) : n}
              </div>
              <div className="step-info">
                <div className="step-label">{s.label}</div>
                <div className="step-sub">{s.sub}</div>
              </div>
            </div>
            {i < steps.length - 1 && <div className="step-line" />}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function UploadCard({ onFile, file, fileName, fileMeta, onRemove, progress }) {
  const [dragOver, setDragOver] = useState(false);

  function handleDrop(e) {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) onFile(f);
  }

  return (
    <div className="upload-card">
      {!file ? (
        <div
          className={`drop-zone${dragOver ? ' drag-over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          <input
            type="file"
            accept=".csv,.tsv,.txt"
            onChange={(e) => { if (e.target.files[0]) onFile(e.target.files[0]); }}
          />
          <div className="drop-icon">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
          </div>
          <div className="drop-title">Drop your CSV file here</div>
          <div className="drop-sub">or <strong>click to browse</strong> your files</div>
          <div className="drop-formats">
            <span className="fmt-tag">CSV</span>
            <span className="fmt-tag">TSV</span>
            <span className="fmt-tag">TXT</span>
          </div>
        </div>
      ) : (
        <>
          <div className="file-strip">
            <div className="file-strip-icon">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
              </svg>
            </div>
            <div className="file-strip-info">
              <div className="file-strip-name">{fileName}</div>
              <div className="file-strip-meta">{fileMeta}</div>
            </div>
            <button
              className="file-strip-remove"
              onClick={onRemove}
              title="Remove file"
              aria-label="Remove file"
            >
              ×
            </button>
          </div>
          {progress.show && (
            <div className="progress-wrap">
              <div className="progress-label">{progress.label}</div>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${progress.pct}%` }} />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ValidationSection({ headers, parsedRows }) {
  const headerSet = new Set(headers.map(h => h.trim()));
  const found   = ACTIVE_COLS.filter(c => headerSet.has(c));
  const missing = ACTIVE_COLS.filter(c => !headerSet.has(c));
  const extra   = ALL_COLS.filter(c => !ACTIVE_COLS.includes(c) && headerSet.has(c));

  return (
    <div className="section-card" style={{ marginBottom: '24px' }}>
      <div className="section-card-head">
        <div>
          <div className="section-card-title">Column Validation</div>
          <div className="section-card-sub">Checking for required columns in the uploaded file</div>
        </div>
        <div className="validation-summary">
          <span className="val-chip val-chip-ok">✓ {found.length} found</span>
          {missing.length > 0 && (
            <span className="val-chip val-chip-err">✗ {missing.length} missing</span>
          )}
          {extra.length > 0 && (
            <span className="val-chip val-chip-warn">◌ {extra.length} extra cols</span>
          )}
        </div>
      </div>
      <div className="col-grid">
        {ACTIVE_COLS.map(c => {
          const ok = headerSet.has(c);
          return (
            <div key={c} className={`col-item ${ok ? 'found' : 'missing'}`}>
              <span className="col-item-icon">{ok ? '✓' : '✗'}</span>
              <span className="col-item-name">{c}</span>
              <span className="col-item-status">{ok ? 'Active' : 'Missing'}</span>
            </div>
          );
        })}
        {extra.slice(0, 6).map(c => (
          <div key={c} className="col-item future">
            <span className="col-item-icon">◌</span>
            <span className="col-item-name">{c}</span>
            <span className="col-item-status">Extra</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PreviewSection({ rows, headers, total }) {
  const headerSet = new Set(headers);
  const cols    = ACTIVE_COLS.filter(c => headerSet.has(c));
  const preview = rows.slice(0, 10);

  return (
    <div className="section-card" style={{ marginBottom: '24px' }}>
      <div className="section-card-head">
        <div>
          <div className="section-card-title">Data Preview</div>
          <div className="section-card-sub">
            Showing {preview.length} of {total.toLocaleString()} rows · {cols.length} active columns
          </div>
        </div>
      </div>
      <div className="preview-table-wrap">
        <table className="preview-table">
          <thead>
            <tr>
              {cols.map(c => (
                <th key={c} title={c}>{c.replace(/_/g, ' ')}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.map((row, i) => (
              <tr key={i}>
                {cols.map(c => (
                  <td key={c} title={row[c] || ''}>
                    {row[c] || <span style={{ opacity: 0.3 }}>—</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {total > 10 && (
          <div className="preview-more">
            + {(total - 10).toLocaleString()} more rows not shown
          </div>
        )}
      </div>
    </div>
  );
}

function ImportBar({ rowCount, onImport, importing, progress }) {
  return (
    <div className="import-bar">
      <div className="import-info">
        <div className="import-info-title">
          {importing ? 'Importing…' : 'Ready to import'}
        </div>
        <div className="import-info-sub">
          {importing
            ? progress.label
            : `${rowCount.toLocaleString()} rows will be saved to Firestore and applied to all dashboards.`}
        </div>
        {importing && (
          <div className="progress-wrap" style={{ marginTop: '10px' }}>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${progress.pct}%` }} />
            </div>
          </div>
        )}
      </div>
      <button
        className="btn btn-primary"
        onClick={onImport}
        disabled={importing}
        style={{ padding: '12px 28px', whiteSpace: 'nowrap' }}
      >
        {importing ? (
          <>
            <div style={{
              width: 16, height: 16,
              border: '2px solid rgba(255,255,255,0.3)',
              borderTopColor: '#fff',
              borderRadius: '50%',
              animation: 'spin 0.7s linear infinite',
            }} aria-hidden="true" />
            Importing…
          </>
        ) : (
          <>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Import Data
          </>
        )}
      </button>
    </div>
  );
}

function SuccessSection({ result, onNewImport }) {
  const s = result.summary;
  const agentBreakdown = s.salesAgents || s.logisticsAgents || s.activationAgents
    ? `${s.salesAgents || 0} sales · ${s.logisticsAgents || 0} logistics · ${s.activationAgents || 0} activation`
    : `${result.agents} agents`;
  
  // Check if this is a large file result with per-collection counts
  const isLargeFile = result.isLargeFile;
  const hasCollectionCounts = result.salesCount !== undefined;
  const uniqueCount = result.uniqueOrderCount ?? result.rowCount;
  
  const kpis = [
    { val: uniqueCount.toLocaleString(), lbl: 'Unique Orders' },
    { val: result.rowCount.toLocaleString(), lbl: 'Total Rows Processed' },
    ...(hasCollectionCounts ? [
      { val: result.salesCount?.toLocaleString() || '0', lbl: 'Sales Orders Saved' },
      { val: result.logisticsCount?.toLocaleString() || '0', lbl: 'Logistics Orders Saved' },
      { val: result.activationCount?.toLocaleString() || '0', lbl: 'Activation Orders Saved' },
    ] : []),
    { val: s.totalClaimed.toLocaleString(),      lbl: 'Claimed Orders' },
    { val: result.agents,                        lbl: 'Unique Agents' },
    { val: fmtTime(s.avgClaimTimeSec),           lbl: 'Avg Claim Time' },
    { val: fmtTime(s.avgAssignTimeSec),          lbl: 'Avg Assignment Time' },
    { val: s.dateFrom,                           lbl: 'Data From' },
  ];

  return (
    <div className="success-banner">
      <div className="success-banner-head">
        <div className="success-banner-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </div>
        <div>
          <div className="success-banner-title">Import Successful</div>
          <div className="success-banner-sub">
            {result.filename} · {result.rowCount.toLocaleString()} rows {result.isLargeFile ? '(Large File)' : ''} · {agentBreakdown} · {s.dateFrom} – {s.dateTo}
          </div>
        </div>
      </div>
      <div className="success-kpis">
        {kpis.map((k, i) => (
          <div key={i} className="success-kpi">
            <div className="success-kpi-val">{k.val}</div>
            <div className="success-kpi-lbl">{k.lbl}</div>
          </div>
        ))}
      </div>
      <div className="success-actions">
        <a href="/performance" className="btn-outline">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="12" width="4" height="9" rx="1"/>
            <rect x="10" y="7" width="4" height="14" rx="1"/>
            <rect x="17" y="3" width="4" height="18" rx="1"/>
          </svg>
          View Sales Performance
        </a>
        <button className="btn-outline" onClick={onNewImport}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          Import Another File
        </button>
      </div>
    </div>
  );
}

function AgentMappingsSection({ mappings, parsedAgents, loading, loadError, onRetry, newAgentCode, newDisplayName, newAgentType, newAgentError, onNewAgentCode, onNewDisplayName, onNewAgentType, onAdd, onUpdate, onBulkUpdate }) {
  const [search, setSearch]         = useState('');
  const [localNames, setLocalNames] = useState({});
  const [localEmails, setLocalEmails] = useState({});
  const [savedRows, setSavedRows]   = useState({});
  const [filterType, setFilterType] = useState('all');

  const combined = useMemo(() => {
    const map = {};
    (parsedAgents || []).forEach(agent => {
      map[agent.agentCode] = { ...agent, displayName: agent.displayName || '', visible: agent.visible !== false, agentType: agent.agentType || 'sales', source: 'report' };
    });
    (mappings || []).forEach(mapping => {
      if (!mapping || !mapping.agentCode) return;
      const inReport = !!map[mapping.agentCode];
      map[mapping.agentCode] = {
        ...map[mapping.agentCode],
        agentCode:   mapping.agentCode,
        displayName: mapping.displayName || '',
        visible:     mapping.visible !== false,
        agentType:   mapping.agentType || 'sales',
        email:       mapping.email || '',
        source:      inReport ? 'report' : 'saved',
      };
    });
    return Object.values(map).sort((a, b) => a.agentCode.localeCompare(b.agentCode));
  }, [mappings, parsedAgents]);

  // Seed localNames/localEmails for new agents without overwriting in-progress edits
  useEffect(() => {
    setLocalNames(prev => {
      const next = { ...prev };
      combined.forEach(m => { if (!(m.agentCode in next)) next[m.agentCode] = m.displayName; });
      return next;
    });
    setLocalEmails(prev => {
      const next = { ...prev };
      combined.forEach(m => { if (!(m.agentCode in next)) next[m.agentCode] = m.email || ''; });
      return next;
    });
  }, [combined]);

  const filtered = useMemo(() => {
    let result = combined;
    if (filterType !== 'all') {
      result = result.filter(m => (m.agentType || 'sales') === filterType);
    }
    if (!search.trim()) return result;
    const q = search.toLowerCase();
    return result.filter(m =>
      m.agentCode.toLowerCase().includes(q) ||
      (localNames[m.agentCode] || m.displayName || '').toLowerCase().includes(q)
    );
  }, [combined, search, localNames, filterType]);

  const totalVisible = combined.filter(m => m.visible !== false).length;
  const totalHidden  = combined.length - totalVisible;
  const totalSales   = combined.filter(m => (m.agentType || 'sales') === 'sales').length;
  const totalActivation = combined.filter(m => (m.agentType || 'sales') === 'activation').length;
  const totalLogistics = combined.filter(m => (m.agentType || 'sales') === 'logistics').length;

  function flashSaved(code) {
    setSavedRows(prev => ({ ...prev, [code]: true }));
    setTimeout(() => setSavedRows(prev => { const n = { ...prev }; delete n[code]; return n; }), 2000);
  }

  function handleNameBlur(mapping) {
    const newVal = (localNames[mapping.agentCode] ?? mapping.displayName).trim();
    if (newVal !== mapping.displayName) {
      onUpdate(mapping, 'displayName', newVal);
      flashSaved(mapping.agentCode);
    }
  }

  function handleEmailBlur(mapping) {
    const newVal = (localEmails[mapping.agentCode] ?? mapping.email ?? '').trim();
    if (newVal !== (mapping.email || '')) {
      onUpdate(mapping, 'email', newVal);
      flashSaved(mapping.agentCode);
    }
  }

  function handleToggle(mapping, checked) {
    onUpdate(mapping, 'visible', checked);
    flashSaved(mapping.agentCode);
  }

  function handleTypeChange(mapping, newType) {
    onUpdate(mapping, 'agentType', newType);
    flashSaved(mapping.agentCode);
  }

  function handleShowAll() {
    const items = combined
      .filter(m => m.visible === false)
      .map(m => ({ agentCode: m.agentCode, displayName: localNames[m.agentCode] ?? m.displayName, visible: true, agentType: m.agentType || 'sales' }));
    if (items.length) onBulkUpdate(items);
  }

  function handleHideAll() {
    const items = combined
      .filter(m => m.visible !== false)
      .map(m => ({ agentCode: m.agentCode, displayName: localNames[m.agentCode] ?? m.displayName, visible: false, agentType: m.agentType || 'sales' }));
    if (items.length) onBulkUpdate(items);
  }

  return (
    <div className="section-card">
      {/* Header */}
      <div className="section-card-head">
        <div>
          <div className="section-card-title">Agent Mappings</div>
          <div className="section-card-sub">Agents are auto-loaded from the parsed report. Set display names, agent type (Sales/Activation), and choose which appear on dashboards.</div>
        </div>
        {combined.length > 0 && (
          <div className="mapping-stats">
            <span className="mapping-stat"><span className="mapping-stat-val">{combined.length}</span> total</span>
            <span className="mapping-stat-sep" />
            <span className="mapping-stat mapping-stat-on"><span className="mapping-stat-val">{totalVisible}</span> visible</span>
            <span className="mapping-stat-sep" />
            <span className="mapping-stat mapping-stat-off"><span className="mapping-stat-val">{totalHidden}</span> hidden</span>
            <span className="mapping-stat-sep" />
            <span className="mapping-stat"><span className="mapping-stat-val">{totalSales}</span> sales</span>
            <span className="mapping-stat-sep" />
            <span className="mapping-stat"><span className="mapping-stat-val">{totalActivation}</span> activation</span>
            <span className="mapping-stat-sep" />
            <span className="mapping-stat"><span className="mapping-stat-val">{totalLogistics}</span> logistics</span>
          </div>
        )}
      </div>

      {/* Add agent form */}
      <div className="mapping-add-form">
        <div className="mapping-add-label">Add agent manually</div>
        <div className="mapping-add-row">
          <div className="mapping-add-field">
            <label>Agent code</label>
            <input
              type="text"
              placeholder="e.g. BF01711"
              value={newAgentCode}
              onChange={(e) => onNewAgentCode(e.target.value)}
            />
          </div>
          <div className="mapping-add-field">
            <label>Display name</label>
            <input
              type="text"
              placeholder="e.g. John Smith"
              value={newDisplayName}
              onChange={(e) => onNewDisplayName(e.target.value)}
            />
          </div>
          <div className="mapping-add-field" style={{ minWidth: '120px' }}>
            <label>Agent type</label>
            <select
              value={newAgentType}
              onChange={(e) => onNewAgentType(e.target.value)}
              style={{
                width: '100%',
                background: 'rgba(216, 245, 236, 0.05)',
                border: '1px solid rgba(216, 245, 236, 0.13)',
                borderRadius: '8px',
                padding: '9px 12px',
                fontSize: '13px',
                color: 'var(--mint)',
                outline: 'none',
                fontFamily: 'inherit',
                cursor: 'pointer',
              }}
            >
              <option value="sales">Sales</option>
              <option value="activation">Activation</option>
              <option value="logistics">Logistics</option>
            </select>
          </div>
          <button className="btn btn-primary mapping-add-btn" onClick={onAdd}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            Add
          </button>
        </div>
        {newAgentError && <div className="form-error">{newAgentError}</div>}
      </div>

      <div className="mapping-divider" />

      {/* Toolbar */}
      <div className="mapping-toolbar">
        <div className="mapping-search-wrap">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="8"/>
            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            type="text"
            className="mapping-search"
            placeholder="Search agents…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            style={{
              background: 'rgba(216, 245, 236, 0.05)',
              border: '1px solid rgba(216, 245, 236, 0.13)',
              borderRadius: '8px',
              padding: '7px 12px',
              fontSize: '13px',
              color: 'var(--mint)',
              outline: 'none',
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            <option value="all">All Types</option>
            <option value="sales">Sales Only</option>
            <option value="activation">Activation Only</option>
            <option value="logistics">Logistics Only</option>
          </select>
          <div className="mapping-bulk-btns">
            <button className="btn-ghost" onClick={handleShowAll}>Show all</button>
            <button className="btn-ghost" onClick={handleHideAll}>Hide all</button>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="loading-state" style={{ minHeight: 'unset', padding: '32px 0' }}>
          <div className="spinner-sm" aria-hidden="true" />
          <p>Loading mappings…</p>
        </div>
      ) : loadError ? (
        <div className="mapping-load-error">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <div>
            <div className="mapping-load-error-msg">{loadError}</div>
            <button className="mapping-retry-btn" onClick={onRetry}>Retry</button>
          </div>
        </div>
      ) : (
        <div className="mapping-table-wrap">
          <table className="mapping-table">
            <thead>
              <tr>
                <th>Agent code</th>
                <th>Display name</th>
                <th>Email</th>
                <th>Type</th>
                <th>Source</th>
                <th>Show on dashboard</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: '32px', color: 'var(--text-dim)' }}>
                    {search ? 'No agents match your search.' : 'No agent codes found. Import a CSV to auto-populate agents.'}
                  </td>
                </tr>
              ) : filtered.map(mapping => (
                <tr key={mapping.agentCode} className={savedRows[mapping.agentCode] ? 'mapping-row-saved' : ''}>
                  <td><span className="mapping-code">{mapping.agentCode}</span></td>
                  <td>
                    <input
                      className="mapping-name-input"
                      type="text"
                      value={localNames[mapping.agentCode] ?? mapping.displayName}
                      placeholder="Enter display name…"
                      onChange={(e) => setLocalNames(prev => ({ ...prev, [mapping.agentCode]: e.target.value }))}
                      onBlur={() => handleNameBlur(mapping)}
                    />
                  </td>
                  <td>
                    <input
                      className="mapping-name-input"
                      type="email"
                      value={localEmails[mapping.agentCode] ?? mapping.email ?? ''}
                      placeholder="agent@email.com"
                      onChange={(e) => setLocalEmails(prev => ({ ...prev, [mapping.agentCode]: e.target.value }))}
                      onBlur={() => handleEmailBlur(mapping)}
                    />
                  </td>
                  <td>
                    <select
                      value={mapping.agentType || 'sales'}
                      onChange={(e) => handleTypeChange(mapping, e.target.value)}
                      style={{
                        background: 'rgba(216, 245, 236, 0.05)',
                        border: '1px solid rgba(216, 245, 236, 0.13)',
                        borderRadius: '6px',
                        padding: '5px 8px',
                        fontSize: '12px',
                        color: 'var(--mint)',
                        outline: 'none',
                        fontFamily: 'inherit',
                        cursor: 'pointer',
                      }}
                    >
                      <option value="sales">Sales</option>
                      <option value="activation">Activation</option>
                      <option value="logistics">Logistics</option>
                    </select>
                  </td>
                  <td>
                    <span className={`source-badge source-${mapping.source}`}>
                      {mapping.source === 'report' ? 'Report' : 'Manual'}
                    </span>
                  </td>
                  <td>
                    <div className="mapping-toggle-cell">
                      <label className="toggle-switch">
                        <input
                          type="checkbox"
                          checked={mapping.visible !== false}
                          onChange={(e) => handleToggle(mapping, e.target.checked)}
                        />
                        <span className="toggle-slider" />
                      </label>
                      {savedRows[mapping.agentCode] && (
                        <span className="mapping-saved-chip">Saved</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length > 0 && (
            <div className="mapping-table-footer">
              Showing {filtered.length} of {combined.length} {combined.length === 1 ? 'agent' : 'agents'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function HistorySection({ history }) {
  return (
    <div className="section-card">
      <div className="section-card-head">
        <div>
          <div className="section-card-title">Import History</div>
          <div className="section-card-sub">Previous data imports</div>
        </div>
      </div>
      <div className="history-list">
        {history.length === 0 ? (
          <div className="empty-state">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            No imports yet — upload a CSV to get started
          </div>
        ) : (
          history.map((item, i) => {
            const ts = item.importedAt?.toDate ? item.importedAt.toDate() : new Date(item.importedAt);
            const dateStr = isNaN(ts) ? '—' : ts.toLocaleString();
            return (
              <div key={item.id || i} className="history-item">
                <div className="history-icon">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                  </svg>
                </div>
                <div className="history-info">
                  <div className="history-name">{item.filename || 'Unknown file'}</div>
                  <div className="history-meta">
                    {dateStr} · {(item.rowCount || 0).toLocaleString()} rows · {item.agentCount || 0} agents
                  </div>
                </div>
                <span className="history-badge">{(item.rowCount || 0).toLocaleString()} rows</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function DangerZone({ onClearData, clearing, clearProgress }) {
  const [confirming, setConfirming] = useState(false);

  if (clearing) {
    return (
      <div className="danger-zone">
        <div className="danger-zone-head">
          <div className="danger-zone-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          </div>
          <div>
            <div className="danger-zone-title">Clearing data…</div>
            <div className="danger-zone-sub">{clearProgress.label}</div>
          </div>
        </div>
        <div className="progress-wrap" style={{ marginTop: '16px' }}>
          <div className="progress-track">
            <div className="progress-fill danger-fill" style={{ width: `${clearProgress.pct}%` }} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="danger-zone">
      <div className="danger-zone-head">
        <div className="danger-zone-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
        </div>
        <div>
          <div className="danger-zone-title">Danger Zone</div>
          <div className="danger-zone-sub">These actions permanently delete data and cannot be undone.</div>
        </div>
      </div>

      <div className="danger-action">
        <div className="danger-action-info">
          <div className="danger-action-name">Clear all imported data</div>
          <div className="danger-action-desc">
            Deletes every import and its order records from Firestore.
            Agent mappings are kept. Dashboards will revert to demo mode.
          </div>
        </div>
        {!confirming ? (
          <button className="btn-danger" onClick={() => setConfirming(true)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>
              <path d="M9 6V4h6v2"/>
            </svg>
            Clear data
          </button>
        ) : (
          <div className="danger-confirm">
            <span className="danger-confirm-msg">This cannot be undone.</span>
            <button
              className="btn-danger-confirm"
              onClick={() => { setConfirming(false); onClearData(); }}
            >
              Yes, delete everything
            </button>
            <button className="btn-ghost" onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── SLA SETTINGS COMPONENT ───────────────────────────────────────────────────
function SLASection({ slaSettings, setSlaSettings, onSave, saving }) {
  const departments = [
    { key: 'sales', label: 'Sales', icon: '💼', color: '#7B3FA0', startFrom: 'Order Creation' },
    { key: 'logistics', label: 'Logistics', icon: '🚚', color: '#E67E22', startFrom: 'Logistics Assignment' },
    { key: 'activation', label: 'Activation', icon: '⚡', color: '#2ECC8A', startFrom: 'Logistics Assignment' },
  ];

  function formatWorkingHours(deptKey) {
    const config = WORKING_HOURS[deptKey];
    const start = config.start;
    const end = config.end;
    const startStr = start <= 12 ? `${start} AM` : `${start - 12} PM`;
    const endStr = end <= 12 ? `${end} AM` : `${end - 12} PM`;
    return `${startStr} - ${endStr}`;
  }

  function handleChange(dept, type, value) {
    const numValue = parseInt(value) || 0;
    setSlaSettings(prev => ({
      ...prev,
      [dept]: {
        ...prev[dept],
        [type]: numValue,
      },
    }));
  }

  return (
    <div className="section-card">
      <div className="section-card-head">
        <div>
          <div className="section-card-title">SLA Settings</div>
          <div className="section-card-sub">Set target times for each department. Times exceeding SLA will be shown in red on dashboards.</div>
        </div>
      </div>

      <div className="sla-grid">
        {departments.map(dept => (
          <div key={dept.key} className="sla-card" style={{ borderColor: `${dept.color}40` }}>
            <div className="sla-card-header" style={{ background: `${dept.color}15` }}>
              <span className="sla-icon">{dept.icon}</span>
              <span className="sla-dept-name" style={{ color: dept.color }}>{dept.label}</span>
            </div>
            <div className="sla-card-body">
              <div className="sla-info-row">
                <span className="sla-info-label">Working Hours:</span>
                <span className="sla-info-value">{formatWorkingHours(dept.key)}</span>
              </div>
              <div className="sla-info-row">
                <span className="sla-info-label">SLA Start:</span>
                <span className="sla-info-value">{dept.startFrom}</span>
              </div>
              <div className="sla-divider" />
              <div className="sla-input-group">
                <label>Working Hours Orders</label>
                <div className="sla-time-input">
                  <input
                    type="number"
                    min="0"
                    max="23"
                    value={Math.floor((slaSettings[dept.key]?.workingHours || 0) / 60)}
                    onChange={(e) => {
                      const hours = parseInt(e.target.value) || 0;
                      const mins = (slaSettings[dept.key]?.workingHours || 0) % 60;
                      handleChange(dept.key, 'workingHours', hours * 60 + mins);
                    }}
                  />
                  <span>h</span>
                  <input
                    type="number"
                    min="0"
                    max="59"
                    value={(slaSettings[dept.key]?.workingHours || 0) % 60}
                    onChange={(e) => {
                      const hours = Math.floor((slaSettings[dept.key]?.workingHours || 0) / 60);
                      const mins = parseInt(e.target.value) || 0;
                      handleChange(dept.key, 'workingHours', hours * 60 + mins);
                    }}
                  />
                  <span>m</span>
                </div>
              </div>
              <div className="sla-input-group">
                <label>Non-Working Hours Orders</label>
                <div className="sla-time-input">
                  <input
                    type="number"
                    min="0"
                    max="23"
                    value={Math.floor((slaSettings[dept.key]?.nonWorkingHours || 0) / 60)}
                    onChange={(e) => {
                      const hours = parseInt(e.target.value) || 0;
                      const mins = (slaSettings[dept.key]?.nonWorkingHours || 0) % 60;
                      handleChange(dept.key, 'nonWorkingHours', hours * 60 + mins);
                    }}
                  />
                  <span>h</span>
                  <input
                    type="number"
                    min="0"
                    max="59"
                    value={(slaSettings[dept.key]?.nonWorkingHours || 0) % 60}
                    onChange={(e) => {
                      const hours = Math.floor((slaSettings[dept.key]?.nonWorkingHours || 0) / 60);
                      const mins = parseInt(e.target.value) || 0;
                      handleChange(dept.key, 'nonWorkingHours', hours * 60 + mins);
                    }}
                  />
                  <span>m</span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="sla-actions">
        <button 
          className="btn btn-primary" 
          onClick={onSave}
          disabled={saving}
        >
          {saving ? (
            <>
              <div className="spinner-sm" style={{ width: 16, height: 16, borderWidth: 2 }} />
              Saving…
            </>
          ) : (
            <>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
                <polyline points="17 21 17 13 7 13 7 21"/>
                <polyline points="7 3 7 8 15 8"/>
              </svg>
              Save SLA Settings
            </>
          )}
        </button>
      </div>

      <div className="sla-note">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="16" x2="12" y2="12"/>
          <line x1="12" y1="8" x2="12.01" y2="8"/>
        </svg>
        <span>Times are displayed in hours and minutes. Default is 2 hours (120 minutes). Times exceeding SLA will appear in <span style={{ color: '#E74C3C', fontWeight: 600 }}>red</span> on performance dashboards.</span>
      </div>
    </div>
  );
}

// ─── MAIN PAGE ─────────────────────────────────────────────────────────────────
export default function Admin() {
  const [step, setStep] = useState(1);
  const [file, setFile] = useState(null);
  const [fileName, setFileName] = useState('');
  const [fileMeta, setFileMeta] = useState('');
  const [parsedHeaders, setParsedHeaders] = useState([]);
  const [parsedRows, setParsedRows] = useState([]);
  const [validResult, setValidResult] = useState(null);
  const [importProgress, setImportProgress] = useState({ pct: 0, label: '', show: false });
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [importError, setImportError]   = useState('');
  const [history, setHistory] = useState([]);
  const [agentMappings, setAgentMappings] = useState([]);
  const [mappingLoading, setMappingLoading] = useState(false);
  const [newAgentCode, setNewAgentCode] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newAgentType, setNewAgentType] = useState('sales');
  const [mappingError, setMappingError]       = useState('');
  const [mappingLoadError, setMappingLoadError] = useState('');
  const [activeTab, setActiveTab] = useState('import');
  const [emailHistory, setEmailHistory]     = useState([]);
  const [emailHistoryLoading, setEmailHistoryLoading] = useState(false);
  const [retrying, setRetrying]             = useState(false);
  const [sendCard, setSendCard]             = useState(null);
  const sendUnsubRef                        = useRef(null);
  const [clearing, setClearing]           = useState(false);
  const [clearProgress, setClearProgress] = useState({ pct: 0, label: '' });

  // SLA Settings state
  const [slaSettings, setSlaSettings] = useState({
    sales: { workingHours: 120, nonWorkingHours: 120 },      // 2 hours = 120 minutes
    logistics: { workingHours: 120, nonWorkingHours: 120 },
    activation: { workingHours: 120, nonWorkingHours: 120 },
  });
  const [slaLoading, setSlaLoading] = useState(false);
  const [slaSaving, setSlaSaving] = useState(false);

  const parsedAgents = useMemo(() => {
    const map = {};
    parsedRows.forEach(row => {
      const agents = extractAllAgentsFromRow(row);
      agents.forEach(({ agentCode, agentType }) => {
        if (!agentCode) return;
        if (!map[agentCode]) {
          map[agentCode] = { agentCode, displayName: '', visible: true, agentType, source: 'report' };
        }
      });
    });
    return Object.values(map).sort((a, b) => a.agentCode.localeCompare(b.agentCode));
  }, [parsedRows]);

  useEffect(() => {
    loadHistory();
    loadMappings();
    loadSLASettings();
    // Update data source pill
    localStorage.setItem('tpw_data_source', 'live');
  }, []);

  async function loadSLASettings() {
    try {
      const slaDoc = await getDocs(query(collection(db, 'slaSettings'), limit(1)));
      if (!slaDoc.empty) {
        const data = slaDoc.docs[0].data();
        setSlaSettings({
          sales: data.sales || { workingHours: 120, nonWorkingHours: 120 },
          logistics: data.logistics || { workingHours: 120, nonWorkingHours: 120 },
          activation: data.activation || { workingHours: 120, nonWorkingHours: 120 },
        });
      }
    } catch (err) {
      console.error('Error loading SLA settings:', err);
      // Keep defaults on error
    }
  }

  async function saveSLASettings() {
    setSlaSaving(true);
    try {
      const slaRef = doc(db, 'slaSettings', 'default');
      await setDoc(slaRef, slaSettings);
      alert('SLA settings saved successfully!');
    } catch (err) {
      console.error('Error saving SLA settings:', err);
      alert('Failed to save SLA settings: ' + err.message);
    } finally {
      setSlaSaving(false);
    }
  }

  async function loadHistory() {
    try {
      const q = query(collection(db, 'imports'), orderBy('importedAt', 'desc'), limit(10));
      const snap = await getDocs(q);
      setHistory(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (err) {
      console.error('Error loading history:', err);
    }
  }

  async function loadEmailHistory() {
    setEmailHistoryLoading(true);
    try {
      const q = query(collection(db, 'emailHistory'), orderBy('sentAt', 'desc'), limit(50));
      const snap = await getDocs(q);
      setEmailHistory(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (err) {
      console.error('Error loading email history:', err);
    } finally {
      setEmailHistoryLoading(false);
    }
  }

  async function triggerEmailSend() {
    setRetrying(true);
    if (sendUnsubRef.current) { sendUnsubRef.current(); sendUnsubRef.current = null; }
    const latestImport = history[0];
    if (!latestImport) {
      setSendCard({ status: 'failed', error: 'No import found — upload data first.', queuedAt: new Date() });
      setRetrying(false);
      return;
    }
    const startedAt = new Date();
    setSendCard({
      importId:       latestImport.id,
      importFilename: latestImport.filename || latestImport.id,
      rowCount:       latestImport.rowCount,
      queuedAt:       startedAt,
      status:         'sending',
      error:          null,
      sentAt:         null,
      dateRange:      null,
      recipients:     null,
    });
    try {
      const token = await auth.currentUser.getIdToken();
      const resp  = await fetch(
        'https://us-central1-performer-2df35.cloudfunctions.net/sendReportsNow',
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body:    JSON.stringify({ importId: latestImport.id }),
        }
      );
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.error || `Server error ${resp.status}`);
      }
      // Fetch the emailHistory entry that was just written
      const hSnap = await getDocs(
        query(collection(db, 'emailHistory'),
          where('importId', '==', latestImport.id),
          orderBy('sentAt', 'desc'),
          limit(1))
      );
      const h = hSnap.docs[0]?.data() || null;
      setSendCard(prev => ({
        ...prev,
        status:     'sent',
        sentAt:     new Date(),
        dateRange:  h?.dateRange    || null,
        recipients: h?.recipients   || null,
        rowCount:   h?.rowCount     ?? prev.rowCount,
      }));
      await loadEmailHistory();
    } catch (err) {
      console.error('Send failed:', err);
      setSendCard(prev => ({ ...prev, status: 'failed', error: err.message }));
    } finally {
      setRetrying(false);
    }
  }

  async function loadMappings() {
    setMappingLoading(true);
    setMappingLoadError('');
    try {
      const q = query(collection(db, 'agentMappings'), orderBy('agentCode', 'asc'));
      const snap = await getDocs(q);
      setAgentMappings(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (err) {
      console.error('Error loading agent mappings:', err);
      const isQuota = err?.code === 'resource-exhausted';
      setMappingLoadError(
        isQuota
          ? 'Firestore quota exceeded. Your data is safe — please try again in a few minutes.'
          : `Failed to load mappings: ${err.message}`
      );
    } finally {
      setMappingLoading(false);
    }
  }

  async function saveMapping(agentCode, displayName, visible, agentType = 'sales', email = '') {
    const code = (agentCode || '').trim().toUpperCase();
    if (!code) return;
    const data = { agentCode: code, displayName: (displayName || '').trim(), visible: visible !== false, agentType, email: (email || '').trim() };
    await setDoc(doc(db, 'agentMappings', code), data);
    // Optimistic update — avoids a full collection re-read after every single save
    setAgentMappings(prev => {
      const idx = prev.findIndex(m => m.agentCode === code);
      if (idx >= 0) { const next = [...prev]; next[idx] = { ...next[idx], ...data }; return next; }
      return [...prev, data];
    });
  }

  async function handleBulkUpdate(items) {
    if (!items.length) return;
    const batch = writeBatch(db);
    items.forEach(({ agentCode, displayName, visible, agentType }) => {
      const code = (agentCode || '').trim().toUpperCase();
      if (!code) return;
      batch.set(doc(db, 'agentMappings', code), {
        agentCode:   code,
        displayName: (displayName || '').trim(),
        visible:     visible !== false,
        agentType:   agentType || 'sales',
      }, { merge: true });
    });
    await batch.commit();
    await loadMappings(); // Single re-fetch after the entire batch
  }

  // Helper: delay function
  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  async function handleClearData() {
    setClearing(true);
    setClearProgress({ pct: 5, label: 'Fetching data to clear…' });
    
    // Initial cooldown to let pending operations settle
    await delay(1000);
    
    try {
      // Load all data that needs to be cleared
      const [importsSnap, ordersSnap, logisticsSnap, activationSnap] = await Promise.all([
        getDocs(collection(db, 'imports')),
        getDocs(collection(db, 'orders')),
        getDocs(collection(db, 'logisticsOrders')),
        getDocs(collection(db, 'activationOrders')),
      ]);

      const totalDocs = importsSnap.docs.length + ordersSnap.docs.length + 
                        logisticsSnap.docs.length + activationSnap.docs.length;

      if (totalDocs === 0) {
        setHistory([]);
        localStorage.setItem('tpw_data_source', 'demo');
        setClearing(false);
        return;
      }

      // Blaze plan: large batches with small delays between
      const BATCH_SIZE = 500; // Firestore batch limit
      const BATCH_DELAY = 100; // 100ms between batches to avoid rate limits
      const MAX_RETRIES = 3;
      let processedDocs = 0;

      // Helper to delete a collection of docs
      const deleteDocs = async (docs, collectionName) => {
        for (let j = 0; j < docs.length; j += BATCH_SIZE) {
          const batch = writeBatch(db);
          docs.slice(j, j + BATCH_SIZE).forEach(d => batch.delete(d.ref));
          
          // Retry with exponential backoff on rate limit errors
          let retries = 0;
          while (retries < MAX_RETRIES) {
            try {
              await batch.commit();
              break;
            } catch (err) {
              if (err?.code === 'resource-exhausted' && retries < MAX_RETRIES - 1) {
                retries++;
                await delay(1000 * Math.pow(2, retries)); // 2s, 4s, 8s
              } else {
                throw err;
              }
            }
          }
          
          processedDocs += Math.min(BATCH_SIZE, docs.length - j);
          const pct = Math.round(10 + (processedDocs / totalDocs) * 85);
          setClearProgress({ pct, label: `Clearing ${collectionName}… (${processedDocs} of ${totalDocs})` });
          
          // Small delay between batches to prevent burst rate limiting
          if (j + BATCH_SIZE < docs.length) {
            await delay(BATCH_DELAY);
          }
        }
      };

      // Clear all global order collections
      await deleteDocs(ordersSnap.docs, 'Sales Orders');
      await deleteDocs(logisticsSnap.docs, 'Logistics Orders');
      await deleteDocs(activationSnap.docs, 'Activation Orders');
      await deleteDocs(importsSnap.docs, 'Import Records');

      setClearProgress({ pct: 100, label: 'Done!' });
      setHistory([]);
      setImportResult(null);
      setStep(1);
      localStorage.setItem('tpw_data_source', 'demo');
    } catch (err) {
      console.error('Clear error:', err);
      alert('Error clearing data: ' + err.message);
    } finally {
      setClearing(false);
      setClearProgress({ pct: 0, label: '' });
    }
  }

  async function handleAddMapping() {
    const code = newAgentCode.trim().toUpperCase();
    if (!code) {
      setMappingError('Agent code is required');
      return;
    }
    setMappingError('');
    await saveMapping(code, newDisplayName, true, newAgentType);
    setNewAgentCode('');
    setNewDisplayName('');
    setNewAgentType('sales');
  }

  async function handleUpdateMapping(mapping, field, value) {
    const updated = { ...mapping, [field]: value };
    await saveMapping(updated.agentCode, updated.displayName, updated.visible, updated.agentType || 'sales', updated.email || '');
  }

  function handleFile(f) {
    setFile(f);
    setFileName(f.name);
    setFileMeta(`${(f.size / 1024).toFixed(1)} KB · ${f.type || 'text/csv'}`);
    setImportProgress({ pct: 10, label: 'Reading file…', show: true });

    const reader = new FileReader();
    reader.onload = (ev) => {
      setImportProgress({ pct: 40, label: 'Parsing rows…', show: true });
      setTimeout(() => {
        const { headers, rows } = parseCSV(ev.target.result);
        setParsedHeaders(headers);
        setParsedRows(rows);

        const headerSet = new Set(headers);
        const missing = ACTIVE_COLS.filter(c => !headerSet.has(c));
        setValidResult({ found: ACTIVE_COLS.filter(c => headerSet.has(c)), missing, hasErrors: missing.length > 0 });

        setImportProgress({ pct: 100, label: `Parsed ${rows.length.toLocaleString()} rows`, show: true });
        setTimeout(() => {
          setImportProgress(p => ({ ...p, show: false }));
          setStep(3);
        }, 800);
        setStep(2);
      }, 50);
    };
    reader.readAsText(f);
  }

  function handleRemove() {
    setFile(null);
    setFileName('');
    setFileMeta('');
    setParsedHeaders([]);
    setParsedRows([]);
    setValidResult(null);
    setImportProgress({ pct: 0, label: '', show: false });
    setStep(1);
  }

  async function doImport() {
    if (importing) return;
    setImporting(true);
    setImportProgress({ pct: 5, label: 'Processing rows…', show: true });

    try {
      const agents  = processRows(parsedRows);
      const summary = computeSummary(agents, parsedRows);
      
      // Get unique order numbers for stats
      const orderNos = parsedRows
        .map(row => (row['CHANNEL_ORDER_NO'] || '').trim())
        .filter(Boolean);
      const uniqueOrderNos = [...new Set(orderNos)];
      const totalRows = parsedRows.length;
      const uniqueCount = uniqueOrderNos.length;
      
      // Note: We're skipping the expensive existence check for large files
      // since we're using set with merge anyway. The first import will create,
      // subsequent imports will update.
      const isLargeFile = totalRows > 10000;
      
      setImportProgress({ pct: 15, label: `Processing ${totalRows.toLocaleString()} rows (${uniqueCount.toLocaleString()} unique orders)…`, show: true });

      // Save import metadata
      const importRef = await addDoc(collection(db, 'imports'), {
        filename:    file ? file.name : 'unknown.csv',
        rowCount:    totalRows,
        uniqueOrderCount: uniqueCount,
        agentCount:  agents.length,
        salesAgentCount: summary.salesAgents || 0,
        logisticsAgentCount: summary.logisticsAgents || 0,
        activationAgentCount: summary.activationAgents || 0,
        summary,
        importedAt:  serverTimestamp(),
        isLargeFile,
      });

      const importId = importRef.id;

      // Firestore batch configuration
      const CHUNK = 450; // Slightly under 500 limit for safety
      const MAX_RETRIES = 3;
      const BATCH_DELAY = isLargeFile ? 50 : 0; // Small delay between batches for large files

      const commitWithRetry = async (batch) => {
        let retries = 0;
        while (true) {
          try {
            await batch.commit();
            return;
          } catch (err) {
            if (err?.code === 'resource-exhausted' && retries < MAX_RETRIES - 1) {
              retries++;
              await delay(1000 * Math.pow(2, retries));
            } else {
              throw err;
            }
          }
        }
      };

      // Stream process rows in chunks to reduce memory usage
      const processInChunks = async (collectionName, rowProcessor, totalCount, collectionLabel) => {
        let processedCount = 0;
        let batch = writeBatch(db);
        let batchCount = 0;
        
        for (let i = 0; i < parsedRows.length; i++) {
          const order = rowProcessor(parsedRows[i]);
          if (!order) continue;
          
          const docRef = doc(db, collectionName, order.orderNo);
          batch.set(docRef, order, { merge: true });
          batchCount++;
          processedCount++;
          
          if (batchCount >= CHUNK) {
            await commitWithRetry(batch);
            batch = writeBatch(db);
            batchCount = 0;
            
            // Update progress
            const pct = Math.round(20 + (processedCount / totalCount) * 70);
            setImportProgress({ pct, label: `${collectionLabel}: ${processedCount.toLocaleString()} of ${totalCount.toLocaleString()}…`, show: true });
            
            // Small delay for large files to prevent rate limiting
            if (isLargeFile && i < parsedRows.length - 1) {
              await delay(BATCH_DELAY);
            }
          }
        }
        
        // Commit remaining
        if (batchCount > 0) {
          await commitWithRetry(batch);
        }
        
        return processedCount;
      };

      // Row processors for each collection
      const processSalesOrder = (row) => {
        const orderNo = (row['CHANNEL_ORDER_NO'] || '').trim();
        if (!orderNo) return null;
        
        const orderDT  = parseDateTime(row['ORDER_CREATION_DATE_TIME1'] || row['ORDER_CREATION_DATE'], row['ORDER_CREATION_time']);
        const claimDT  = parseDateTime(row['SALES_CLAIM_DATE_FIRST'], row['SALES_CLAIM_TIME_FIRST']);
        const logisticsAssignDT = parseDateTime(row['LOGISTICS_ASSIGN_DATE_1'], row['LOGISTICS_ASSIGN_TIME_1']);
        const logisticsClaimDT  = parseDateTime(row['LOGISTICS_CLAIM_DATE_FIRST'], row['LOGISTICS_CLAIM_TIME_FIRST']);
        const activationAssignDT = parseDateTime(row['ACTIVATION_ASSIGN_DATE'], row['ACTIVATION_ASSIGN_TIME']);

        const effectiveOrderDT = getEffectiveSalesStartTime(orderDT, row['HOURS_TYPE']);

        return {
          orderNo,
          agentName:    getRowAgentName(row),
          channel:      row['CHANNEL'] || '',
          status:       row['ESHOP_ORDER_STATUS'] || '',
          hoursType:    row['HOURS_TYPE'] || '',
          orderDT:      orderDT ? Timestamp.fromDate(orderDT) : null,
          effectiveOrderDT: effectiveOrderDT ? Timestamp.fromDate(effectiveOrderDT) : null,
          claimDT:      claimDT ? Timestamp.fromDate(claimDT) : null,
          logisticsAssignDT: logisticsAssignDT ? Timestamp.fromDate(logisticsAssignDT) : null,
          logisticsClaimDT: logisticsClaimDT ? Timestamp.fromDate(logisticsClaimDT) : null,
          activationAssignDT: activationAssignDT ? Timestamp.fromDate(activationAssignDT) : null,
          claimed:      !!claimDT,
          claimTimeSec: diffSeconds(effectiveOrderDT, claimDT),
          assignTimeSec: diffSeconds(claimDT, logisticsAssignDT),
          logisticsAssignTimeSec: diffSeconds(claimDT, logisticsAssignDT),
          logisticsClaimTimeSec: diffSeconds(logisticsAssignDT, logisticsClaimDT),
          activationAssignTimeSec: diffSeconds(logisticsClaimDT, activationAssignDT),
          lastImportedAt: serverTimestamp(),
          importId,
        };
      };

      const processLogisticsOrder = (row) => {
        const orderNo = (row['CHANNEL_ORDER_NO'] || '').trim();
        const agentName = (row['LOGISTICS_USER_FIRST'] || row['LOGISTICS_USER_LAST'] || '').trim();
        if (!orderNo || !agentName) return null;
        
        const assignDT  = parseDateTime(row['LOGISTICS_ASSIGN_DATE_1'], row['LOGISTICS_ASSIGN_TIME_1']);
        const claimDT   = parseDateTime(row['LOGISTICS_CLAIM_DATE_FIRST'], row['LOGISTICS_CLAIM_TIME_FIRST']);
        const activationAssignDT = parseDateTime(row['ACTIVATION_ASSIGN_DATE'], row['ACTIVATION_ASSIGN_TIME']);
        const activationClaimDT = parseDateTime(row['ACTIVATION_CLAIM_DATE'], row['ACTIVATION_CLAIM_TIME']);
        
        const effectiveAssignDT = getEffectiveStartTime(assignDT, 'logistics');
        
        return {
          orderNo,
          agentName,
          activationAgentName: row['ACTIVATION_USER'] || '',
          channel:      row['CHANNEL'] || '',
          status:       row['ESHOP_ORDER_STATUS'] || '',
          assignDT:     assignDT ? Timestamp.fromDate(assignDT) : null,
          effectiveAssignDT: effectiveAssignDT ? Timestamp.fromDate(effectiveAssignDT) : null,
          claimDT:      claimDT ? Timestamp.fromDate(claimDT) : null,
          activationAssignDT: activationAssignDT ? Timestamp.fromDate(activationAssignDT) : null,
          activationClaimDT: activationClaimDT ? Timestamp.fromDate(activationClaimDT) : null,
          claimed:      !!claimDT,
          claimTimeSec: diffSeconds(effectiveAssignDT, claimDT),
          activationAssignTimeSec: diffSeconds(claimDT, activationAssignDT),
          handleTimeSec: diffSeconds(activationAssignDT, activationClaimDT),
          completed:    !!activationClaimDT,
          lastImportedAt: serverTimestamp(),
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
          agentName:    activationUser,
          channel:      row['CHANNEL'] || '',
          status:       row['ESHOP_ORDER_STATUS'] || '',
          assignDT:     activationAssignDT ? Timestamp.fromDate(activationAssignDT) : null,
          effectiveAssignDT: effectiveAssignDT ? Timestamp.fromDate(effectiveAssignDT) : null,
          claimDT:      activationClaimDT ? Timestamp.fromDate(activationClaimDT) : null,
          claimed:      !!activationClaimDT,
          claimTimeSec: diffSeconds(effectiveAssignDT, activationClaimDT),
          handleTimeSec: diffSeconds(activationAssignDT, activationClaimDT),
          completed:    !!activationClaimDT,
          lastImportedAt: serverTimestamp(),
          importId,
        };
      };

      // Process sequentially to reduce memory pressure and Firestore load
      setImportProgress({ pct: 20, label: 'Writing Sales Orders…', show: true });
      const salesCount = await processInChunks('orders', processSalesOrder, totalRows, 'Sales Orders');
      
      setImportProgress({ pct: 50, label: 'Writing Logistics Orders…', show: true });
      const logisticsCount = await processInChunks('logisticsOrders', processLogisticsOrder, totalRows, 'Logistics Orders');
      
      setImportProgress({ pct: 80, label: 'Writing Activation Orders…', show: true });
      const activationCount = await processInChunks('activationOrders', processActivationOrder, totalRows, 'Activation Orders');

      setImportProgress({ pct: 95, label: 'Finalising…', show: true });

      // Update localStorage to tell navbar it's live data
      localStorage.setItem('tpw_data_source', 'live');

      setImportResult({
        importId,
        agents:   agents.length,
        summary,
        filename: file ? file.name : 'unknown.csv',
        rowCount: totalRows,
        uniqueOrderCount: uniqueCount,
        salesCount,
        logisticsCount,
        activationCount,
        dateTo:   summary.dateTo,
        isLargeFile,
      });

      setStep(4);
      await loadHistory();
      
      // Save agent mappings from this import to Firestore (skip for very large files if needed)
      if (!isLargeFile || agents.length < 1000) {
        setImportProgress({ pct: 98, label: 'Saving agent mappings…', show: true });
        try {
          const existingMappingsSnap = await getDocs(collection(db, 'agentMappings'));
          const existingMappings = {};
          existingMappingsSnap.docs.forEach(d => {
            const data = d.data();
            if (data.agentCode) {
              existingMappings[data.agentCode.toUpperCase()] = data;
            }
          });
          
          let batch = writeBatch(db);
          let batchCount = 0;
          
          for (const agent of parsedAgents) {
            const code = (agent.agentCode || '').trim().toUpperCase();
            if (!code) continue;

            const ref = doc(db, 'agentMappings', code);
            const existing = existingMappings[code];

            if (!existing) {
              batch.set(ref, {
                agentCode: code,
                displayName: '',
                visible: true,
                agentType: agent.agentType || 'sales',
              });
              
              batchCount++;
              
              if (batchCount >= 400) {
                await batch.commit();
                batch = writeBatch(db);
                batchCount = 0;
              }
            }
          }
          
          if (batchCount > 0) {
            await batch.commit();
          }
          
          await loadMappings();
        } catch (mappingErr) {
          console.error('Error saving agent mappings:', mappingErr);
        }
      }
      
      setImportProgress({ pct: 100, label: 'Import complete!', show: true });
    } catch (err) {
      console.error('Import error:', err);
      alert('Import failed: ' + err.message);
    } finally {
      setImporting(false);
      setImportProgress(p => ({ ...p, show: false }));
    }
  }

  function handleNewImport() {
    setStep(1);
    setFile(null);
    setFileName('');
    setFileMeta('');
    setParsedHeaders([]);
    setParsedRows([]);
    setValidResult(null);
    setImportResult(null);
    setImportProgress({ pct: 0, label: '', show: false });
  }

  return (
    <>
      <Navbar activeLink="admin" />
      <div className="page">
        <div className="page-head">
          <h1>Data Management</h1>
          <p>Upload and parse your CSV export to power all performance dashboards</p>
        </div>

        <div className="tab-bar">
          <button
            className={`tab-btn${activeTab === 'import' ? ' active' : ''}`}
            onClick={() => setActiveTab('import')}
          >
            Import CSV
          </button>
          <button
            className={`tab-btn${activeTab === 'mappings' ? ' active' : ''}`}
            onClick={() => {
              setActiveTab('mappings');
              // Refresh mappings when switching to this tab
              loadMappings();
            }}
          >
            Agent Mappings
          </button>
          <button
            className={`tab-btn${activeTab === 'sla' ? ' active' : ''}`}
            onClick={() => {
              setActiveTab('sla');
              loadSLASettings();
            }}
          >
            SLA Settings
          </button>
          <button
            className={`tab-btn${activeTab === 'emails' ? ' active' : ''}`}
            onClick={() => {
              setActiveTab('emails');
              loadEmailHistory();
            }}
          >
            Email History
          </button>
          <button
            className={`tab-btn${activeTab === 'delivery' ? ' active' : ''}`}
            onClick={() => setActiveTab('delivery')}
          >
            Delivery Upload
          </button>
        </div>

        {activeTab === 'import' && (
          <>
            <StepsBar step={step} />

            <UploadCard
              onFile={handleFile}
              file={file}
              fileName={fileName}
              fileMeta={fileMeta}
              onRemove={handleRemove}
              progress={importProgress}
            />

            {step >= 2 && parsedHeaders.length > 0 && (
              <ValidationSection headers={parsedHeaders} parsedRows={parsedRows} />
            )}

            {step >= 3 && parsedRows.length > 0 && (
              <PreviewSection rows={parsedRows} headers={parsedHeaders} total={parsedRows.length} />
            )}

            {step >= 3 && !importResult && (
              <ImportBar
                rowCount={parsedRows.length}
                onImport={doImport}
                importing={importing}
                progress={importProgress}
              />
            )}

            {importResult && (
              <SuccessSection result={importResult} onNewImport={handleNewImport} />
            )}

            <HistorySection history={history} />

            <DangerZone
              onClearData={handleClearData}
              clearing={clearing}
              clearProgress={clearProgress}
            />
          </>
        )}
        
        {activeTab === 'mappings' && (
          <AgentMappingsSection
            mappings={agentMappings}
            parsedAgents={parsedAgents}
            loading={mappingLoading}
            loadError={mappingLoadError}
            onRetry={loadMappings}
            newAgentCode={newAgentCode}
            newDisplayName={newDisplayName}
            newAgentType={newAgentType}
            newAgentError={mappingError}
            onNewAgentCode={setNewAgentCode}
            onNewDisplayName={setNewDisplayName}
            onNewAgentType={setNewAgentType}
            onAdd={handleAddMapping}
            onUpdate={handleUpdateMapping}
            onBulkUpdate={handleBulkUpdate}
          />
        )}
        
        {activeTab === 'sla' && (
          <SLASection
            slaSettings={slaSettings}
            setSlaSettings={setSlaSettings}
            onSave={saveSLASettings}
            saving={slaSaving}
          />
        )}

        {activeTab === 'emails' && (() => {
          const todayKey = new Date().toISOString().slice(0, 10);
          const hasSentToday = emailHistory.some(e => {
            const ts = e.sentAt?.toDate ? e.sentAt.toDate() : new Date(e.sentAt);
            return ts.toISOString().slice(0, 10) === todayKey;
          });
          return (
          <div className="section-card">
            <div className="section-card-header">
              <div>
                <div className="section-card-title">Email History</div>
                <div className="section-card-sub">Automated performance reports sent to recipients</div>
              </div>
              <button
                className="btn-primary"
                onClick={() => triggerEmailSend()}
                disabled={hasSentToday || retrying}
                title={hasSentToday ? 'Emails already sent today' : 'Trigger email send now'}
                style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
              >
                {retrying ? 'Sending…' : 'Send Reports Now'}
              </button>
            </div>

            {sendCard && (() => {
              const statusColor = sendCard.status === 'sent' ? '#22c55e' : sendCard.status === 'failed' ? '#ef4444' : '#f59e0b';
              const statusBg    = sendCard.status === 'sent' ? 'rgba(34,197,94,0.08)' : sendCard.status === 'failed' ? 'rgba(239,68,68,0.08)' : 'rgba(245,158,11,0.08)';
              const statusBorder= sendCard.status === 'sent' ? 'rgba(34,197,94,0.3)' : sendCard.status === 'failed' ? 'rgba(239,68,68,0.3)' : 'rgba(245,158,11,0.3)';
              const statusLabel = sendCard.status === 'sent' ? 'Sent' : sendCard.status === 'failed' ? 'Failed' : 'Sending…';
              const allRecipients = sendCard.recipients
                ? [
                    ...(sendCard.recipients.sales      || []).map(e => ({ team: 'Sales',      email: e })),
                    ...(sendCard.recipients.logistics  || []).map(e => ({ team: 'Logistics',  email: e })),
                    ...(sendCard.recipients.activation || []).map(e => ({ team: 'Activation', email: e })),
                    ...(sendCard.recipients.management || []).map(e => ({ team: 'Management', email: e })),
                  ]
                : [];
              return (
                <div style={{
                  margin: '0 0 20px 0',
                  borderRadius: '10px',
                  border: `1px solid ${statusBorder}`,
                  background: statusBg,
                  overflow: 'hidden',
                }}>
                  {/* Header row */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px', borderBottom: `1px solid ${statusBorder}` }}>
                    <span style={{
                      padding: '3px 10px', borderRadius: 20, fontSize: 12, fontWeight: 700,
                      background: statusColor, color: '#fff', letterSpacing: '0.04em',
                    }}>{statusLabel}</span>
                    {sendCard.importFilename && (
                      <span style={{ fontSize: 13, color: 'var(--text-dim)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {sendCard.importFilename}
                        {sendCard.rowCount ? ` · ${sendCard.rowCount.toLocaleString()} rows` : ''}
                      </span>
                    )}
                    {sendCard.status === 'sending' && (
                      <span style={{ fontSize: 12, color: '#f59e0b' }}>Generating PDFs and sending emails…</span>
                    )}
                  </div>

                  {/* Detail rows */}
                  <div style={{ padding: '12px 18px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '10px 24px' }}>
                    <div>
                      <div style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>Started At</div>
                      <div style={{ fontSize: 13 }}>{sendCard.queuedAt?.toLocaleString('en-GB') || '—'}</div>
                    </div>
                    {sendCard.sentAt && (
                      <div>
                        <div style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>Sent At</div>
                        <div style={{ fontSize: 13 }}>{sendCard.sentAt.toLocaleString('en-GB')}</div>
                      </div>
                    )}
                    {sendCard.dateRange && (
                      <div>
                        <div style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>Data Period</div>
                        <div style={{ fontSize: 13 }}>{sendCard.dateRange}</div>
                      </div>
                    )}
                    <div>
                      <div style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>Import ID</div>
                      <div style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--text-dim)' }}>{sendCard.importId || '—'}</div>
                    </div>
                  </div>

                  {/* Error */}
                  {sendCard.status === 'failed' && sendCard.error && (
                    <div style={{ margin: '0 18px 14px', padding: '10px 14px', borderRadius: 6, background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.25)', fontSize: 13, color: '#ef4444' }}>
                      {sendCard.error}
                    </div>
                  )}

                  {/* Recipients */}
                  {allRecipients.length > 0 && (
                    <div style={{ padding: '0 18px 14px' }}>
                      <div style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Recipients</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {allRecipients.map((r, i) => (
                          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                            <span style={{
                              padding: '1px 7px', borderRadius: 10, fontSize: 11, fontWeight: 600,
                              background: r.team === 'Sales' ? 'rgba(59,130,246,0.15)' :
                                          r.team === 'Logistics' ? 'rgba(168,85,247,0.15)' :
                                          r.team === 'Activation' ? 'rgba(245,158,11,0.15)' :
                                          'rgba(100,116,139,0.15)',
                              color: r.team === 'Sales' ? '#3b82f6' :
                                     r.team === 'Logistics' ? '#a855f7' :
                                     r.team === 'Activation' ? '#f59e0b' :
                                     'var(--text-dim)',
                            }}>{r.team}</span>
                            <span style={{ color: 'var(--text-dim)' }}>{r.email}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Sending — no recipients yet */}
                  {sendCard.status === 'sending' && (
                    <div style={{ padding: '0 18px 14px', fontSize: 13, color: 'var(--text-dim)' }}>
                      Recipients will appear once emails are delivered.
                    </div>
                  )}
                </div>
              );
            })()}

            {emailHistoryLoading ? (
              <div className="section-empty">Loading...</div>
            ) : emailHistory.length === 0 ? (
              <div className="section-empty">No emails sent yet — emails are sent 5 minutes after each daily import.</div>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Sent At</th>
                    <th>Date Range</th>
                    <th>Orders</th>
                    <th>Reports</th>
                    <th>Recipients</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {emailHistory.map(item => {
                    const ts = item.sentAt?.toDate ? item.sentAt.toDate() : new Date(item.sentAt);
                    const allRecipients = [
                      ...(item.recipients?.sales      || []),
                      ...(item.recipients?.logistics  || []),
                      ...(item.recipients?.activation || []),
                      ...(item.recipients?.management || []),
                    ];
                    const uniqueRecipients = [...new Set(allRecipients)];
                    return (
                      <tr key={item.id}>
                        <td>{ts.toLocaleString('en-GB')}</td>
                        <td>{item.dateRange || '—'}</td>
                        <td>{item.rowCount?.toLocaleString() || '—'}</td>
                        <td>
                          {(item.reports || []).map(r => (
                            <span key={r} className="badge">{r}</span>
                          ))}
                        </td>
                        <td style={{ fontSize: '12px', color: 'var(--text-dim)' }}>
                          {uniqueRecipients.join(', ')}
                        </td>
                        <td>
                          <span className={`status-pill ${item.status === 'sent' ? 'status-claimed' : 'status-unclaimed'}`}>
                            {item.status}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          );
        })()}

        {activeTab === 'delivery' && (
          <DeliveryUploadTab />
        )}
      </div>
    </>
  );
}
