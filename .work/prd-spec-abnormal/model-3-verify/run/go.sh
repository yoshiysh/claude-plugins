#!/bin/sh
V=$(cd "$(dirname "$0")" && pwd)
cd $V
for c in cfg/*.cfg; do n=$(basename $c .cfg); java -XX:+UseParallelGC -Djava.io.tmpdir=$V/tmp -cp /Users/yoshi/.local/share/tla/tla2tools.jar tlc2.TLC -metadir $V/states/$n -workers 4 -config $c Composed.tla > out/$n.txt 2>&1; echo "$n done" ; done
