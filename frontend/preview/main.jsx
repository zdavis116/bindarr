// Mount the REAL DeckCompareModal with a REAL Mana Pool payload.
//
// The point of this harness is that it imports the shipping component and the
// shipping stylesheet. A hand-written HTML mock would let me approve a screen
// that does not exist.
import React from 'react';
import { createRoot } from 'react-dom/client';
import DeckCompareModal from '../src/components/DeckCompareModal.jsx';
import '../src/index.css';
import payload from './payload.json';

// The modal fetches on demand; stub fetch so search returns one result and
// selecting it returns the captured comparison. Branching on the URL keeps the
// component's real two-step flow intact rather than shortcutting past it.
window.fetch = async (url) => {
  if (String(url).includes('/search')) {
    return {
      ok: true,
      json: async () => ({
        total: 1,
        decks: [{
          id: payload.premade.id, theme: payload.premade.name,
          commander: 'Atraxa, Praetors\' Voice', bracket: 3,
          seller: 'Mana Pool', priceCents: 14235,
        }],
      }),
    };
  }
  return { ok: true, json: async () => payload };
};

function Harness() {
  const ref = React.useRef(false);
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => { if (!ref.current) { ref.current = true; setReady(true); } }, []);
  return ready ? (
    <DeckCompareModal
      deck={{ id: 1, name: 'AI Doom', cards: [{ board: 'commander', name: 'Atraxa, Praetors\' Voice' }] }}
      onClose={() => {}}
      showToast={() => {}}
    />
  ) : null;
}

createRoot(document.getElementById('root')).render(<Harness />);

// Drive it into the diff view so the screenshot shows the thing under review.
window.__showDiff = async () => {
  const btns = [...document.querySelectorAll('.mpc-search .btn')];
  btns[0]?.click();
  await new Promise((r) => setTimeout(r, 400));
  document.querySelector('.mpc-row')?.click();
};
