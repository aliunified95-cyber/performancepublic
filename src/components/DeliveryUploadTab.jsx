import React, { useState } from 'react';
import {
  collection,
  writeBatch,
  doc,
  serverTimestamp,
  Timestamp,
  getDocs,
  query,
  orderBy,
} from 'firebase/firestore';
import { db } from '../firebase';

// ─── EXPECTED CSV COLUMNS ───────────────────────────────────────────────────────
const EXPECTED_COLS = [
  'Pickup Date (Creation Date)',
  'Pickup Time (Creation Time)',
  'Consignee Reference 1',
  'Delivery Status Action Date',
  '1st Delivery Attempt',
  '1st Deliv. Atpt. Problem Code',
  '2nd Delivery Attempt',
  '2nd Deliv. Atpt. Problem Code',
  '3rd Delivery Attempt',
  '3rd Deliv. Atpt. Problem Code',
];

// ─── CSV PARSER ─────────────────────────────────────────────────────────────────
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
        else inQ = !inQ;
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

// ─── DATE PARSER ────────────────────────────────────────────────────────────────
function parseDateTime(dateStr, timeStr = '') {
  if (!dateStr) return null;
  dateStr = dateStr.trim();
  timeStr = (timeStr || '').trim();

  const spaceIdx = dateStr.indexOf(' ');
  if (spaceIdx > 0 && !timeStr) {
    timeStr = dateStr.slice(spaceIdx + 1).trim();
    dateStr = dateStr.slice(0, spaceIdx);
  }

  const ampmMatch = timeStr.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])$/);
  if (ampmMatch) {
    let h = parseInt(ampmMatch[1], 10);
    const m = ampmMatch[2], s = ampmMatch[3] || '00', ap = ampmMatch[4].toUpperCase();
    if (ap === 'AM' && h === 12) h = 0;
    if (ap === 'PM' && h !== 12) h += 12;
    timeStr = `${String(h).padStart(2, '0')}:${m}:${s}`;
  }
  if (/^\d{1,2}:\d{2}$/.test(timeStr)) timeStr += ':00';

  let d = new Date(`${dateStr}T${timeStr || '00:00:00'}`);
  if (!isNaN(d)) return d;

  const parts = dateStr.split(/[\/\-\.]/);
  if (parts.length === 3) {
    const raw = parts.map(Number);
    if (!raw.some(isNaN)) {
      let [a, b, c] = raw;
      let iso;
      if (a > 31)      iso = `${a}-${String(b).padStart(2,'0')}-${String(c).padStart(2,'0')}`;
      else if (a > 12) iso = `${c < 100 ? 2000+c : c}-${String(b).padStart(2,'0')}-${String(a).padStart(2,'0')}`;
      else             iso = `${c < 100 ? 2000+c : c}-${String(a).padStart(2,'0')}-${String(b).padStart(2,'0')}`;
      d = new Date(`${iso}T${timeStr || '00:00:00'}`);
      if (!isNaN(d)) return d;
    }
  }
  return null;
}

// ─── ROW TRANSFORMER ────────────────────────────────────────────────────────────
function transformRow(row, logisticsOrderMap) {
  const awb          = (row['Consignee Reference 1'] || '').trim();
  const shipmentDate = parseDateTime(
    row['Pickup Date (Creation Date)'],
    row['Pickup Time (Creation Time)'],
  );

  // Status: delivered if Delivery Status Action Date has a value
  const deliveryStatusRaw = (row['Delivery Status Action Date'] || '').trim();
  const deliveredDate     = deliveryStatusRaw ? parseDateTime(deliveryStatusRaw) : null;
  const status            = deliveredDate ? 'delivered' : 'undelivered';

  // Attempt dates and problem codes
  const att1Date = parseDateTime(row['1st Delivery Attempt']);
  const att2Date = parseDateTime(row['2nd Delivery Attempt']);
  const att3Date = parseDateTime(row['3rd Delivery Attempt']);
  const prob1    = (row['1st Deliv. Atpt. Problem Code'] || '').trim();
  const prob2    = (row['2nd Deliv. Atpt. Problem Code'] || '').trim();
  const prob3    = (row['3rd Deliv. Atpt. Problem Code'] || '').trim();

  // Count filled attempt date columns
  let filledAttempts = 0;
  if (att1Date) filledAttempts++;
  if (att2Date) filledAttempts++;
  if (att3Date) filledAttempts++;

  // The "last" problem code among the filled date columns
  const lastProb = att3Date ? prob3 : att2Date ? prob2 : att1Date ? prob1 : '';

  // Attempt count rules:
  // - No problem code on the last filled attempt → delivered on that attempt
  // - Problem code on the last filled attempt + delivered → delivery happened on a
  //   SUBSEQUENT attempt (add 1). e.g. 1 date column filled + prob1 set + delivered = attempt 2
  // - No date columns at all + delivered → delivered from first (implicit, attempt 1)
  let attempt;
  if (filledAttempts === 0) {
    attempt = status === 'delivered' ? 1 : null;
  } else if (status === 'delivered') {
    attempt = lastProb ? filledAttempts + 1 : filledAttempts;
  } else {
    attempt = filledAttempts || null;
  }

  // Most recent problem code (for quick reference / filtering)
  const problemCode = prob3 || prob2 || prob1 || '';

  // Delivery time: AWB creation → delivery date
  const deliveryTimeSec = (deliveredDate && shipmentDate)
    ? Math.max(0, Math.round((deliveredDate - shipmentDate) / 1000))
    : null;

  // AWB creation → 1st attempt
  const awbToFirstAttemptSec = (att1Date && shipmentDate)
    ? Math.max(0, Math.round((att1Date - shipmentDate) / 1000))
    : null;

  // AWB to logistics: look up the Zain order in logisticsOrders by Consignee Reference 1
  let awbToLogisticsSec = null;
  if (awb && logisticsOrderMap && logisticsOrderMap[awb] && shipmentDate) {
    const lo = logisticsOrderMap[awb];
    const assignDT = lo.assignDT?.toDate ? lo.assignDT.toDate() : (lo.assignDT ? new Date(lo.assignDT) : null);
    if (assignDT) {
      const diff = Math.round((assignDT - shipmentDate) / 1000);
      if (diff >= 0) awbToLogisticsSec = diff;
    }
  }

  return {
    awb,
    shipmentDate:     shipmentDate  ? Timestamp.fromDate(shipmentDate)  : null,
    deliveredDate:    deliveredDate ? Timestamp.fromDate(deliveredDate) : null,
    status,
    attempt:          attempt || null,
    deliveryTimeSec,
    awbToFirstAttemptSec,
    awbToLogisticsSec,
    problemCode:      problemCode || null,
    prob1:            prob1 || null,
    prob2:            prob2 || null,
    prob3:            prob3 || null,
  };
}

// ─── BATCH WRITE ────────────────────────────────────────────────────────────────
const BATCH_SIZE = 400;

async function writeDeliveryData(rows, onProgress) {
  // Step 1: load logistics orders for join (orderNo = Consignee Reference 1)
  onProgress('Loading logistics orders for order matching…', 5);
  const logisticsSnap = await getDocs(query(collection(db, 'logisticsOrders'), orderBy('assignDT', 'desc')));
  const logisticsOrderMap = {};
  logisticsSnap.docs.forEach(d => {
    const data = d.data();
    if (data.orderNo) logisticsOrderMap[data.orderNo] = data;
  });
  const matchedCount = logisticsSnap.docs.length;
  onProgress(`Matched ${matchedCount.toLocaleString()} logistics orders — clearing old data…`, 10);

  // Step 2: clear previous delivery data
  const existing = await getDocs(query(collection(db, 'deliveryShipments')));
  let cleared = 0;
  while (cleared < existing.docs.length) {
    const batch = writeBatch(db);
    existing.docs.slice(cleared, cleared + BATCH_SIZE).forEach(d => batch.delete(d.ref));
    await batch.commit();
    cleared += BATCH_SIZE;
  }

  // Step 3: transform and write
  const total = rows.length;
  let written = 0;
  while (written < total) {
    const chunk = rows.slice(written, written + BATCH_SIZE);
    const batch = writeBatch(db);
    chunk.forEach(rawRow => {
      const transformed = transformRow(rawRow, logisticsOrderMap);
      if (transformed.awb) {
        batch.set(doc(collection(db, 'deliveryShipments')), transformed);
      }
    });
    await batch.commit();
    written += chunk.length;
    onProgress(
      `Importing… ${written.toLocaleString()} / ${total.toLocaleString()} rows`,
      15 + Math.round((written / total) * 80),
    );
  }

  // Step 4: save import metadata
  const metaBatch = writeBatch(db);
  metaBatch.set(doc(collection(db, 'deliveryImports')), {
    rowCount:   total,
    logisticsMatched: Object.keys(logisticsOrderMap).length,
    importedAt: serverTimestamp(),
  });
  await metaBatch.commit();

  onProgress('Done!', 100);
  return { total, logisticsMatched: Object.keys(logisticsOrderMap).length };
}

// ─── COMPONENT ──────────────────────────────────────────────────────────────────
export default function DeliveryUploadTab() {
  const [file, setFile]               = useState(null);
  const [fileName, setFileName]       = useState('');
  const [parsedRows, setParsedRows]   = useState([]);
  const [parsedHeaders, setParsedHeaders] = useState([]);
  const [step, setStep]               = useState(1);
  const [missing, setMissing]         = useState([]);
  const [importing, setImporting]     = useState(false);
  const [progress, setProgress]       = useState({ label: '', pct: 0 });
  const [result, setResult]           = useState(null);
  const [dragOver, setDragOver]       = useState(false);

  function handleFile(f) {
    setFile(f);
    setFileName(f.name);
    setResult(null);

    const reader = new FileReader();
    reader.onload = (e) => {
      const { headers, rows } = parseCSV(e.target.result);
      setParsedHeaders(headers);
      setParsedRows(rows);
      const miss = EXPECTED_COLS.filter(c => !headers.includes(c));
      setMissing(miss);
      setStep(miss.length === 0 ? 3 : 2);
    };
    reader.readAsText(f);
  }

  function handleRemove() {
    setFile(null); setFileName('');
    setParsedRows([]); setParsedHeaders([]);
    setMissing([]); setStep(1); setResult(null);
    setProgress({ label: '', pct: 0 });
  }

  async function doImport() {
    setImporting(true);
    setProgress({ label: 'Starting…', pct: 2 });
    try {
      const res = await writeDeliveryData(parsedRows, (label, pct) =>
        setProgress({ label, pct })
      );
      setResult(res);
      setStep(4);
    } catch (err) {
      console.error('Delivery import error:', err);
      setProgress({ label: `Error: ${err.message}`, pct: 0 });
    } finally {
      setImporting(false);
    }
  }

  const previewRows = parsedRows.slice(0, 8);
  const previewCols = EXPECTED_COLS.filter(c => parsedHeaders.includes(c));

  return (
    <div className="section-card">
      <div className="section-card-header">
        <div>
          <div className="section-card-title">Delivery Upload</div>
          <div className="section-card-sub">
            Upload a delivery CSV — orders are matched to logistics assignments by Zain order number (Consignee Reference 1)
          </div>
        </div>
      </div>

      {/* Steps */}
      <div className="steps-bar" style={{ marginBottom: '24px' }}>
        {['Upload', 'Validate', 'Preview & Import'].map((label, i) => {
          const n    = i + 1;
          const done = step > n && step !== 4 ? true : step === 4;
          const active = step === n;
          return (
            <React.Fragment key={n}>
              <div className={`step${done ? ' done' : active ? ' active' : ''}`}>
                <div className="step-circle">
                  {done ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                  ) : n}
                </div>
                <div className="step-info"><div className="step-label">{label}</div></div>
              </div>
              {i < 2 && <div className="step-line" />}
            </React.Fragment>
          );
        })}
      </div>

      {/* Drop zone */}
      {step === 1 && (
        <div className="upload-card">
          <div
            className={`drop-zone${dragOver ? ' drag-over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
          >
            <input type="file" accept=".csv,.tsv,.txt" onChange={(e) => { if (e.target.files[0]) handleFile(e.target.files[0]); }} />
            <div className="drop-icon">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="17 8 12 3 7 8"/>
                <line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
            </div>
            <div className="drop-title">Drop your delivery CSV here</div>
            <div className="drop-sub">or <strong>click to browse</strong></div>
            <div className="drop-formats">
              <span className="fmt-tag">CSV</span>
              <span className="fmt-tag">TSV</span>
            </div>
          </div>
        </div>
      )}

      {/* File strip */}
      {file && step >= 2 && (
        <div className="upload-card">
          <div className="file-strip">
            <div className="file-strip-icon">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
              </svg>
            </div>
            <div className="file-strip-info">
              <div className="file-strip-name">{fileName}</div>
              <div className="file-strip-meta">
                {parsedRows.length.toLocaleString()} rows · {parsedHeaders.length} columns
              </div>
            </div>
            {!importing && (
              <button className="file-strip-remove" onClick={handleRemove} title="Remove" aria-label="Remove">×</button>
            )}
          </div>
        </div>
      )}

      {/* Missing columns warning */}
      {step === 2 && (
        <div className="section-card" style={{ marginTop: '16px', border: '1px solid rgba(231,76,60,0.3)', background: 'rgba(231,76,60,0.05)' }}>
          <div className="section-card-title" style={{ color: '#E74C3C', marginBottom: '8px' }}>Missing Columns</div>
          <p style={{ color: 'rgba(216,245,236,0.6)', fontSize: '13px', margin: '0 0 12px' }}>
            These expected columns were not found. Check the header row of your file.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            {missing.map(c => (
              <span key={c} style={{ padding: '4px 10px', borderRadius: '4px', fontSize: '12px', background: 'rgba(231,76,60,0.15)', color: '#E74C3C', border: '1px solid rgba(231,76,60,0.3)' }}>{c}</span>
            ))}
          </div>
          <p style={{ color: 'rgba(216,245,236,0.4)', fontSize: '12px', margin: '12px 0 0' }}>
            Columns found: {parsedHeaders.join(', ')}
          </p>
        </div>
      )}

      {/* Preview */}
      {step === 3 && !result && (
        <>
          <div style={{ marginTop: '16px' }}>
            <div className="section-header">
              <div>
                <div className="section-title">Data Preview</div>
                <div className="section-sub">First 8 rows · {parsedRows.length.toLocaleString()} total</div>
              </div>
            </div>
            <div className="table-wrap" style={{ overflowX: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    {previewCols.map(c => (
                      <th key={c} style={{ whiteSpace: 'nowrap', fontSize: '11px' }}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((row, i) => (
                    <tr key={i}>
                      {previewCols.map(c => (
                        <td key={c} style={{ fontSize: '12px', maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {row[c] || <span style={{ color: 'var(--text-dim)' }}>—</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="import-bar" style={{ marginTop: '20px' }}>
            <div className="import-bar-info">
              <span className="import-count">{parsedRows.length.toLocaleString()}</span>
              <span className="import-label">shipment rows · will join with logistics orders</span>
            </div>
            <button className="btn-primary" onClick={doImport} disabled={importing}>
              {importing ? 'Importing…' : 'Import to Delivery Dashboard'}
            </button>
          </div>

          {importing && (
            <div className="progress-wrap" style={{ marginTop: '12px' }}>
              <div className="progress-label">{progress.label}</div>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${progress.pct}%` }} />
              </div>
            </div>
          )}
        </>
      )}

      {/* Success */}
      {result && (
        <div style={{
          marginTop: '20px', padding: '28px', borderRadius: '12px',
          border: '1px solid rgba(46,204,138,0.3)', background: 'rgba(46,204,138,0.06)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px', textAlign: 'center',
        }}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--emerald)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
            <polyline points="22 4 12 14.01 9 11.01"/>
          </svg>
          <div>
            <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--emerald)' }}>
              {result.total.toLocaleString()} shipments imported
            </div>
            <div style={{ fontSize: '13px', color: 'rgba(216,245,236,0.5)', marginTop: '4px' }}>
              Matched against {result.logisticsMatched.toLocaleString()} logistics orders for delivery time calculation
            </div>
          </div>
          <button className="btn-primary" onClick={handleRemove} style={{ marginTop: '4px' }}>
            Upload Another File
          </button>
        </div>
      )}

      {/* Column reference */}
      <div style={{
        marginTop: '24px', padding: '16px', borderRadius: '8px',
        background: 'rgba(216,245,236,0.04)', border: '1px solid rgba(216,245,236,0.08)',
      }}>
        <div style={{ fontSize: '12px', fontWeight: 600, color: 'rgba(216,245,236,0.5)', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Expected Columns
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          {EXPECTED_COLS.map(c => (
            <span key={c} style={{
              padding: '3px 9px', borderRadius: '4px', fontSize: '11px',
              background: 'rgba(46,204,138,0.08)', color: 'rgba(216,245,236,0.6)',
              border: '1px solid rgba(46,204,138,0.15)',
            }}>{c}</span>
          ))}
        </div>
        <div style={{ fontSize: '11px', color: 'rgba(216,245,236,0.3)', marginTop: '10px' }}>
          Consignee Reference 1 is matched to the Zain order number in logistics orders to calculate AWB → logistics assignment time.
        </div>
      </div>
    </div>
  );
}
