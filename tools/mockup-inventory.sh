#!/usr/bin/env bash
# Behaviour inventory of the APPROVED mockup.
#
# Markup and CSS survive a port because you copy them. INTERACTIONS do not,
# because they get re-implemented -- which is how an approved feature goes
# missing without anything failing. This lists what must still be true after
# the port.
cd /home/hermes/repos/bindarr/sketches/scanner-desktop

echo "=== handlers the mockup wires:"
grep -o 'onclick="[a-zA-Z]*' c-balanced.html | sort | uniq -c
grep -o 'oninput="[a-zA-Z]*' c-balanced.html | sort | uniq -c

echo
echo "=== structural features that must be reproduced:"
for f in "animation:land" "position:sticky" "aspect-ratio:4/3" \
         "grid-template-columns:520px" "Last scanned" ">When<" "lastcard" \
         "Needs printing" "qtyctl" "fixbox"; do
  printf "  %-30s %s\n" "$f" "$(grep -c "$f" c-balanced.html)"
done

echo
echo "=== table columns, in order:"
sed -n '/<thead>/,/<\/thead>/p' c-balanced.html | grep -o '>[A-Z][a-z]*<' | tr -d '><'
