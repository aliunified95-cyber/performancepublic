import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  collection,
  doc,
  addDoc,
  writeBatch,
  getDocs,
  query,
  orderBy,
  serverTimestamp,
  Timestamp,
  limit,
} from 'firebase/firestore';
import { signOut } from 'firebase/auth';
import { db, auth } from '../firebase';
import Navbar from '../components/Navbar';

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

  let d = new Date(`${dateStr}T${timeStr || '00:00:00'}`);
  if (!isNaN(d)) return d;

  const parts = dateStr.split(/[\/\-\.]/);
  if (parts.length === 3) {
    let [a, b, c] = parts.map(Number);
    let iso;
    if (a > 12) iso = `${c < 100 ? 2000 + c : c}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`;
    else        iso = `${c < 100 ? 2000 + c : c}-${String(a).padStart(2, '0')}-${String(b).padStart(2, '0')}`;
    d = new Date(`${iso}T${timeStr || '00:00:00'}`);
    if (!isNaN(d)) return d;
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

function fmtTime(sec) {
  if (sec == null || isNaN(sec)) return '—';
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

// ─── ROW PROCESSOR ────────────────────────────────────────────────────────────
function processRows(rows) {
  const agentMap = {};

  rows.forEach(row => {
    const agent = (row['SALES_USER_FIRST'] || '').trim();
    if (!agent) return;

    if (!agentMap[agent]) agentMap[agent] = { name: agent, orders: [] };

    const orderDT   = parseDateTime(row['ORDER_CREATION_DATE'], row['ORDER_CREATION_time']);
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

  return { totalOrders, totalClaimed, avgClaimTimeSec: avgClaim, avgAssignTimeSec: avgAssign, dateFrom, dateTo };
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
  const kpis = [
    { val: result.rowCount.toLocaleString(),     lbl: 'Total Orders' },
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
            {result.filename} · {result.rowCount.toLocaleString()} rows · {result.agents} agents · {s.dateFrom} – {s.dateTo}
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
  const [history, setHistory] = useState([]);

  useEffect(() => {
    loadHistory();
    // Update data source pill
    localStorage.setItem('tpw_data_source', 'live');
  }, []);

  async function loadHistory() {
    try {
      const q = query(collection(db, 'imports'), orderBy('importedAt', 'desc'), limit(10));
      const snap = await getDocs(q);
      setHistory(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (err) {
      console.error('Error loading history:', err);
    }
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

      setImportProgress({ pct: 20, label: 'Saving import metadata…', show: true });

      const importRef = await addDoc(collection(db, 'imports'), {
        filename:    file ? file.name : 'unknown.csv',
        rowCount:    parsedRows.length,
        agentCount:  agents.length,
        summary,
        importedAt:  serverTimestamp(),
      });

      const importId = importRef.id;

      // Build orders array
      const orders = parsedRows.map(row => {
        const orderDT  = parseDateTime(row['ORDER_CREATION_DATE'], row['ORDER_CREATION_time']);
        const claimDT  = parseDateTime(row['SALES_CLAIM_DATE_FIRST'], row['SALES_CLAIM_TIME_FIRST']);
        const assignDT = parseDateTime(row['LOGISTICS_ASSIGN_DATE_1'], row['LOGISTICS_ASSIGN_TIME_1']);
        return {
          orderNo:      row['CHANNEL_ORDER_NO'] || '',
          agentName:    row['SALES_USER_FIRST'] || '',
          channel:      row['CHANNEL'] || '',
          status:       row['ESHOP_ORDER_STATUS'] || '',
          hoursType:    row['HOURS_TYPE'] || '',
          orderDT:      orderDT ? Timestamp.fromDate(orderDT) : null,
          claimed:      !!claimDT,
          claimTimeSec: diffSeconds(orderDT, claimDT),
          assignTimeSec: diffSeconds(claimDT, assignDT),
        };
      });

      // Batch write in chunks of 400
      const CHUNK = 400;
      const total = orders.length;
      let done = 0;

      for (let i = 0; i < orders.length; i += CHUNK) {
        const chunk = orders.slice(i, i + CHUNK);
        const batch = writeBatch(db);
        chunk.forEach(order => {
          const ref = doc(collection(db, 'imports', importId, 'orders'));
          batch.set(ref, order);
        });
        await batch.commit();
        done += chunk.length;
        const pct = Math.round(20 + (done / total) * 75);
        setImportProgress({ pct, label: `Writing orders… ${done.toLocaleString()} / ${total.toLocaleString()}`, show: true });
      }

      setImportProgress({ pct: 100, label: 'Import complete!', show: true });

      // Update localStorage to tell navbar it's live data
      localStorage.setItem('tpw_data_source', 'live');

      setImportResult({
        importId,
        agents:   agents.length,
        summary,
        filename: file ? file.name : 'unknown.csv',
        rowCount: parsedRows.length,
        dateTo:   summary.dateTo,
      });

      setStep(4);
      await loadHistory();
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
      </div>
    </>
  );
}
