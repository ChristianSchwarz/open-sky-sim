"""The tile pool's side of a per-leaf Python stage (tools/bake/pyLeaf.ts).

A stage script that measures one z12 leaf at a time into a store
(measure_lidar.py, measure_buildings.py) answers two extra flags through
this module:

  --todo   the leaves it would measure for --bbox, one JSON [x, y] a line;
  --serve  measure the leaves asked for on stdin, one JSON request a line,
           {"x", "y", "planet", "store"}, one JSON answer a line - the
           process, and the sources and caches it holds, kept from leaf to
           leaf as a worker of the script's own --jobs keeps them.

The script's PLANET_DIR and STORE_DIR are set per request: a satellite
answers from a job directory that holds only that leaf's inputs.
"""

from __future__ import annotations

import json
import sys
from types import ModuleType
from typing import Callable, Iterable, Tuple


def _plain(o):
    """numpy scalars and arrays, and tuples, as JSON has them."""
    if hasattr(o, 'tolist'):
        return o.tolist()
    if isinstance(o, (set, tuple)):
        return list(o)
    return str(o)


def print_todo(leaves: Iterable[Tuple[int, int]]) -> int:
    for x, y in leaves:
        print(json.dumps([int(x), int(y)]))
    return 0


def serve(module: ModuleType, measure: Callable[[int, int], dict], after: Callable[[], None] = lambda: None) -> int:
    """Answer leaf requests on stdin until it ends.

    The answers go to the process's own stdout, not to whatever sys.stdout
    is: a script that silences a library with contextlib.redirect_stdout
    from several threads at once (measure_buildings.py's Sentinel-2 reads)
    can leave sys.stdout pointing at a discarded buffer when the threads
    leave it out of order, and every answer after that went nowhere - the
    pool waited for it forever. sys.stdout is put back after each leaf too.
    """
    answers = sys.__stdout__
    for line in sys.stdin:
        if not line.strip():
            continue
        req = json.loads(line)
        try:
            module.PLANET_DIR, module.STORE_DIR = req['planet'], req['store']
            r = measure(int(req['x']), int(req['y']))
            after()
            out = {'ok': True, 'result': r}
        except Exception as ex:  # noqa: BLE001 - the pool counts the failure and goes on
            out = {'ok': False, 'error': repr(ex)}
        sys.stdout = sys.__stdout__
        answers.write(json.dumps(out, default=_plain) + '\n')
        answers.flush()
    return 0
