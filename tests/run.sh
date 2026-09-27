#!/usr/bin/env bash
# シュートログの自動テスト。本番のスプレッドシート・LINEには一切触れない。
#   使い方(リポジトリのルートで): bash tests/run.sh
#   必要なもの: Node.js と Python
#   - gas_tests.js    : Code.gs を模擬GAS(シート・日付の自動変換・キャッシュ・ロック)の上で実行する
#   - client_tests.js : index.html のスクリプトを模擬画面と偽サーバー(応答順を入れ替えられる)の上で実行する
set -eo pipefail
cd "$(dirname "$0")"
trap 'rm -f .index_inline.js .code_gs.js' EXIT
python extract_js.py ../index.html .index_inline.js >/dev/null
cp ../gas/Code.gs .code_gs.js
node --check .code_gs.js && echo "Code.gs: 構文OK"
node --check .index_inline.js && echo "index.html: 構文OK"
node gas_tests.js .code_gs.js | tail -1
node client_tests.js .index_inline.js | tail -1
