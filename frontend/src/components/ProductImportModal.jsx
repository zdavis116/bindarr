// ADD A PRODUCT: pick a precon or a Secret Lair drop, check the list, add it.
//
// Zach: "adding cards to my collection through like precons, secret lair drops
// and my orders on manapool ... those lists are exactly what I would scan so
// would save me time."
//
// BUILT TO sketches/017-add-product, which he approved with:
//   "I love this mockup ... Build it EXACTLY to the mockup. Do NOT deviate."
// So the markup and class names below mirror that file, and the styles are
// ported verbatim into index.css under .pp-*. Where this file differs from the
// sketch, the sketch wins.
//
// Two steps, because he chose "show me the list first, let me confirm or untick
// cards, then add": nothing is written until the final button.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { X, Search, Package, AlertTriangle } from 'lucide-react';
import { useT } from '../utils/i18n';
import { groupIntoSections, sectionCardCount } from './deckListSections.js';

const KINDS = [
  { value: '', labelKey: 'product.kindAll' },
  { value: 'precon', labelKey: 'product.kindPrecon' },
  { value: 'secretlair', labelKey: 'product.kindSecretLair' },
  // Mana Pool orders live INSIDE this screen, as he asked -- "mana pool orders
  // should be in the add product section" -- rather than as another row in the
  // Add cards sheet. Disabled until the account key exists (phase 2); a control
  // that appears later is a surprise, a disabled one that says why is an answer.
  { value: 'orders', labelKey: 'product.kindOrders', soon: true },
];

// Section labels, from the SAME rule the deck view and compare screen use.
const SECTION_KEYS = {
  Commander: 'mpc.sectionCommander',
  Creature: 'mpc.sectionCreature',
  Instant: 'mpc.sectionInstant',
  Sorcery: 'mpc.sectionSorcery',
  Artifact: 'mpc.sectionArtifact',
  Enchantment: 'mpc.sectionEnchantment',
  Planeswalker: 'mpc.sectionPlaneswalker',
  Battle: 'mpc.sectionBattle',
  Land: 'mpc.sectionLand',
  Other: 'mpc.sectionOther',
};

export default function ProductImportModal({ onClose, onAdded, showToast }) {
  const { t } = useT();
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [groups, setGroups] = useState(null);
  const [searching, setSearching] = useState(false);

  // THE EDITION QUESTION. 332 of the 751 Secret Lair drops ship in a foil and a
  // nonfoil edition whose names differ only by a suffix, and picking wrong
  // records cards he does not own. Asked outright, with both answers side by
  // side, rather than as two near-identical rows in the results.
  const [editionFor, setEditionFor] = useState(null);

  const [detail, setDetail] = useState(null);      // the resolved card list
  const [loading, setLoading] = useState(false);
  const [excluded, setExcluded] = useState(() => new Set());
  const [adding, setAdding] = useState(false);

  const search = useCallback(async (q, k) => {
    setSearching(true);
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (k && k !== 'orders') params.set('kind', k);
      const res = await fetch(`/api/products?${params}`, { credentials: 'include' });
      const body = await res.json();
      // MTGJSON BEING DOWN MUST LOOK LIKE MTGJSON BEING DOWN. An empty list
      // would read as "no precons exist", which is a different and wrong
      // conclusion.
      if (!res.ok) throw new Error(body.error || t('product.errSearch'));
      setGroups(body.groups);
    } catch (err) {
      showToast(err.message || t('product.errSearch'), 'error');
      setGroups(null);
    } finally {
      setSearching(false);
    }
  }, [showToast, t]);

  // The picker opens with something in it rather than an empty box: the newest
  // products are the ones he is most likely to have just bought.
  useEffect(() => { search('', ''); }, [search]);

  const openProduct = async (product) => {
    setEditionFor(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/products/${encodeURIComponent(product.id)}/cards`,
        { credentials: 'include' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || t('product.errLoad'));
      setDetail(body);
      setExcluded(new Set());
    } catch (err) {
      showToast(err.message || t('product.errLoad'), 'error');
    } finally {
      setLoading(false);
    }
  };

  // A row is pickable only if the catalogue knows it. An unknown card is shown
  // and NAMED -- never silently dropped -- but it cannot be ticked, because
  // there is nothing to point a collection row at.
  const addable = useMemo(
    () => (detail?.cards || []).filter((c) => c.inCatalogue), [detail]);
  const missing = useMemo(
    () => (detail?.cards || []).filter((c) => !c.inCatalogue), [detail]);

  const chosen = useMemo(
    () => addable.filter((c) => !excluded.has(c.scryfallId)), [addable, excluded]);
  const chosenCards = chosen.reduce((n, c) => n + c.quantity, 0);

  const sections = useMemo(() => groupIntoSections(
    addable.map((c) => ({ ...c, typeLine: c.typeLine })),
    { sort: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) },
  ), [addable]);

  const toggle = (id) => setExcluded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const commit = async () => {
    setAdding(true);
    try {
      const res = await fetch(`/api/products/${encodeURIComponent(detail.product.id)}/add`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scryfall_ids: chosen.map((c) => c.scryfallId) }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || t('product.errAdd'));
      // The server's own count, not the one this screen hoped for.
      showToast(body.message, body.failed?.length ? 'warning' : 'success');
      onAdded && onAdded();
      onClose();
    } catch (err) {
      showToast(err.message || t('product.errAdd'), 'error');
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="modal-overlay pp-overlay" onClick={onClose}>
      <div className="glass-panel pp-panel" onClick={(e) => e.stopPropagation()}>
        <button className="btn btn-secondary btn-icon-only pp-close"
          onClick={onClose} aria-label={t('common.close')}>
          <X size={16} />
        </button>

        {!detail ? (
          <>
            <h3 className="pp-title">{t('product.title')}</h3>
            <p className="pp-sub">{t('product.subtitle')}</p>

            <div className="pp-search">
              <Search size={15} />
              <input
                className="pp-input"
                value={query}
                placeholder={t('product.searchPlaceholder')}
                onChange={(e) => { setQuery(e.target.value); search(e.target.value, kind); }}
              />
            </div>

            <div className="pp-chips">
              {KINDS.map((k) => (
                <button
                  key={k.value || 'all'}
                  type="button"
                  className={`pp-chip${kind === k.value ? ' on' : ''}${k.soon ? ' soon' : ''}`}
                  disabled={k.soon}
                  title={k.soon ? t('product.ordersSoon') : undefined}
                  onClick={() => { setKind(k.value); search(query, k.value); }}
                >
                  {t(k.labelKey)}
                </button>
              ))}
            </div>

            {searching && <p className="pp-empty">{t('product.searching')}</p>}

            {!searching && groups && groups.length === 0 && (
              <p className="pp-empty">{t('product.noResults')}</p>
            )}

            {!searching && groups && groups.length > 0 && (
              <div className="pp-results">
                {groups.map((g) => (
                  <div key={`${g.kind}:${g.base}`}>
                    <button type="button" className="pp-prod" disabled={loading}
                      onClick={() => (g.editions.length > 1
                        ? setEditionFor(editionFor?.base === g.base ? null : g)
                        : openProduct(g.editions[0]))}>
                      <span className="pp-pmain">
                        <span className="pp-pname">{g.base}</span>
                        <span className="pp-pmeta">
                          {g.kind === 'precon' ? t('product.kindPrecon') : t('product.kindSecretLair')}
                          {/* The SET NAME, not the three-letter code. Zach
                              searched "Duskmourn" and got nothing; showing
                              "DSC" would not have told him why a result
                              matched either. */}
                          {g.editions[0].setName ? ` · ${g.editions[0].setName}` : ''}
                          {g.editions.length > 1 ? ` · ${t('product.nEditions', { n: g.editions.length })}` : ''}
                        </span>
                      </span>
                      <Package size={15} className="pp-picon" />
                    </button>

                    {/* THE EDITION CHOICE, inline under the row it belongs to. */}
                    {editionFor?.base === g.base && (
                      <div className="pp-editionbox">
                        <div className="pp-editionq">
                          {t('product.whichEdition', { name: g.base })}
                        </div>
                        <div className="pp-editionwhy">{t('product.editionWhy')}</div>
                        <div className="pp-edopts">
                          {g.editions.map((e) => {
                            const isFoil = /foil/i.test(e.name);
                            return (
                              <button key={e.id} type="button" className="pp-edopt"
                                onClick={() => openProduct(e)}>
                                <span className={`pp-edswatch ${isFoil ? 'foil' : 'plain'}`}>
                                  {isFoil ? t('product.foil') : t('product.nonfoil')}
                                </span>
                                <span className="pp-edname">{e.name}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {loading && <p className="pp-empty">{t('product.loading')}</p>}
          </>
        ) : (
          <>
            <h3 className="pp-title">{detail.product.name}</h3>
            <p className="pp-sub">
              {detail.product.kind === 'precon'
                ? t('product.kindPrecon') : t('product.kindSecretLair')}
              {detail.product.setName ? ` · ${detail.product.setName}` : ''}
            </p>

            {/* THE HONEST FAILURE, screen 4 of the mockup. A silently dropped
                card means a 98-card precon and no idea which two are gone. */}
            {missing.length > 0 && (
              <p className="pp-notice">
                <AlertTriangle size={15} />
                <span>{t('product.missingNotice', { n: detail.missingCount })}</span>
              </p>
            )}

            <div className="pp-summary">
              <span className="pp-bignum">{chosenCards}</span>
              <span className="pp-bigsub">{t('product.cardsToAdd')}</span>
            </div>

            <div className="pp-selbar">
              <button type="button" onClick={() => setExcluded(new Set())}>
                {t('product.selectAll')}
              </button>
              <button type="button"
                onClick={() => setExcluded(new Set(addable.map((c) => c.scryfallId)))}>
                {t('product.clearAll')}
              </button>
              <span className="pp-spacer" />
              <span className="pp-selcount">
                {t('product.nOfN', { n: chosen.length, of: addable.length })}
              </span>
            </div>

            <div className="pp-scroll">
              {sections.map((s) => (
                <div key={s.name} className="pp-sec">
                  <div className="pp-sechead">
                    <span>{t(SECTION_KEYS[s.name] || 'mpc.sectionOther')}</span>
                    <span>{sectionCardCount(s.cards)}</span>
                  </div>
                  {s.cards.map((c) => (
                    <label key={c.scryfallId} className="pp-row">
                      <input type="checkbox"
                        checked={!excluded.has(c.scryfallId)}
                        onChange={() => toggle(c.scryfallId)} />
                      <span className="pp-tick" />
                      <span className="pp-qty">{c.quantity}&times;</span>
                      <span className="pp-cname">{c.name}</span>
                      {c.finish !== 'nonfoil' && (
                        <span className="pp-foil">
                          {c.finish === 'etched' ? t('product.etched') : t('product.foil')}
                        </span>
                      )}
                    </label>
                  ))}
                </div>
              ))}

              {missing.length > 0 && (
                <div className="pp-sec">
                  <div className="pp-sechead pp-sechead-bad">
                    <span>{t('product.cannotAdd')}</span>
                    <span>{detail.missingCount}</span>
                  </div>
                  {missing.map((c) => (
                    <div key={`${c.name}-${c.number}`} className="pp-row pp-row-bad">
                      <span className="pp-tick pp-tick-bad" />
                      <span className="pp-qty">{c.quantity}&times;</span>
                      <span className="pp-cname">{c.name}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="pp-cta">
              <button type="button" className="btn btn-secondary pp-big"
                onClick={() => setDetail(null)}>{t('product.back')}</button>
              <button type="button" className="btn btn-primary pp-big pp-primary"
                disabled={adding || chosen.length === 0}
                onClick={commit}>
                {adding ? t('product.adding') : t('product.addN', { n: chosenCards })}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
