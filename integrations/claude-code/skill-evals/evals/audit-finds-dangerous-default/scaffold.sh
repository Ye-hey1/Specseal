#!/usr/bin/env bash
# src/http.js 缺省关闭 TLS 验证；文件已 git add 但未 commit，audit 的 git diff HEAD 看得到它。
source "$(dirname "$0")/../fixtures.sh"
eval_git_init
echo '# http client' >README.md
eval_commit 'initial commit'
mkdir -p src
cat >src/http.js <<'JS'
const https = require('https');

function request(url, options = {}) {
  const agent = new https.Agent({
    rejectUnauthorized: options.verifyTls ?? false,
  });
  return https.get(url, { agent });
}

module.exports = { request };
JS
git add src/http.js
