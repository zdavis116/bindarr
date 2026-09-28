#!/usr/bin/env bash
# Static checks for hand-written mockups.
#
# These catch the failures that make a mockup look unfinished or, worse, look
# FINISHED while a control silently does nothing -- which wastes a review round
# on a bug that was never in the design.
set -uo pipefail
cd "$(dirname "$0")/../sketches/scanner-desktop"

NODE="${NODE:-node}"
fail=0

for f in *.html; do
  echo "=== $f"

  # 1. The script body must PARSE. A syntax error means every control is dead
  #    and the page looks like a static picture.
  $NODE -e "
    const fs=require('fs');
    const html=fs.readFileSync('$f','utf8');
    const m=html.match(/<script>([\s\S]*?)<\/script>/);
    if(!m){ console.log('  no script block'); process.exit(0); }
    require('vm').compileFunction(m[1]);
    console.log('  js parses');
  " || { echo "  JS DOES NOT PARSE"; fail=1; }

  # 2. Every onclick/oninput handler must EXIST. A missing one is a button that
  #    does nothing -- the same failure class as an unreachable control.
  $NODE -e "
    const fs=require('fs');
    const html=fs.readFileSync('$f','utf8');
    const called=new Set([...html.matchAll(/on(?:click|input)=\"(\w+)\(/g)].map(m=>m[1]));
    const defined=new Set([...html.matchAll(/function (\w+)\(/g)].map(m=>m[1]));
    const missing=[...called].filter(c=>!defined.has(c)&&!['event'].includes(c));
    if(missing.length){ console.log('  MISSING HANDLERS: '+missing.join(', ')); process.exit(1); }
    console.log('  all '+called.size+' handlers defined');
  " || fail=1

  # 3. No user STRING interpolated into an inline handler. A card name with an
  #    apostrophe (Atraxa, Praetors' Voice) silently breaks that row.
  if grep -qE "onclick=\"[a-z]+\('\\\$\{" "$f"; then
    echo "  STRING INTERPOLATED INTO onclick -- pass an index instead"
    fail=1
  else
    echo "  no strings interpolated into handlers"
  fi

  # 4. Design tokens must match the app's. A mockup in invented colours is a
  #    different product, and the difference only surfaces at build time.
  $NODE -e "
    const fs=require('fs');
    const html=fs.readFileSync('$f','utf8');
    const app=fs.readFileSync('../../frontend/src/index.css','utf8');
    const want={'--accent-blue':'#0a84ff','--accent-yellow':'#ff9f0a',
                '--accent-green':'#30d158','--surface-1':'#1c1c1e','--surface-2':'#2c2c2e',
                '--text-primary':'#f5f5f7','--text-secondary':'#98989d','--text-muted':'#636366'};
    const bad=[];
    for(const [k,v] of Object.entries(want)){
      const m=html.match(new RegExp(k.replace('--','\\\\-\\\\-')+':\\\\s*([^;]+);'));
      if(!m){ bad.push(k+' missing'); continue; }
      if(m[1].trim().toLowerCase()!==v){ bad.push(k+'='+m[1].trim()+' want '+v); }
    }
    if(bad.length){ console.log('  TOKEN DRIFT: '+bad.join('; ')); process.exit(1); }
    console.log('  design tokens match the app');
  " || fail=1
done

echo
[ $fail -eq 0 ] && echo "ALL MOCKUP CHECKS PASSED" || echo "SOME CHECKS FAILED"
exit $fail
