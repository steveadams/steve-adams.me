#!/usr/bin/env bash
set -euo pipefail

HOOK="$(dirname "$0")/git-guard.sh"
PASS=0 FAIL=0

check() {
  local expect="$1" cmd="$2"
  local input=$(jq -n --arg c "$cmd" '{tool_input:{command:$c}}')
  if echo "$input" | "$HOOK" >/dev/null 2>&1; then
    result="allowed"
  else
    result="blocked"
  fi
  if [[ "$result" == "$expect" ]]; then
    PASS=$((PASS + 1))
  else
    echo "FAIL: expected=$expect got=$result cmd='$cmd'"
    FAIL=$((FAIL + 1))
  fi
}

check blocked "git commit -m 'whatever'"
check blocked "git -C /Users/steve/Work/DarwinKit commit -m 'chore: something'"
check blocked "git -C /Users/steve/Work/DarwinKit push"
check blocked "git push origin main"
check blocked "git push --force origin main"
check blocked "git reset --hard HEAD~1"
check blocked "sleep 2 && git -C /some/path commit -m 'sneaky'"
check blocked "git -c user.name=x commit --amend"
check blocked "git commit --allow-empty -m 'empty'"
check blocked "GIT_DIR=/tmp git commit -m 'test'"

check allowed "git status"
check allowed "git diff HEAD"
check allowed "git log --oneline -10"
check allowed "git add ."
check allowed "git stash"
check allowed "git fetch origin"
check allowed "pushd /tmp && popd"
check allowed "grep -r 'commit' src/"
check allowed "ls committed-files/"

echo "$PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]

exit 0;
