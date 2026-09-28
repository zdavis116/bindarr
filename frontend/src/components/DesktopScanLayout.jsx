import { useCallback, useEffect, useMemo, useState } from 'react';
import { Flashlight, X, Search, Trash2, RefreshCw, Check } from 'lucide-react';
import { useT } from '../utils/i18n';
import { sortForReview, isWeakMatch } from './scanStaging';

// THE DESKTOP SCANNER LAYOUT, transcribed from the mockup Zach approved:
//   sketches/scanner-desktop/c-balanced.html
//
// "Copy this mockup 1 to 1... and yeah don't touch the phone layout."
//
// IT TAKES THE SAME `staging` OBJECT ScanStagingReview TAKES, and calls the
// same methods in the same order. That is deliberate and it is the most
// important decision in this file: an invented callback contract would be a
// SECOND implementation of staging, and two implementations of one surface is
// precisely what produced two dedupe keys and duplicated every card Zach
// scanned. Layout is the only thing that differs between phone and desktop.
//
// THE MOCKUP IS THE SPEC, and stays the spec while this is under review. The
// (mockup:NN) citations point at the approved file so a later round can check
// the artifact instead of my memory of it -- the discipline this port kept
// failing.
//
// WHAT THE MOCKUP DID NOT SHOW, kept from the shipping phone screen rather
// than dropped by omission: weak-match warnings, the per-row search fallback,
// and removing a staged row.

const COLS = 6;   // img, card, set, finish, when, qty -- Status removed on request

function ago(ts) {
  // (mockup:231) relative time. Recomputed on a tick so it stays honest.
  const s = Math.round((Date.now() - ts) / 1000);
  if (!Number.isFinite(s) || s < 0) return '';
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)}m ago`;
}

export default function DesktopScanLayout({
  staging,
  videoRef, scanStatus, cameraInfo, torchOn, onToggleTorch, onStopCamera,
  lastScanned, onCommitted, onSearchPrintings,
}) {
  const { t } = useT();
  const [state, setState] = useState(staging.getState());
  const [busyId, setBusyId] = useState(null);
  const [committing, setCommitting] = useState(false);
  const [result, setResult] = useState(null);
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState(null);
  const [searchText, setSearchText] = useState('');
  const [searchHits, setSearchHits] = useState([]);
  const [tick, setTick] = useState(0);

  const sync = useCallback(async () => { setState(await staging.refresh()); }, [staging]);

  // Read from the server on mount, exactly as the phone's review does: the
  // screen keeps no memory of its own, so a reload cannot lose the session.
  useEffect(() => { sync(); }, [sync]);

  // The When column would otherwise freeze at the value each row had when it
  // was rendered. A 20s tick is enough for "just now / 40s ago / 3m ago".
  useEffect(() => {
    const id = setInterval(() => setTick(v => v + 1), 20000);
    return () => clearInterval(id);
  }, []);

  // A new scan lands in `staging` without this component re-rendering, because
  // the state lives outside React. The parent bumps lastScanned on every
  // staged card, so that is the signal to re-read.
  useEffect(() => {
    if (lastScanned) setState(staging.getState());
  }, [lastScanned, staging]);

  const rows = useMemo(() => sortForReview(state.entries || []), [state.entries]);
  const unresolved = rows.filter(e => !e.card_id);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(e => (e.matched_name || e.name || '').toLowerCase().includes(q));
  }, [rows, query]);

  // (mockup:250) Add All is gated on unresolved rows, as the phone gates it.
  const blocked = unresolved.length > 0;

  const resolve = async (entry, cardId) => {
    setBusyId(entry.id);
    await staging.resolveEntry(entry.id, cardId);
    setBusyId(null);
    setOpenId(null);
    setSearchHits([]);
    setState(staging.getState());
  };
  const setQty = async (entry, quantity) => {
    if (quantity < 1) return;
    setBusyId(entry.id);
    await staging.updateEntry(entry.id, { quantity });
    setBusyId(null);
    setState(staging.getState());
  };
  const discard = async (entry) => {
    setBusyId(entry.id);
    await staging.discardEntry(entry.id);
    setBusyId(null);
    setState(staging.getState());
  };
  const commit = async () => {
    setCommitting(true);
    const r = await staging.commitAll();
    setCommitting(false);
    setState(staging.getState());
    // A stack of forty cards vanishing with no confirmation is the silent
    // state change Zach does not accept from software tracking real objects.
    if (r.ok) { setResult({ ok: true, committed: r.committed }); if (onCommitted) onCommitted(r.committed); }
    else { setResult(null); }
  };
  const runSearch = async (entry) => {
    if (!searchText.trim() || !onSearchPrintings) return;
    setBusyId(entry.id);
    setSearchHits(await onSearchPrintings(searchText.trim()));
    setBusyId(null);
  };

  return (
    <div className="dsk-scan">
      {/* (mockup:176) topbar */}
      <div className="dsk-topbar">
        <h1>{t('scan.title')}</h1>
        {cameraInfo?.width ? (
          <span className="dsk-chip">
            {cameraInfo.width}×{cameraInfo.height}
            {cameraInfo.frameRate ? ` · ${cameraInfo.frameRate}fps` : ''}
          </span>
        ) : null}
        <span className="dsk-sp" />
        <span className="dsk-chip">{t('scan.autoOn')}</span>
      </div>

      {/* (mockup:74) 520px camera column + table. FIXED width, so every extra
          pixel on a wider monitor goes to the table -- the exact thing asked
          for between variants A and B. */}
      <div className="dsk-split">
        <section className="dsk-camcol">
          <div className="dsk-camera">
            <video ref={videoRef} autoPlay playsInline muted className="dsk-feed" />
            <div className="dsk-guide">
              <span className="dsk-corner tl" /><span className="dsk-corner tr" />
              <span className="dsk-corner bl" /><span className="dsk-corner br" />
            </div>
            {cameraInfo?.width ? (
              <div className="dsk-camstat">{cameraInfo.width}×{cameraInfo.height}</div>
            ) : null}
            <div className="dsk-camctl">
              <button type="button" className="dsk-iconbtn" onClick={onToggleTorch}
                aria-label={t('scan.torch')} title={t('scan.torch')}
                style={torchOn ? { borderColor: 'var(--accent-yellow)', color: 'var(--accent-yellow)' } : undefined}>
                <Flashlight size={16} />
              </button>
              <button type="button" className="dsk-iconbtn" onClick={onStopCamera}
                aria-label={t('scan.stopCamera')} title={t('scan.stopCamera')}>
                <X size={16} />
              </button>
            </div>
            {scanStatus ? <div className="dsk-hint">{scanStatus}</div> : null}
          </div>

          {/* (mockup:200) LAST SCANNED -- the part of variant A worth keeping
              at any camera size: a misread is visible while the card is still
              in your hand, not ten rows down the table. */}
          <div className="dsk-lastwrap">
            <div className="dsk-lastlbl">{t('scan.lastScanned')}</div>
            {lastScanned ? (
              <div className="dsk-lastcard">
                {lastScanned.crop || lastScanned.image_url
                  ? <img src={lastScanned.crop || lastScanned.image_url} alt="" />
                  : <div className="dsk-lastph" />}
                <div style={{ minWidth: 0 }}>
                  <div className="dsk-nm">{lastScanned.name || t('scan.unidentified')}</div>
                  <div className={`dsk-mt${lastScanned.card_id ? '' : ' dsk-warn'}`}>
                    {lastScanned.card_id
                      ? `${(lastScanned.set_id || '').toUpperCase()}${lastScanned.number ? ` #${lastScanned.number}` : ''} · ${lastScanned.finish || 'nonfoil'}`
                      : t('scan.needsPrinting')}
                  </div>
                </div>
              </div>
            ) : (
              <div className="dsk-lastcard dsk-lastempty">
                {t('scan.nothingScanned')}
              </div>
            )}
            <div className="dsk-sessions">
              <span><b>{rows.length}</b> {t('scan.staged')}</span>
              <span>·</span>
              <span><b>{unresolved.length}</b> {t('scan.needPrinting')}</span>
            </div>
          </div>
        </section>

        <section className="dsk-tablecol">
          {/* (mockup:216) toolbar */}
          <div className="dsk-toolbar">
            <input value={query} onChange={e => setQuery(e.target.value)}
              placeholder={t('scan.filterStaged')} />
            <span className="dsk-sp" />
            <span className="dsk-count">
              {rows.length} {t('scan.staged')}
              {unresolved.length ? <> · <span className="dsk-needs">
                {unresolved.length} {t('scan.needPrinting')}
              </span></> : null}
            </span>
            <button type="button" className="dsk-iconbtn sm" onClick={sync}
              aria-label={t('scan.reviewRefresh')} title={t('scan.reviewRefresh')}>
              <RefreshCw size={14} />
            </button>
          </div>

          <div className="dsk-tablewrap">
            <table className="dsk-table">
              <thead>
                <tr>
                  <th style={{ width: 50 }} />
                  <th>{t('scan.colCard')}</th>
                  <th style={{ width: 150 }}>{t('scan.colSet')}</th>
                  <th style={{ width: 100 }}>{t('scan.colFinish')}</th>
                  <th style={{ width: 80 }}>{t('scan.colWhen')}</th>
                  <th style={{ width: 130, textAlign: 'right' }}>{t('scan.colQty')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => {
                  const isUnresolved = !e.card_id;
                  const isWeak = !isUnresolved && isWeakMatch(e);
                  const open = openId === e.id;
                  const when = e.created_at ? ago(new Date(e.created_at).getTime()) : '';
                  return [
                    <tr key={e.id}
                      className={`${isUnresolved ? 'attn' : ''}${e.id === lastScanned?.staged_id ? ' fresh' : ''}`}
                      onClick={() => setOpenId(open ? null : e.id)}>
                      <td className="img">
                        {e.crop ? <img src={e.crop} alt="" /> : <div className="dsk-ph" />}
                      </td>
                      <td className="nm">
                        {e.matched_name || e.name || t('scan.unidentified')}
                        {isWeak && (
                          <div className="dsk-weak">
                            {t('scan.weakMatch')}
                          </div>
                        )}
                      </td>
                      <td className="set">
                        {isUnresolved
                          ? <span className="dsk-needs">{t('scan.needsPrintingShort')}</span>
                          : `${(e.set_id || '').toUpperCase()}${e.number ? ` #${e.number}` : ''}`}
                      </td>
                      <td className="fin">{e.finish || 'nonfoil'}</td>
                      <td className="when" data-tick={tick}>{when}</td>
                      <td className="qty">
                        <span className="dsk-qtyctl" onClick={ev => ev.stopPropagation()}>
                          <button type="button" onClick={() => setQty(e, e.quantity - 1)}
                            disabled={e.quantity <= 1 || busyId === e.id}
                            aria-label={t('scan.stagingQtyDown')}>–</button>
                          {e.quantity}
                          <button type="button" onClick={() => setQty(e, e.quantity + 1)}
                            disabled={busyId === e.id} aria-label={t('scan.stagingQtyUp')}>+</button>
                          <button type="button" className="dsk-del" onClick={() => discard(e)}
                            disabled={busyId === e.id} aria-label={t('scan.stagingRemove')}>
                            <Trash2 size={14} />
                          </button>
                        </span>
                      </td>
                    </tr>,
                    // (mockup:284) the printing fix, expanded INLINE beneath
                    // the row -- the dropdown Zach asked to keep.
                    open ? (
                      <tr key={`${e.id}-fix`} className="fixrow">
                        <td colSpan={COLS}>
                          <div className="dsk-fixbox" onClick={ev => ev.stopPropagation()}>
                            <div className="dsk-fixlbl">{t('scan.choosePrinting')}</div>
                            {(e.candidates || []).map(c => (
                              <div key={c.id} className="dsk-cand" onClick={() => resolve(e, c.id)}>
                                <span>{c.name}</span>
                                <span className="set">
                                  {c.set_name || (c.set_id || '').toUpperCase()}
                                  {c.number ? ` · #${c.number}` : ''}
                                </span>
                              </div>
                            ))}
                            {!(e.candidates || []).length && (
                              <div className="dsk-nocand">
                                {t('scan.noCandidates')}
                              </div>
                            )}
                            {/* Kept from the phone: the right printing is
                                sometimes not among the candidates at all. */}
                            <div className="dsk-searchrow">
                              <input value={searchText}
                                onChange={ev => setSearchText(ev.target.value)}
                                onKeyDown={ev => { if (ev.key === 'Enter') runSearch(e); }}
                                placeholder={t('scan.searchPrinting')} />
                              <button type="button" onClick={() => runSearch(e)}
                                disabled={!searchText.trim() || busyId === e.id}>
                                <Search size={14} />
                              </button>
                            </div>
                            {searchHits.map(r => (
                              <div key={r.id} className="dsk-cand" onClick={() => resolve(e, r.id)}>
                                <span>{r.name}</span>
                                <span className="set">
                                  {r.set_name || (r.set_id || '').toUpperCase()}
                                  {r.number ? ` · #${r.number}` : ''}
                                </span>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ) : null,
                  ];
                })}
              </tbody>
            </table>
            {!shown.length && (
              <div className="dsk-empty">
                {state.loading
                  ? t('scan.reviewLoading')
                  : rows.length
                    ? t('scan.noMatches')
                    : t('scan.scannedAppearHere')}
              </div>
            )}
          </div>

          {/* (mockup:305) footer */}
          <div className="dsk-foot">
            <span className="dsk-count">
              {state.error
                ? <span className="dsk-needs">{t('scan.stagingCommitFailed', { error: state.error })}</span>
                : result?.ok
                  ? <span className="dsk-ok"><Check size={13} /> {t('scan.stagingCommitted', { count: result.committed })}</span>
                  : rows.length === 0
                    ? t('scan.nothingStaged')
                    : blocked
                      ? `${unresolved.length} ${t('scan.needBeforeAdd')}`
                      : t('scan.allResolved')}
            </span>
            <span className="dsk-sp" />
            <button type="button" className="dsk-btn ghost"
              onClick={async () => { await staging.discardAll(); setState(staging.getState()); }}
              disabled={!rows.length || committing}>
              {t('scan.clear')}
            </button>
            <button type="button" className="dsk-btn primary" onClick={commit}
              disabled={!rows.length || blocked || committing}>
              {committing
                ? t('scan.adding')
                : blocked
                  ? `${unresolved.length} ${t('scan.fixFirst')}`
                  : `${t('scan.addAll')} (${rows.length})`}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
