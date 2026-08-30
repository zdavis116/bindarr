p = 'frontend/src/components/CollectionList.jsx'
s = open(p).read()

# Replace the single-value Set dropdown with multi-select chips.
old_set = """              <Field label={t('collection.fSet')}>
                <select className="select-control" value={setFilter} onChange={(e) => setSetFilter(e.target.value)}>
                  <option value="">{t('collection.allSets')}</option>
                  {uniqueSets.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </Field>"""

new_set = """              <Field label={t('collection.fSet')}>
                <ChipRow
                  options={uniqueSets}
                  selected={setFilters}
                  onToggle={(v) => setSetFilters(toggleIn(setFilters, v))}
                />
              </Field>"""
assert s.count(old_set) == 1, 'set dropdown not found'
s = s.replace(old_set, new_set)

old_type = """              <Field label={t('collection.fType')}>
                <select className="select-control" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                  <option value="">{t('collection.allTypes')}</option>
                  {uniqueTypes.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </Field>"""

new_type = """              {/* COLOUR IDENTITY, as WUBRG pips rather than a dropdown.
                  Players read colour as pips, not words, and five pips fit in
                  the space one dropdown would take. Multi-select with ANY-OF
                  semantics: tapping B and G shows black, green, and Golgari
                  cards -- which is what tapping two pips means. */}
              <Field label={t('collection.fColor')}>
                <div style={{ display: 'flex', gap: '0.35rem' }}>
                  {MTG_COLORS.map(({ code, label, token }) => {
                    const on = colorFilters.has(label);
                    return (
                      <button
                        key={code}
                        type="button"
                        aria-pressed={on}
                        title={label}
                        aria-label={label}
                        onClick={() => setColorFilters(toggleIn(colorFilters, label))}
                        style={{
                          width: 34, height: 34, minHeight: 34, borderRadius: '50%',
                          border: on ? '2px solid var(--text-primary)' : '2px solid var(--surface-2)',
                          background: on ? token : 'var(--surface-1)',
                          color: on ? '#1a1a1a' : 'var(--text-muted)',
                          fontWeight: 800, fontSize: '0.8rem', cursor: 'pointer',
                          padding: 0, transition: 'var(--transition-smooth)',
                        }}
                      >
                        {code}
                      </button>
                    );
                  })}
                </div>
              </Field>

              <Field label={t('collection.fType')}>
                <ChipRow
                  options={uniqueTypes}
                  selected={typeFilters}
                  onToggle={(v) => setTypeFilters(toggleIn(typeFilters, v))}
                />
              </Field>"""
assert s.count(old_type) == 1, 'type dropdown not found'
s = s.replace(old_type, new_type)

open(p, 'w').write(s)
print('set + type dropdowns -> chips; WUBRG pips added')
