#!/bin/sh
# 使い方: tools/tlc.sh <cfg> <tla> [TLC の追加引数]。model-1 で実行する。
D=$(cd "$(dirname "$0")/.." && pwd)
cfg=$1; tla=$2; shift 2
exec java -XX:+UseParallelGC -Djava.io.tmpdir="$D/tmp" -cp /Users/yoshi/.local/share/tla/tla2tools.jar tlc2.TLC -metadir "$D/states" -workers 4 -config "$cfg" "$@" "$tla"
