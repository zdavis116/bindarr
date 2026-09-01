p = 'frontend/src/components/NewDeckModal.jsx'
s = open(p).read()

# IMPORT A DECKLIST WHEN CREATING A DECK.
#
# Zach: "would be nice to have import functionality that allows you to import a
# deck list to create a deck from it."
#
# The machinery already exists and WORKS -- postImport, the preview/apply flow,
# per-line printing choices, the whole modal at DeckBuilder.jsx:1183. Nothing
# calls setShowImportModal(true), so it has been orphaned since the deck-list
# rebuild. Eleventh unreachable control on this project, and the first one that
# is an entire feature rather than a button.
#
# So this is not new machinery: it is an entry point. The new-deck modal gains
# a paste box, and on create the text is handed to the existing import.
old = """        <button
          type="submit\""""
new = """        {/* PASTE A DECKLIST. Optional -- an empty box creates an empty deck,
            which is the existing behaviour and stays the default path.

            The import runs AFTER the deck exists, because the endpoint is
            POST /api/decks/:id/import: there is no create-and-import call, and
            inventing one would mean a second write path to keep in step with
            the first. */}
        <label style={{ display: 'block', marginTop: '1rem' }}>
          <span style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600,
                         color: 'var(--text-secondary)', marginBottom: '0.35rem' }}>
            {t('deck.importOptional')}
          </span>
          <textarea
            value={decklist}
            onChange={(e) => setDecklist(e.target.value)}
            placeholder={'1 Sol Ring\\n1 Arcane Signet\\n10 Mountain'}
            rows={4}
            style={{ width: '100%', padding: '0.6rem 0.75rem',
                     borderRadius: 'var(--radius-md)',
                     border: '1px solid var(--border-glass)',
                     background: 'var(--surface-2)', color: 'var(--text-primary)',
                     font: 'inherit', fontSize: '0.85rem', lineHeight: 1.5,
                     resize: 'vertical', boxSizing: 'border-box' }}
          />
          <span style={{ display: 'block', fontSize: '0.72rem',
                         color: 'var(--text-muted)', marginTop: '0.3rem' }}>
            {t('deck.importHint')}
          </span>
        </label>

        <button
          type="submit\""""
assert s.count(old) == 1, 'submit button not found'
s = s.replace(old, new, 1)

s = s.replace("  const [commanderResults, setCommanderResults] = useState([]);",
              "  const [commanderResults, setCommanderResults] = useState([]);\n"
              "  // Optional decklist pasted at creation time. Empty = an empty deck,\n"
              "  // which stays the default path.\n"
              "  const [decklist, setDecklist] = useState('');", 1)
open(p, 'w').write(s)
print('decklist box added to the new-deck modal')
