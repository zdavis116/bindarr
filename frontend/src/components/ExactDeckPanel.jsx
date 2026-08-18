import { useState, useEffect, useCallback } from 'react';
import { useT } from '../utils/i18n';
import { FINISHES, requirementStatus } from './exactDeckStatus';

// Minimal exact-finish deck UI (PR 6C).
//
// Deliberately small. Its whole job is to prove the exact-only model is usable
// end to end: create a deck, add a requirement by choosing a SPECIFIC printing
// and finish, and see what the server says about ownership and reservation.
// Full catalog search, import review and the buylist are PR 7 and are not here.
//
// The single most important rule in this file: it does NOT compute ownership,
// reservation or missing counts. Every one of those numbers is rendered exactly
// as the server sent it. The old deck builder recalculated them client-side,
// which meant the business rule existed in two places and the copy the user
// actually believed was the one on screen. When they disagreed, the screen won
// and the user made decisions on a number no server check agreed with.

function ExactDeckPanel({ showToast }) {
  const { t } = useT();
  const [decks, setDecks] = useState([]);
  const [activeDeck, setActiveDeck] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const [newDeckName, setNewDeckName] = useState('');
  const [newDeckStatus, setNewDeckStatus] = useState('active');

  // The add form requires BOTH fields with no default finish. That is a product
  // decision surfaced as a UI constraint: a defaulted finish is the app quietly
  // choosing a physical object for the user, who then discovers the mismatch
  // standing at their binder.
  const [printingId, setPrintingId] = useState('');
  const [finish, setFinish] = useState('');
  const [board, setBoard] = useState('mainboard');
  const [quantity, setQuantity] = useState(1);

  const notify = useCallback((message) => {
    if (showToast) showToast(message);
  }, [showToast]);

  const loadDecks = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/decks');
      if (!response.ok) throw new Error('load failed');
      setDecks(await response.json());
    } catch {
      notify(t('deck.errLoadDecks'));
    } finally {
      setLoading(false);
    }
  }, [notify, t]);

  const loadDeck = useCallback(async (deckId) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/decks/${deckId}`);
      if (!response.ok) throw new Error('load failed');
      setActiveDeck(await response.json());
    } catch {
      notify(t('deck.errLoadDetails'));
    } finally {
      setLoading(false);
    }
  }, [notify, t]);

  useEffect(() => { loadDecks(); }, [loadDecks]);

  const createDeck = async (event) => {
    event.preventDefault();
    if (!newDeckName.trim() || busy) return;
    setBusy(true);
    try {
      const response = await fetch('/api/decks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newDeckName.trim(), status: newDeckStatus })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        notify(body.error || t('deck.errCreate'));
        return;
      }
      setNewDeckName('');
      await loadDecks();
      await loadDeck(body.id);
    } finally {
      setBusy(false);
    }
  };

  const addRequirement = async (event) => {
    event.preventDefault();
    if (!activeDeck || busy) return;
    // Both halves of the identity are mandatory. Refusing here rather than
    // sending a partial request keeps the client and the server's NOT NULL
    // constraint telling the user the same story.
    if (!printingId.trim() || !finish) {
      notify('Choose both an exact printing and a finish.');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/decks/${activeDeck.id}/cards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          desired_card_id: printingId.trim(),
          desired_finish: finish,
          board,
          quantity: Number(quantity) || 1
        })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        notify(body.error || 'Failed to add card.');
        return;
      }
      // An unowned card SAVES. The warnings that come back are advice, not a
      // failure, so the form clears and the requirement appears either way.
      setPrintingId('');
      setFinish('');
      setQuantity(1);
      await loadDeck(activeDeck.id);
    } finally {
      setBusy(false);
    }
  };

  const removeRequirement = async (deckCardId) => {
    if (!activeDeck || busy) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/decks/${activeDeck.id}/cards/${deckCardId}`, { method: 'DELETE' });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        notify(body.error || 'Failed to remove requirement.');
        return;
      }
      await loadDeck(activeDeck.id);
    } finally {
      setBusy(false);
    }
  };

  const setDeckStatus = async (status) => {
    if (!activeDeck || busy) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/decks/${activeDeck.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        // The server refuses to park a checked-out deck. Surfacing its message
        // verbatim matters: it tells the user the concrete next step (return
        // the deck first) rather than a generic failure.
        notify(body.error || 'Failed to update deck.');
        return;
      }
      await loadDecks();
      await loadDeck(activeDeck.id);
    } finally {
      setBusy(false);
    }
  };

  const cards = activeDeck?.cards || [];
  const warnings = activeDeck?.warnings || [];

  return (
    <div className="exact-deck-panel">
      <section>
        <h2>Decks</h2>
        <form onSubmit={createDeck}>
          <input
            aria-label="Deck name"
            value={newDeckName}
            onChange={(e) => setNewDeckName(e.target.value)}
            placeholder="Deck name"
          />
          <select
            aria-label="Deck status"
            value={newDeckStatus}
            onChange={(e) => setNewDeckStatus(e.target.value)}
          >
            {/* The status wording states the CONSEQUENCE, not the jargon. The
                user needs to know that one option takes their cards and the
                other does not. */}
            <option value="active">Active — reserves cards now</option>
            <option value="considering">Considering — reserves nothing</option>
          </select>
          <button type="submit" disabled={busy || !newDeckName.trim()}>Create deck</button>
        </form>

        <ul>
          {decks.map((deck) => (
            <li key={deck.id}>
              <button type="button" onClick={() => loadDeck(deck.id)}>
                {deck.name}
              </button>
              <span>{deck.status}</span>
              <span>{deck.total_cards} cards</span>
              {deck.checked_out ? <span>Checked out</span> : null}
            </li>
          ))}
        </ul>
      </section>

      {activeDeck ? (
        <section>
          <h3>{activeDeck.name}</h3>
          <p>
            Status: {activeDeck.status}
            {activeDeck.status === 'active' ? (
              <button type="button" disabled={busy} onClick={() => setDeckStatus('considering')}>
                Park as considering
              </button>
            ) : (
              <button type="button" disabled={busy} onClick={() => setDeckStatus('active')}>
                Make active
              </button>
            )}
          </p>

          {/* Warnings are advisory and must never look like a blocked save.
              They are listed as information, with no error styling. */}
          {warnings.length > 0 ? (
            <ul aria-label="Deck warnings">
              {warnings.map((warning, index) => (
                <li key={`${warning.code}-${index}`}>{warning.message}</li>
              ))}
            </ul>
          ) : null}

          <form onSubmit={addRequirement}>
            <input
              aria-label="Exact printing ID"
              value={printingId}
              onChange={(e) => setPrintingId(e.target.value)}
              placeholder="Scryfall printing ID"
            />
            {/* No preselected finish: the empty option must be chosen away. */}
            <select aria-label="Finish" value={finish} onChange={(e) => setFinish(e.target.value)}>
              <option value="">Choose a finish…</option>
              {FINISHES.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <select aria-label="Board" value={board} onChange={(e) => setBoard(e.target.value)}>
              <option value="mainboard">Mainboard</option>
              <option value="commander">Commander</option>
              <option value="sideboard">Sideboard</option>
              <option value="considering">Considering</option>
            </select>
            <input
              aria-label="Quantity"
              type="number"
              min="1"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
            <button type="submit" disabled={busy || !printingId.trim() || !finish}>
              Add requirement
            </button>
          </form>

          <table>
            <thead>
              <tr>
                <th>Card</th>
                <th>Printing</th>
                <th>Finish</th>
                <th>Board</th>
                <th>Required</th>
                <th>Owned</th>
                <th>Reserved elsewhere</th>
                <th>Available</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {cards.map((card) => {
                const status = requirementStatus(card);
                return (
                  <tr key={card.id} data-tone={status.tone}>
                    <td>{card.name}</td>
                    {/* Set and collector number are shown always, not on hover.
                        Under exact-only identity the printing IS the identity,
                        so hiding it would hide the thing the user must match
                        against the card in their hand. */}
                    <td>{card.set_name} #{card.number}</td>
                    <td>{card.desired_finish}</td>
                    <td>{card.board}</td>
                    <td>{card.quantity_required}</td>
                    <td>{card.quantity_owned}</td>
                    <td>{card.quantity_allocated_elsewhere}</td>
                    <td>{card.quantity_available}</td>
                    {/* The status cell carries the tone so an unavailable
                        considering entry can be shown in red. The entry itself
                        is never removed or greyed out when its last copy is
                        taken -- the user is still considering it, they just
                        cannot fill it right now. */}
                    <td className={`exact-deck-status tone-${status.tone}`}>{status.label}</td>
                    <td>
                      <button type="button" disabled={busy} onClick={() => removeRequirement(card.id)}>
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {loading ? <p>Loading…</p> : null}
        </section>
      ) : null}
    </div>
  );
}

export default ExactDeckPanel;
