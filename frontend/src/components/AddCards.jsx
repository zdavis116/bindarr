import { useState, useEffect } from 'react';
import { Camera, Search } from 'lucide-react';
import CameraScanner from './CameraScanner';
import CardSearch from './CardSearch';
import { useT } from '../utils/i18n';

function AddCards({ onAddSuccess, showToast, setActiveTab, initialMode = 'scan' }) {
  const { t } = useT();
  const [mode, setMode] = useState(initialMode);

  // DESKTOP OPENS ON SEARCH, THE PHONE OPENS ON SCAN.
  //
  // sketches/desktop.html section 7: "search and results side by side; scan
  // still available. camera work belongs on the phone but shouldn't vanish."
  //
  // A laptop has no card in front of a camera; a phone does. Defaulting a wide
  // screen to a camera pane it will not use costs a click on every visit, and
  // the mockup draws Scan as a button beside the search, not the landing page.
  const [isWide, setIsWide] = useState(
    typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const mq = window.matchMedia('(min-width: 1024px)');
    const onChange = (e) => setIsWide(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  // Only when the caller did not ask for a specific mode -- a scan deep-link
  // must still land on the scanner.
  useEffect(() => {
    if (isWide && initialMode === 'scan') setMode('search');
  }, [isWide, initialMode]);

  // Demo build has no backend: the camera scanner and live card search can't
  // work, so show a notice instead of a broken UI.
  if (import.meta.env.VITE_DEMO) {
    return (
      <div className="glass-panel" style={{ maxWidth: '520px', margin: '2rem auto', padding: '2rem', textAlign: 'center' }}>
        <Camera size={40} style={{ color: 'var(--accent-yellow)', marginBottom: '1rem' }} />
        <h2 style={{ fontSize: '1.2rem', color: 'var(--text-strong)', marginBottom: '0.75rem' }}>{t('demo.unavailableTitle')}</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.5 }}>
          {t('demo.unavailableBody')}
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {/* The phone's mode switch. On desktop the header's Scan button does
          this job, and two sets of Scan controls on one screen is the
          duplication Zach keeps catching. */}
      <div className={`ac-modes${mode === 'search' ? ' ac-modes-hide' : ''}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', gap: '1rem', position: 'relative' }}>
        <div className="sub-nav-tabs" style={{ width: '100%', maxWidth: '400px', margin: 0 }}>
          <button 
            className={`sub-nav-tab ${mode === 'scan' ? 'active' : ''}`}
            onClick={() => setMode('scan')}
          >
            <Camera size={18} />
            <span>{t('addCards.scan')}</span>
          </button>
          <button
            className={`sub-nav-tab ${mode === 'search' ? 'active' : ''}`}
            onClick={() => setMode('search')}
          >
            <Search size={18} />
            <span>{t('addCards.search')}</span>
          </button>
        </div>
      </div>

      <div>
        {mode === 'scan' ? (
          <CameraScanner onAddSuccess={onAddSuccess} showToast={showToast} setActiveTab={setActiveTab} />
        ) : (
          <CardSearch
            onAddSuccess={onAddSuccess}
            showToast={showToast}
            setActiveTab={setActiveTab}
            /* The mockup's header buttons. Scan switches to the pane that
               already exists. Import goes to Collection, which owns the CSV /
               paste dialog -- setActiveTab is App's goTab and takes a tab name
               only, so it cannot carry which kind; checked rather than assumed,
               after shipping a dead onOpen call last week. */
            onOpenScan={() => setMode('scan')}
            onOpenImport={() => setActiveTab && setActiveTab('collection')}
          />
        )}
      </div>
    </div>
  );
}

export default AddCards;
