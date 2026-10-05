#!/usr/bin/env bash
# The console's session, pressed over HTTP against a running server, then the register drill.
# This is the harness behind chunk AT's acceptance test: the drill has to be green after the desk
# has traded, not only on a fresh world.
set -u
B=${B:-http://127.0.0.1:8787/api}
post() { curl -s -m 20 -X POST "$B/$1" -H 'content-type: application/json' -d "${2:-{\}}" -o /dev/null; }

# the world is seeded by the reads the console makes
curl -s -m 20 "$B/world" > /dev/null
curl -s -m 20 "$B/regulatory/uae" > /dev/null
curl -s -m 20 "$B/submissions" > /dev/null
curl -s -m 20 "$B/extracts" > /dev/null

# every tab the console presses, in the console's order
post cover/stop
post cover/tick
post cover/start
post cover/tick
post takaful/approve '{"role":"actuary"}'
post takaful/approve '{"role":"shariah"}'
post takaful/approve '{"role":"board"}'
post group/consolidate
post underwriting/decide
post claims/approve
post claims/register
post ingest/submit
post ingest/commit
post partner/lookup
post ai/approve
post ai/execute
post wording/generate

# the regulatory tab, the filing and the supervisor's answer
post preview/switch
post preview/withdrawal
post regulatory/uae/check
post regulatory/uae/check '{"scenario":"unrated-counterparty"}'
post regulatory/uae/check '{"scenario":"participant-money"}'
post wording/generate
post submissions/file
post submissions/acknowledge
post claims/settle

# the reinsurance tab, in the order the buttons are pressed
post reinsurance/cede
post reinsurance/facultative
post reinsurance/recover
post reinsurance/event
post reinsurance/reinstate
post reinsurance/deposit
post reinsurance/deposit/settle
post reinsurance/settle
post reinsurance/security/hold
post reinsurance/security/call
post reinsurance/security/call/settle
post reinsurance/security/release
post reinsurance/security/interest
post extracts/issue

curl -s -m 40 -X POST "$B/state/registers/drill" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print('drill ok:', d['ok'])
print('detail:', d['detail'][:220])
if d.get('actions'):
    print('actions: expected', d['actions']['expected'], 'replayed', d['actions']['replayed'], 'skipped', d['actions']['skipped'])
print('books:', d['books']['agree'], '|', d['books']['detail'][:140])
for line in d['registers']['replays']:
    if 'refused' in line or 'different' in line or 'wrong' in line:
        print('  !', line[:160])
sys.exit(0 if d['ok'] else 1)
"
