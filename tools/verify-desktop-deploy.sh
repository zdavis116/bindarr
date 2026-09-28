#!/usr/bin/env bash
# Did the desktop layout actually reach the bundle the browser downloads?
#
# A health 200 says the server is up. It says nothing about whether this
# component is in the JavaScript Zach's browser will run -- and "the commit is
# on the box" is not the same as "the code is in the bundle".
set -uo pipefail
cd /home/hermes/repos/bindarr

echo "=== local bundle matches served bundle?"
L=$(md5sum frontend/dist/assets/AddCards-*.js | awk '{print $1}')
R=$(ssh -o BatchMode=yes root@bindarr-dev 'md5sum /opt/bindarr-dev/frontend/dist/assets/AddCards-*.js | awk "{print \$1}"')
[ "$L" = "$R" ] && echo "  MATCH ($L)" || echo "  DIFFER: local=$L served=$R"

echo
echo "=== is the desktop layout IN the served JS?"
for marker in "dsk-scan" "dsk-split" "Last scanned" "dsk-lastwrap"; do
  n=$(ssh -o BatchMode=yes root@bindarr-dev "grep -lo '$marker' /opt/bindarr-dev/frontend/dist/assets/*.js 2>/dev/null | wc -l")
  printf "  %-16s in %s bundle file(s)\n" "$marker" "$n"
done

echo
echo "=== is the 520px column in the served CSS?"
ssh -o BatchMode=yes root@bindarr-dev "grep -o 'grid-template-columns:520px [^;}]*' /opt/bindarr-dev/frontend/dist/assets/*.css 2>/dev/null | head -2"

echo
# THE MINIFIER REWRITES THE QUERY. Lightning CSS turns
#   @media (min-width: 769px)
# into the modern range form
#   @media (width>=769px)
# which is the same condition. Grepping for the source spelling reports 0 and
# reads as "the breakpoint is missing" -- a false alarm that would have sent me
# hunting a bug that does not exist. Match either form.
echo "=== is the desktop CSS behind the 769px breakpoint in the built file?"
ssh -o BatchMode=yes root@bindarr-dev "grep -oE '@media \(([a-z-]*width[><]?=?)[ :]*769px\)' /opt/bindarr-dev/frontend/dist/assets/AddCards-*.css | head -2"

echo
echo "=== and the desktop rules are INSIDE it (nothing leaks to the phone)?"
ssh -o BatchMode=yes root@bindarr-dev "/opt/node20/bin/node -e \"
const fs=require('fs');
const f=require('child_process').execSync('ls /opt/bindarr-dev/frontend/dist/assets/AddCards-*.css').toString().trim().split('\\n')[0];
const css=fs.readFileSync(f,'utf8');
// Find the desktop media block and check every .dsk- rule sits inside it.
const total=(css.match(/\\.dsk-/g)||[]).length;
const i=css.search(/@media \\((?:[a-z-]*width[><]?=?)[ :]*769px\\)/);
if(i<0){ console.log('  BREAKPOINT NOT FOUND'); process.exit(1); }
const before=(css.slice(0,i).match(/\\.dsk-/g)||[]).length;
console.log('  .dsk- selectors total:', total, '| outside the query:', before);
console.log(before===0 ? '  OK: no desktop rule can reach the phone' : '  LEAK: a desktop rule sits outside the breakpoint');
\""
