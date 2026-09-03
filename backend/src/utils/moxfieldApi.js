// Client for Moxfield's read-only endpoints (api2.moxfield.com).
//
// Moxfield publishes no API contract. These are the endpoints its own website
// calls; they answer without authentication, and they are what every community
// tool uses. Treat them as unstable: they can change without notice, and this
// module's job is to fail LOUDLY when they do rather than return something
// plausible. A stale decklist presented as current is the wrong-record failure
// Zach cares most about.
//
// BROWSER HEADERS ARE REQUIRED. Measured from this container:
//
//     no headers            -> HTTP 403
//     Accept: json only     -> HTTP 403
//     full browser headers  -> HTTP 200
//
// Cloudflare fronts the API and screens on client hints. Brenttime's fork also
// vendors `curl-impersonate` to spoof Chrome's TLS fingerprint, because their
// container ships OpenSSL 3.0.x which gets challenged. Ours is curl 8.14.1 /
// OpenSSL 3.5.6 and passes with headers alone -- verified against all three of
// Zach's decks -- so we do NOT vendor a pinned binary. If that changes, this is
// the one file to revisit.
const { execFile } = require('child_process');

const BASE_URL = process.env.MOXFIELD_API_BASE || 'https://api2.moxfield.com';
const TIMEOUT_S = 30;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
              + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  Referer: 'https://www.moxfield.com/',
  Accept: 'application/json'
};

class MoxfieldError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'MoxfieldError';
    this.status = status;
  }
}

// One GET via curl. `-w '\n%{http_code}'` appends the status on its own line so
// a challenge page and its code arrive together -- node's own HTTP stack is not
// used because the header set above is what gets us past Cloudflare and curl
// makes that explicit and auditable.
function httpGet(path, params) {
  const url = new URL(path, BASE_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
  }
  const args = ['-sS', '-X', 'GET', '--max-time', String(TIMEOUT_S), '-w', '\n%{http_code}'];
  for (const [k, v] of Object.entries(HEADERS)) args.push('-H', `${k}: ${v}`);
  args.push(url.toString());

  return new Promise((resolve, reject) => {
    execFile('curl', args,
      { maxBuffer: 32 * 1024 * 1024, timeout: (TIMEOUT_S + 5) * 1000 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new MoxfieldError(
            `Could not reach Moxfield: ${String(stderr || err.message).slice(0, 200)}`, 0));
          return;
        }
        const out = String(stdout);
        const nl = out.lastIndexOf('\n');
        const body = out.slice(0, nl);
        const status = parseInt(out.slice(nl + 1), 10) || 0;

        // A 403 is Cloudflare, not a missing deck. Naming it matters: the user
        // must be able to tell "Moxfield blocked us" from "your deck is gone",
        // because those call for opposite reactions.
        if (status === 403) {
          reject(new MoxfieldError(
            'Moxfield blocked the request (Cloudflare or rate limit). Nothing was changed.', 403));
          return;
        }
        if (status === 404) {
          reject(new MoxfieldError('Moxfield returned 404 (deck or user not found)', 404));
          return;
        }
        if (status < 200 || status >= 300) {
          reject(new MoxfieldError(`Moxfield returned HTTP ${status}`, status));
          return;
        }
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch {
          // 200 with a non-JSON body means an interstitial slipped through.
          // Refusing is the only safe reading: parsing junk into a decklist is
          // how a deck silently loses cards.
          reject(new MoxfieldError('Moxfield returned a non-JSON body (HTTP 200)', 200));
        }
      });
  });
}

// Resolve a username to Moxfield's canonical spelling.
async function getUser(username) {
  const data = await httpGet('/v2/users/search-sfw', {
    filter: username, pageNumber: 1, pageSize: 10
  });
  const entries = data.data || [];
  const match = entries.find(
    e => String(e.userName || '').toLowerCase() === String(username).toLowerCase());
  if (!match || !match.userName) {
    throw new MoxfieldError(`Moxfield has no user named "${username}"`, 404);
  }
  // Exact match only. `entries[0]` would silently sync a DIFFERENT person's
  // decks when the name is mistyped -- a wrong record with no visible cause.
  return { userName: match.userName, displayName: match.displayName || match.userName };
}

// Every public deck of an author, with lastUpdatedAtUtc -- the stamp that makes
// change detection one cheap call instead of a full fetch per deck.
async function getAuthorDeckSummaries(username, { pageSize = 100, maxPages = 20 } = {}) {
  const decks = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages && page <= maxPages) {
    const data = await httpGet('/v2/decks/search-sfw', {
      authorUserNames: username,
      pageNumber: page,
      pageSize,
      sortType: 'Updated',
      sortDirection: 'Descending',
      includePinned: true,
      showIllegal: true
    });
    const rows = data.data || [];
    if (rows.length === 0) break;
    decks.push(...rows);
    totalPages = parseInt(data.totalPages, 10) || page;
    page += 1;
  }
  return decks;
}

// The full deck. boards.{mainboard,sideboard,maybeboard,commanders} are maps of
// { moxfieldCardId: { quantity, card: { scryfall_id, name, set, cn, ... } } }.
async function getDeckDetails(publicId) {
  return httpGet(`/v3/decks/all/${encodeURIComponent(publicId)}`);
}

module.exports = {
  getUser, getAuthorDeckSummaries, getDeckDetails,
  MoxfieldError, httpGet, BASE_URL, HEADERS
};
