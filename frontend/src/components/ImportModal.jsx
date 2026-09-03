import { useState, useRef } from 'react';
import { Upload, Check, X } from 'lucide-react';
import { Z_MODAL } from '../utils/zLayers';
import { useT } from '../utils/i18n';

// IMPORTING A COLLECTION FROM A FILE.
//
// Built to sketches/013-import-resolve. Two phases, because Zach reviews
// before he commits: preview resolves everything and writes nothing, then a
// second call adds the rows.
//
// He only imports from ManaBox, and MEASURED against the live catalogue,
// set+number is unique across all 105,480 printings while the Scryfall id is a
// primary key. So a clean ManaBox export never reaches the inline resolver at
// all -- it exists for hand-edited files, other tools, and quantity problems
// that have nothing to do with identity. The common case must therefore be
// invisible: a big number and one button.
//
// He asked for the preview to show even when nothing needs deciding: "Review/
// preview should still sell". An import is a large, silent state change
// otherwise.

const MAX_BYTES = 12 * 1024 * 1024;

// A CSV parser that handles quoted fields containing commas.
//
// ManaBox quotes card names with commas in them -- "Tony Stark, Iron Man" --
// and a naive split(',') turns one card into two broken columns. Card names
// with commas are common enough that this is the normal case, not an edge one.
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }   // escaped quote
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = '';
      if (row.some(v => v.trim() !== '')) rows.push(row);
      row = [];
    } else if (c !== '\r') {
      field += c;
    }
  }
  row.push(field);
  if (row.some(v => v.trim() !== '')) rows.push(row);

  if (rows.length < 2) return [];
  const header = rows[0].map(h => h.trim());
  return rows.slice(1).map(r => {
    const obj = {};
    header.forEach((h, i) => { obj[h] = (r[i] ?? '').trim(); });
    return obj;
  });
}

function ImportModal({ onClose, onImported, showToast }) {
  const { t } = useT();
  const [phase, setPhase] = useState('pick');      // pick | review | done
  const [busy, setBusy] = useState(false);
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState([]);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  // Row index -> { card_id, quantity } or { skip: true }
  const [choices, setChoices] = useState({});
  const fileRef = useRef(null);

  const readFile = async (file) => {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      showToast && showToast(t('import.errTooBig'));
      return;
    }
    setBusy(true);
    try {
      const parsed = parseCSV(await file.text());
      if (parsed.length === 0) {
        showToast && showToast(t('import.errEmpty'));
        setBusy(false);
        return;
      }
      setFileName(file.name);
      setRows(parsed);
      const res = await fetch('/api/import/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: parsed, format: 'manabox' })
      });
      const data = await res.json();
      if (!res.ok) {
        showToast && showToast(data.error || t('import.errPreview'));
        setBusy(false);
        return;
      }
      setPreview(data);
      setChoices({});
      setPhase('review');
    } catch (err) {
      showToast && showToast(err.message || t('import.errPreview'));
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows, format: 'manabox', resolutions: choices })
      });
      const data = await res.json();
      if (!res.ok) {
        showToast && showToast(data.error || t('import.errCommit'));
        setBusy(false);
        return;
      }
      setResult(data);
      setPhase('done');
      onImported && onImported();
    } catch (err) {
      showToast && showToast(err.message || t('import.errCommit'));
    } finally {
      setBusy(false);
    }
  };

  // How many rows will actually be added, counting the ones resolved here.
  // ROWS vs CARDS. A ManaBox export is one row per printing with a Quantity
  // column, so a playset of four is ONE row and FOUR cards. Showing rows under
  // the word "cards" made Zach think 1,029 of his cards had been dropped.
  const resolutions = Object.values(choices).filter(c => c && !c.skip);
  const rescued = resolutions.length;
  const rescuedCopies = resolutions.reduce((n, c) => n + Number(c.quantity || 1), 0);

  const rowsToAdd = (preview?.matched || 0) + rescued;
  const cardsToAdd = (preview?.copies || 0) + rescuedCopies;
  const unresolved = (preview?.rejections || [])
    .filter(r => !choices[r.row - 1]).length;

  const panel = {
    background: 'var(--surface-1)', border: '1px solid var(--border-glass)',
    borderRadius: 'var(--radius-md)', overflow: 'hidden', marginBottom: '0.75rem'
  };
  const head = {
    padding: '0.7rem 1rem', borderBottom: '1px solid var(--border-glass)',
    fontSize: '0.68rem', fontWeight: 800, letterSpacing: '0.07em',
    textTransform: 'uppercase', color: 'var(--text-muted)',
    display: 'flex', justifyContent: 'space-between', alignItems: 'baseline'
  };

  return (
    <div className="modal-overlay" style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)',
      backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center',
      justifyContent: 'center', zIndex: Z_MODAL,
      padding: 'max(0.75rem, env(safe-area-inset-top, 0px)) 0.75rem max(0.75rem, env(safe-area-inset-bottom, 0px))',
      boxSizing: 'border-box', overflow: 'hidden'
    }} onClick={onClose}>
      <div className="glass-panel" onClick={(e) => e.stopPropagation()} style={{
        width: '100%', maxWidth: 460, height: '88vh', maxHeight: '100dvh',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        padding: '1rem', boxSizing: 'border-box'
      }}>
        {/* Close sits IN THE FLOW, not absolutely positioned -- an absolute
            button follows the panel off-screen when the panel does not fit. */}
        <div style={{ display: 'flex', justifyContent: 'space-between',
                      alignItems: 'center', flex: '0 0 auto', marginBottom: '0.5rem' }}>
          <h3 style={{ fontSize: '1.15rem', fontWeight: 700, margin: 0 }}>
            {t('import.title')}
          </h3>
          <button type="button" className="btn btn-secondary btn-icon-only"
                  onClick={onClose} aria-label={t('common.close')}
                  style={{ borderRadius: '50%' }}>
            <X size={16} />
          </button>
        </div>

        <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>

          {phase === 'pick' && (
            <div style={{ textAlign: 'center', padding: '2rem 1rem' }}>
              <Upload size={40} style={{ color: 'var(--text-muted)', marginBottom: '1rem' }} />
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem',
                          marginBottom: '1.25rem', lineHeight: 1.5 }}>
                {t('import.pickHint')}
              </p>
              <input ref={fileRef} type="file" accept=".csv,text/csv"
                     style={{ display: 'none' }}
                     onChange={(e) => readFile(e.target.files?.[0])} />
              <button className="btn btn-primary" style={{ width: '100%', minHeight: 46 }}
                      disabled={busy} onClick={() => fileRef.current?.click()}>
                {busy ? t('import.reading') : t('import.chooseFile')}
              </button>
            </div>
          )}

          {phase === 'review' && preview && (
            <>
              {/* THE HEADLINE. For a clean ManaBox export this is the whole
                  screen: one number and one button. */}
              <div style={{ ...panel, padding: '1.4rem 1rem', textAlign: 'center' }}>
                <div style={{ fontSize: '2.6rem', fontWeight: 800, lineHeight: 1,
                              letterSpacing: '-0.03em', color: 'var(--accent-green)' }}>
                  {cardsToAdd.toLocaleString()}
                </div>
                <div style={{ color: 'var(--text-secondary)', fontSize: '0.88rem',
                              marginTop: '0.35rem' }}>
                  {t('import.readyToAdd')}
                </div>
                {/* Both numbers, always. A playset is one row and four cards,
                    and showing only one of them looks like the other went
                    missing. */}
                <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem',
                              marginTop: '0.5rem' }}>
                  {t('import.fromRows', { rows: rowsToAdd, total: preview.total })}
                </div>
                <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem',
                              marginTop: '0.15rem' }}>
                  {fileName}
                </div>
              </div>

              {unresolved > 0 && (
                <div style={{
                  background: 'rgba(248,113,113,0.08)',
                  border: '1px solid rgba(248,113,113,0.25)',
                  borderRadius: 'var(--radius-md)', padding: '0.8rem 1rem',
                  marginBottom: '0.75rem'
                }}>
                  <div style={{ fontSize: '0.88rem', fontWeight: 700,
                                color: 'var(--accent-red)', marginBottom: '0.2rem' }}>
                    {t('import.needsAttention', { count: unresolved })}
                  </div>
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                    {t('import.needsAttentionSub')}
                  </div>
                </div>
              )}

              {(preview.rejections || []).map(rej => (
                <RejectionRow
                  key={rej.row}
                  rejection={rej}
                  choice={choices[rej.row - 1]}
                  onChoose={(c) => setChoices(prev => ({ ...prev, [rej.row - 1]: c }))}
                  t={t}
                />
              ))}

              <div style={panel}>
                <div style={head}>
                  <span>{t('import.matchedCleanly')}</span>
                  <span style={{ fontWeight: 400, letterSpacing: 0, textTransform: 'none' }}>
                    {preview.matched.toLocaleString()}
                  </span>
                </div>
                <div style={{ padding: '0.75rem 1rem', fontSize: '0.8rem',
                              color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                  {t('import.matchedBy', {
                    id: preview.matchedBy?.scryfall_id || 0,
                    setnum: preview.matchedBy?.set_and_number || 0
                  })}
                </div>
              </div>
            </>
          )}

          {phase === 'done' && result && (
            <div style={{ ...panel, padding: '2rem 1rem', textAlign: 'center' }}>
              <div style={{ fontSize: '2.6rem', fontWeight: 800, lineHeight: 1,
                            letterSpacing: '-0.03em', color: 'var(--accent-green)' }}>
                +{(result.copies || result.inserted).toLocaleString()}
              </div>
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.88rem',
                            marginTop: '0.35rem' }}>
                {t('import.added')}
              </div>
              {result.rejected > 0 && (
                <div style={{ color: 'var(--text-muted)', fontSize: '0.76rem',
                              marginTop: '0.75rem' }}>
                  {t('import.skippedCount', { count: result.rejected })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Actions, fixed below the scrolling body. */}
        <div style={{ flex: '0 0 auto', display: 'flex', gap: '0.5rem', paddingTop: '0.75rem' }}>
          {phase === 'review' && (
            <>
              <button className="btn btn-secondary" style={{ flex: 1, minHeight: 46 }}
                      onClick={onClose} disabled={busy}>
                {t('common.cancel')}
              </button>
              <button className="btn btn-primary" style={{ flex: 2, minHeight: 46 }}
                      onClick={commit} disabled={busy || cardsToAdd === 0}>
                {busy ? t('import.adding') : t('import.addN', { count: cardsToAdd })}
              </button>
            </>
          )}
          {phase === 'done' && (
            <button className="btn btn-primary" style={{ flex: 1, minHeight: 46 }}
                    onClick={onClose}>
              {t('common.done')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ONE REJECTED ROW.
//
// A choice is offered ONLY where Bindarr knows the candidates. For a proxy or
// an unreadable quantity there is nothing to choose between, and a dropdown
// with one bad answer in it is worse than an honest "skipped".
function RejectionRow({ rejection, choice, onChoose, t }) {
  const candidates = rejection.candidates || [];
  const canQuantityFix = rejection.reason === 'bad_quantity';
  const decided = !!choice;

  return (
    <div style={{
      background: 'var(--surface-1)', border: '1px solid var(--border-glass)',
      borderRadius: 'var(--radius-md)', padding: '0.85rem 1rem',
      marginBottom: '0.75rem', opacity: decided ? 0.6 : 1
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between',
                    alignItems: 'baseline', gap: '0.6rem' }}>
        <span style={{ fontSize: '0.92rem', fontWeight: 650 }}>{rejection.card}</span>
        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', flexShrink: 0 }}>
          {t('import.rowN', { n: rejection.row })}
        </span>
      </div>
      <div style={{ fontSize: '0.78rem', color: 'var(--accent-yellow)', marginTop: '0.2rem' }}>
        {t(`import.reason.${rejection.reason}`, { detail: rejection.detail || '' })}
      </div>

      {decided ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem',
                      marginTop: '0.5rem', fontSize: '0.79rem', fontWeight: 600,
                      color: choice.skip ? 'var(--text-muted)' : 'var(--accent-green)' }}>
          {choice.skip ? t('import.skipped') : <><Check size={14} /> {choice.label}</>}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', marginTop: '0.6rem' }}>
          {candidates.slice(0, 4).map(c => (
            <button key={c.id} type="button" className="btn btn-secondary"
                    style={{ display: 'flex', alignItems: 'center', gap: '0.6rem',
                             width: '100%', textAlign: 'left', padding: '0.55rem 0.7rem',
                             borderRadius: 'var(--radius-sm)' }}
                    onClick={() => onChoose({
                      card_id: c.id,
                      quantity: rejection.quantity || 1,
                      label: `${(c.set_id || '').toUpperCase()} #${c.number}`
                    })}>
              <span style={{ flex: 1, fontSize: '0.8rem', fontWeight: 650 }}>
                {(c.set_id || '').toUpperCase()} #{c.number}
                <small style={{ display: 'block', fontSize: '0.68rem',
                                color: 'var(--text-muted)', fontWeight: 400 }}>
                  {c.set_name}
                </small>
              </span>
              {c.price_trend > 0 && (
                <span style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-secondary)' }}>
                  ${Number(c.price_trend).toFixed(2)}
                </span>
              )}
            </button>
          ))}

          {canQuantityFix && (
            <button type="button" className="btn btn-secondary"
                    style={{ width: '100%', padding: '0.55rem 0.7rem',
                             borderRadius: 'var(--radius-sm)', fontSize: '0.8rem' }}
                    onClick={() => onChoose({ quantity: 1, label: t('import.treatAsOne') })}>
              {t('import.treatAsOne')}
            </button>
          )}

          <button type="button"
                  style={{ background: 'none', border: 0, color: 'var(--text-muted)',
                           fontSize: '0.76rem', padding: '0.3rem 0 0', cursor: 'pointer',
                           textDecoration: 'underline', fontFamily: 'inherit' }}
                  onClick={() => onChoose({ skip: true })}>
            {t('import.skipRow')}
          </button>
        </div>
      )}
    </div>
  );
}

export default ImportModal;
