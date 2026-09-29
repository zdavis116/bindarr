#!/usr/bin/env bash
# MUTATION TEST for setsSync.test.js.
#
# Every mutation here restores a version of the bug that produced NO error and
# NO log line -- the set list simply stopped updating, and nothing noticed
# until a feature tried to divide by it and showed 670%.
set -uo pipefail
cd "$(dirname "$0")/.."

TEST=backend/test/setsSync.test.js
NODE="${NODE:-node}"
TARGETS="backend/src/scryfallApi.js backend/src/db.js backend/src/server.js"

if ! git diff --quiet -- $TARGETS "$TEST"; then
  echo "REFUSING: a target or the test has uncommitted changes. Commit first."
  exit 2
fi

fail=0

mutate() {
  local id="$1" desc="$2" expect="$3" file="$4" js="$5"
  printf '\n=== %s: %s\n' "$id" "$desc"

  if ! $NODE -e "
    const fs = require('fs');
    const p = '$file';
    const before = fs.readFileSync(p, 'utf8');
    $js
    if (after === before) { console.error('ANCHOR FAILED - source unchanged'); process.exit(3); }
    fs.writeFileSync(p, after);
  "; then
    echo "  ABORT: anchor did not match. Not running the test."
    git checkout -- $TARGETS
    fail=1
    return
  fi

  local out rc last
  out="$($NODE "$TEST" 2>&1)"; rc=$?
  git checkout -- $TARGETS

  if [ $rc -eq 0 ]; then
    echo "  STILL PASSED -> the test is VACUOUS. Fix the test, not this script."
    fail=1
    return
  fi
  last="$(echo "$out" | grep '^RUN: ' | tail -1 | sed 's/^RUN: //')"
  if [ "$last" = "$expect" ]; then
    echo "  caught by $expect (the intended case)"
  else
    echo "  failed, but via ${last:-<none>} rather than $expect:"
    echo "$out" | grep -E 'AssertionError' | head -1 | sed 's/^/    /'
    fail=1
  fi
}

# M1: THE ORIGINAL BUG. Gate on the table being empty, so after the first boot
# it never refreshes again.
mutate M1 "refresh gates on emptiness again" "SETS-TC2" "backend/src/scryfallApi.js" "
  const re = /if \(!force && !\(await setsSyncIsDue\(\)\)\) \{/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, 'if (!force && (await db.get(\`SELECT COUNT(*) as count FROM sets\`)).count > 0) {');
"

# M2: never record the sync, so every single restart refetches ~1000 sets --
# a self-inflicted hammering of Scryfall that also never settles.
mutate M2 "successful sync is not recorded" "SETS-TC1" "backend/src/scryfallApi.js" "
  const re = /    await db\.run\(\`UPDATE app_settings SET sets_synced_at = CURRENT_TIMESTAMP WHERE id = 1\`\);\n/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '');
"

# M2b: drop the persisted column entirely -- the schedule goes back to living
# in process memory, which a restart resets.
mutate M2b "the timestamp column is removed" "SETS-TC1" "backend/src/db.js" "
  const re = /    await run\(\`ALTER TABLE app_settings ADD COLUMN sets_synced_at DATETIME\`\);/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '');
"

# M3: stamp the sync BEFORE checking the response, so a failed fetch buys
# itself another week of stale totals.
mutate M3 "a failed fetch marks itself synced" "SETS-TC3" "backend/src/scryfallApi.js" "
  const re = /    if \(!sets\.length\) \{[\s\S]*?\n    \}\n/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '');
"

# M4: stretch the interval to a year. Still 'scheduled', still useless.
mutate M4 "sync interval is no longer weekly" "SETS-TC2" "backend/src/scryfallApi.js" "
  const re = /const SETS_SYNC_INTERVAL_MS = 1000 \* 60 \* 60 \* 24 \* 7;/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, 'const SETS_SYNC_INTERVAL_MS = 1000 * 60 * 60 * 24 * 365;');
"

# M5: remove the warning that the setInterval cannot be relied on, so the next
# reader believes the weekly timer is the schedule -- exactly the false
# confidence that let this bug live.
mutate M5 "the timer is presented as the schedule" "SETS-TC4" "backend/src/server.js" "
  const re = /THIS TIMER IS THE BACKUP, NOT THE SCHEDULE/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, 'This refreshes the set list weekly');
"

printf '\n'
if ! git diff --quiet -- $TARGETS "$TEST"; then
  echo "TREE NOT CLEAN after the run - restore failed. Check git status."
  exit 2
fi
echo "tree clean."
[ $fail -eq 0 ] && echo "ALL MUTATIONS CAUGHT BY THE INTENDED CASE" || echo "SOME MUTATIONS NOT CAUGHT - see above"
exit $fail
