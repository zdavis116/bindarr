import { useMemo, useState } from 'react';
import { Flashlight, X, Search, Trash2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { sortForReview, isWeakMatch } from './scanStaging';

// THE DESKTOP SCANNER LAYOUT, transcribed from the mockup Zach approved:
//   sketches/scanner-desktop/c-balanced.html
//
// "Copy this mockup 1 to 1... and yeah don't touch the phone layout."
//
// WHAT THIS IS AND IS NOT. This component owns LAYOUT ONLY. It renders the
// camera the scanner already built and the staging rows the server already
// returns; it holds no scan state, opens no camera, and talks to no API. Every
// action is a callback handed down from CameraScanner, so the desktop and
// phone paths cannot drift into two behaviours -- which is the failure mode
// that produced two dedupe keys and duplicate staging in the first place.
//
// THE MOCKUP IS THE SPEC, and it stays the spec for as long as this is under
// review. Each numbered comment below cites the line it came from, so a later
// round can check the artifact rather than my memory of it.
//
// WHAT THE MOCKUP DOES NOT SHOW, kept from the shipping phone screen rather
// than invented here:
//   - weak matches ("Not fully confirmed -- worth a look" + Change)
//   - the per-row search fallback when no candidate is right
//   - removing a staged row
// The mockup was silent on these, and silence is not permission to drop a
// feature. They are placed in the same row idiom the mockup established.

const COLS = 6;   // img, card, set, finish, when, qty -- Status removed on request

function ago(ts) {
  // (mockup:231) relative time, refreshed by the parent's ticking clock.
  const s = Math.round((Date.now() - ts) / 1000);
  if (!Number.isFinite(s) || s < 0) return '';
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)}m ago`;
}

export default function DesktopScanLayout({
  // Camera side
  videoRef, scanStatus, cameraInfo, torchOn, onToggleTorch, onStopCamera,
  lastScanned,
  // Staging side
  entries, loading, busyId, error,
  onResolve, onSetQty, onRemove, onSearch, searchResults,
  onAddAll, onClear, onRefresh, committing,
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState(null);
  const [searchFor, setSearchFor] = useState(null);
  const [searchText, setSearchText] = useState('');

  const rows = useMemo(() => sortForReview(entries || []), [entries]);
  const unresolved = rows.filter(e => !e.card_id);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(e => (e.matched_name || e.name || '').toLowerCase().includes(q));
  }, [rows, query]);

  // (mockup:250) Add All is gated on unresolved rows, exactly as the phone
  // gates it. A row with no printing chosen cannot be committed.
  const blocked = unresolved.length > 0;

  return (
    <div className="dsk-scan">
      {/* (mockup:176) topbar */}
      <div className="dsk-topbar">
        <h1>{t('scan.title', 'Scan cards')}</h1>
        {cameraInfo?.width ? (
          <span className="dsk-chip">
            {cameraInfo.width}×{cameraInfo.height}
            {cameraInfo.frameRate ? ` · ${cameraInfo.frameRate}fps` : ''}
          </span>
        ) : null}
        <span className="dsk-sp" />
        <span className="dsk-chip">{t('scan.autoOn', 'Auto-scan on')}</span>
      </div>

      {/* (mockup:74) 520px camera column + table. The camera is a FIXED width,
          so every extra pixel on a wider monitor goes to the table -- that is
          the specific thing Zach asked for between A and B. */}
      <div className="dsk-split">
        <section className="dsk-camcol">
          <div className="dsk-camera">
            {/* The real video element, owned by CameraScanner. */}
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
                aria-label={t('scan.torch', 'Torch')} title={t('scan.torch', 'Torch')}
                style={torchOn ? { borderColor: 'var(--accent-yellow)', color: 'var(--accent-yellow)' } : undefined}>
                <Flashlight size={16} />
              </button>
              <button type="button" className="dsk-iconbtn" onClick={onStopCamera}
                aria-label={t('scan.stopCamera')} title={t('scan.stopCamera')}>
                <X size={16} />
              </button>
            </div>
            {/* (mockup:196) one status line, held by the parent. */}
            {scanStatus ? <div className="dsk-hint">{scanStatus}</div> : null}
          </div>

          {/* (mockup:200) LAST SCANNED. The part of variant A worth keeping at
              any camera size: a misread is visible while the card is still in
              your hand, rather than ten rows down the table. */}
          <div className="dsk-lastwrap">
            <div className="dsk-lastlbl">{t('scan.lastScanned', 'Last scanned')}</div>
            {lastScanned ? (
              <div className="dsk-lastcard">
                {lastScanned.crop || lastScanned.image_url ? (
                  <img src={lastScanned.crop || lastScanned.image_url} alt="" />
                ) : <div className="dsk-lastph" />}
                <div style={{ minWidth: 0 }}>
                  <div className="dsk-nm">{lastScanned.name || t('scan.unidentified', 'Unidentified card')}</div>
                  <div className={`dsk-mt${lastScanned.card_id ? '' : ' dsk-warn'}`}>
                    {lastScanned.card_id
                      ? `${(lastScanned.set_id || '').toUpperCase()}${lastScanned.number ? ` #${lastScanned.number}` : ''} · ${lastScanned.finish || 'nonfoil'}`
                      : t('scan.needsPrinting', 'Needs a printing chosen')}
                  </div>
                </div>
              </div>
            ) : (
              <div className="dsk-lastcard dsk-lastempty">
                {t('scan.nothingScanned', 'Nothing scanned yet.')}
              </div>
            )}
            <div className="dsk-sessions">
              <span><b>{rows.length}</b> {t('scan.staged', 'staged')}</span>
              <span>·</span>
              <span><b>{unresolved.length}</b> {t('scan.needPrinting', 'need a printing')}</span>
            </div>
          </div>
        </section>

        <section className="dsk-tablecol">
          {/* (mockup:216) toolbar */}
          <div className="dsk-toolbar">
            <input
              value={query} onChange={e => setQuery(e.target.value)}
              placeholder={t('scan.filterStaged', 'Filter staged cards…')}
            />
            <span className="dsk-sp" />
            <span className="dsk-count">
              {rows.length} {t('scan.staged', 'staged')}
              {unresolved.length ? <> · <span className="dsk-needs">
                {unresolved.length} {t('scan.needPrinting', 'need a printing')}
              </span></> : null}
            </span>
            <button type="button" className="dsk-iconbtn sm" onClick={onRefresh}
              aria-label={t('scan.reviewRefresh')} title={t('scan.reviewRefresh')}>
              <RefreshCw size={14} />
            </button>
          </div>

          <div className="dsk-tablewrap">
            <table className="dsk-table">
              <thead>
                <tr>
                  <th style={{ width: 50 }} />
                  <th>{t('scan.colCard', 'Card')}</th>
                  <th style={{ width: 150 }}>{t('scan.colSet', 'Set')}</th>
                  <th style={{ width: 100 }}>{t('scan.colFinish', 'Finish')}</th>
                  <th style={{ width: 80 }}>{t('scan.colWhen', 'When')}</th>
                  <th style={{ width: 130, textAlign: 'right' }}>{t('scan.colQty', 'Qty')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => {
                  const isUnresolved = !e.card_id;
                  const isWeak = !isUnresolved && isWeakMatch(e);
                  const open = openId === e.id;
                  return [
                    <tr
                      key={e.id}
                      className={`${isUnresolved ? 'attn' : ''}${e.id === lastScanned?.staged_id ? ' fresh' : ''}`}
                      onClick={() => setOpenId(open ? null : e.id)}
                    >
                      <td className="img">
                        {e.crop ? <img src={e.crop} alt="" /> : <div className="dsk-ph" />}
                      </td>
                      <td className="nm">
                        {e.matched_name || e.name || t('scan.unidentified', 'Unidentified card')}
                        {/* Kept from the phone: the mockup never showed a weak
                            match, and silence is not permission to drop it. */}
                        {isWeak && (
                          <div className="dsk-weak">
                            {t('scan.weakMatch', 'Not fully confirmed — worth a look')}
                          </div>
                        )}
                      </td>
                      <td className="set">
                        {isUnresolved
                          ? <span className="dsk-needs">{t('scan.needsPrintingShort', 'Needs printing')}</span>
                          : `${(e.set_id || '').toUpperCase()}${e.number ? ` #${e.number}` : ''}`}
                      </td>
                      <td className="fin">{e.finish || 'nonfoil'}</td>
                      <td className="when">{e.created_at ? ago(new Date(e.created_at).getTime()) : ''}</td>
                      <td className="qty">
                        <span className="dsk-qtyctl" onClick={ev => ev.stopPropagation()}>
                          <button type="button" onClick={() => onSetQty(e, e.quantity - 1)}
                            disabled={e.quantity <= 1 || busyId === e.id}
                            aria-label={t('scan.stagingQtyDown')}>–</button>
                          {e.quantity}
                          <button type="button" onClick={() => onSetQty(e, e.quantity + 1)}
                            disabled={busyId === e.id} aria-label={t('scan.stagingQtyUp')}>+</button>
                          <button type="button" className="dsk-del" onClick={() => onRemove(e)}
                            disabled={busyId === e.id} aria-label={t('scan.stagingRemove', 'Remove')}>
                            <Trash2 size={14} />
                          </button>
                        </span>
                      </td>
                    </tr>,
                    // (mockup:284) the printing fix, expanded INLINE beneath the
                    // row -- the dropdown Zach explicitly asked to keep.
                    open ? (
                      <tr key={`${e.id}-fix`} className="fixrow">
                        <td colSpan={COLS}>
                          <div className="dsk-fixbox" onClick={ev => ev.stopPropagation()}>
                            <div className="dsk-fixlbl">
                              {t('scan.choosePrinting', 'Choose the printing')}
                            </div>
                            {(e.candidates || []).map(c => (
                              <div key={c.id} className="dsk-cand"
                                onClick={() => { setOpenId(null); onResolve(e, c.id); }}>
                                <span>{c.name}</span>
                                <span className="set">
                                  {c.set_name || (c.set_id || '').toUpperCase()}
                                  {c.number ? ` · #${c.number}` : ''}
                                </span>
                              </div>
                            ))}
                            {!(e.candidates || []).length && (
                              <div className="dsk-nocand">
                                {t('scan.noCandidates', 'No suggestions — search for it instead.')}
                              </div>
                            )}
                            {/* Kept from the phone: a search fallback, because
                                the right printing is sometimes not among the
                                candidates at all. */}
                            <div className="dsk-searchrow">
                              <input
                                value={searchFor === e.id ? searchText : ''}
                                onFocus={() => setSearchFor(e.id)}
                                onChange={ev => { setSearchFor(e.id); setSearchText(ev.target.value); }}
                                placeholder={t('scan.searchPrinting', 'Search by name…')}
                              />
                              <button type="button" onClick={() => onSearch(e, searchText)}
                                disabled={!searchText.trim() || busyId === e.id}>
                                <Search size={14} />
                              </button>
                            </div>
                            {searchFor === e.id && (searchResults || []).map(r => (
                              <div key={r.id} className="dsk-cand"
                                onClick={() => { setOpenId(null); setSearchFor(null); onResolve(e, r.id); }}>
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
                {loading
                  ? t('scan.reviewLoading')
                  : rows.length
                    ? t('scan.noMatches', 'No matches.')
                    : t('scan.scannedAppearHere', 'Scanned cards appear here as you go.')}
              </div>
            )}
          </div>

          {/* (mockup:305) footer: note, Clear, Add all */}
          <div className="dsk-foot">
            <span className="dsk-count">
              {error
                ? <span className="dsk-needs">{error}</span>
                : rows.length === 0
                  ? t('scan.nothingStaged', 'Nothing staged yet')
                  : blocked
                    ? t('scan.needBeforeAdd', {
                        count: unresolved.length,
                        defaultValue: `${unresolved.length} need a printing before you can add`,
                      })
                    : t('scan.allResolved', 'All resolved')}
            </span>
            <span className="dsk-sp" />
            <button type="button" className="dsk-btn ghost" onClick={onClear}
              disabled={!rows.length || committing}>
              {t('scan.clear', 'Clear')}
            </button>
            <button type="button" className="dsk-btn primary" onClick={onAddAll}
              disabled={!rows.length || blocked || committing}>
              {blocked
                ? t('scan.fixFirst', { count: unresolved.length, defaultValue: `${unresolved.length} to fix first` })
                : t('scan.addAllN', { count: rows.length, defaultValue: `Add all (${rows.length})` })}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
