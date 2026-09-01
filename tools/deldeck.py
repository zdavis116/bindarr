p = 'frontend/src/components/DeckView.jsx'
s = open(p).read()

# DELETE HAD NO VISIBLE AFFORDANCE.
#
# Zach: "Doesn't appear a way to delete decks."
#
# It existed -- onContextMenu on the deck-list row, i.e. long-press. Nothing on
# screen said so. That is the TENTH control on this project that rendered, was
# wired correctly, passed every test and could not be found; the previous nine
# were hidden behind the nav bar or below the fold, and this one is hidden
# behind a gesture, which is the same failure with a different cause.
#
# A long-press is a shortcut for people who already know. It cannot be the only
# way to reach a destructive action.
#
# Put in the DECK VIEW, not the list: deleting from a list is a mis-tap waiting
# to happen, and the deck view is where you can see what you are about to
# destroy -- its name, its size, its commander.
old = "      {/* EXPORT MODAL"
new = """      {/* DELETE. Zach: "Doesn't appear a way to delete decks."
          It lives here rather than on the list row because this screen shows
          what is about to be destroyed. */}
      <button
        onClick={confirmDelete}
        disabled={busy}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.45rem',
          width: '100%', minHeight: 46, marginTop: '1.5rem',
          borderRadius: 'var(--radius-md)', border: '1px solid var(--accent-red)',
          background: 'transparent', color: 'var(--accent-red)',
          font: 'inherit', fontSize: '0.9rem', fontWeight: 600,
          cursor: busy ? 'wait' : 'pointer',
        }}
      >
        <Trash2 size={15} />
        {t('deck.deleteDeck')}
      </button>

      {/* EXPORT MODAL"""
assert s.count(old) == 1, 'export modal anchor not found'
s = s.replace(old, new, 1)

# The confirmation names the deck and its size. "Delete this deck?" is not
# enough when the answer costs a rebuild.
s = s.replace("  const missingCards = deckCards.filter(c => (c.quantity_missing || 0) > 0);",
              """  const confirmDelete = async () => {
    // NAMES the deck and states its size. A deck is minutes of work to
    // rebuild, and an unnamed "are you sure" is the same prompt whether it
    // holds two cards or a hundred.
    const total = deckCards.reduce((n, c) => n + (c.quantity || 0), 0);
    if (!window.confirm(t('deck.confirmDelete', { name: deck.name, count: total }))) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/decks/${deck.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || t('deck.deleteFailed'));
      }
      showToast(t('deck.deleted'), 'success');
      onBack();
    } catch (err) {
      showToast(err.message || t('deck.deleteFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const missingCards = deckCards.filter(c => (c.quantity_missing || 0) > 0);""", 1)
open(p, 'w').write(s)
print('delete added to the deck view')
