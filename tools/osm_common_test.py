"""Tests for the Overpass client in tools/osm_common.py.

The client's job is to outlive a bad minute at the public endpoints: retry
what is transient, refuse to retry what is deterministic, and never cache an
answer the server itself says is incomplete.
"""
from __future__ import annotations

import gzip
import json
import pickle
import tempfile
import unittest
from unittest import mock

import osm_common
from osm_common import overpass_fetch, remark_is_failure


class FakeResponse:
    def __init__(self, status=200, payload=None, text=''):
        self.status_code = status
        self.reason = {200: 'OK', 400: 'Bad Request', 429: 'Too Many Requests',
                       504: 'Gateway Timeout'}.get(status, 'Error')
        self._payload = payload
        self.text = text or (json.dumps(payload) if payload is not None else '')

    def json(self):
        if self._payload is None:
            raise ValueError('not json')
        return self._payload


DATA = {'elements': [{'type': 'node', 'id': 1, 'lon': 0.0, 'lat': 0.0}]}


class OverpassFetchTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(mock.patch.stopall)
        mock.patch.object(osm_common, 'OSM_CACHE_DIR', tmp.name).start()
        mock.patch.dict(osm_common._MIRROR_FAILURES, clear=True).start()
        self.sleep = mock.patch.object(osm_common.time, 'sleep').start()

    def post_returning(self, *responses) -> mock.MagicMock:
        return mock.patch.object(
            osm_common.requests, 'post', side_effect=list(responses)).start()

    def test_a_busy_minute_is_survived(self):
        # Every mirror 504s once - the shared load spike - then the first one
        # answers on the second pass, after a single backoff.
        busy = [FakeResponse(504)] * len(osm_common.OVERPASS_URLS)
        post = self.post_returning(*busy, FakeResponse(200, DATA))
        self.assertEqual(overpass_fetch('q1', 'test', False), DATA)
        self.assertEqual(post.call_count, len(busy) + 1)
        self.sleep.assert_called_once_with(osm_common.OVERPASS_BACKOFF_S[0])

    def test_a_refused_query_fails_at_once(self):
        """A 400 is the query's fault; no mirror or pass will change it."""
        post = self.post_returning(
            FakeResponse(400, text='line 3: parse error'))
        with self.assertRaises(RuntimeError) as ctx:
            overpass_fetch('q2', 'test', False)
        self.assertIn('parse error', str(ctx.exception))
        self.assertEqual(post.call_count, 1)
        self.sleep.assert_not_called()

    def test_gives_up_after_every_pass(self):
        n = osm_common.OVERPASS_ROUNDS * len(osm_common.OVERPASS_URLS)
        post = self.post_returning(*[FakeResponse(504)] * n)
        with self.assertRaises(RuntimeError) as ctx:
            overpass_fetch('q3', 'test', False)
        self.assertEqual(post.call_count, n)
        self.assertIn('504', str(ctx.exception))

    def test_a_timed_out_answer_is_not_data_and_not_cached(self):
        """HTTP 200 with a timeout remark is a partial answer, not the data.

        Cached, the shortfall would be permanent until someone thought to
        pass --refresh-osm; the cache must end up holding the clean answer.
        """
        poisoned = FakeResponse(200, {
            'elements': [],
            'remark': 'runtime error: Query timed out in "query" at line 2.',
        })
        self.post_returning(poisoned, FakeResponse(200, DATA))
        self.assertEqual(overpass_fetch('q4', 'test', False), DATA)
        with gzip.open(osm_common.overpass_cache_path('q4'), 'rb') as fh:
            self.assertEqual(pickle.load(fh), DATA)

    def test_a_connection_error_moves_to_the_next_mirror(self):
        post = self.post_returning(
            osm_common.requests.ConnectionError('boom'),
            FakeResponse(200, DATA))
        self.assertEqual(overpass_fetch('q5', 'test', False), DATA)
        self.assertEqual(post.call_count, 2)
        self.sleep.assert_not_called()

    def test_an_unparseable_body_moves_on(self):
        """A proxy error page arrives as 200 text/html often enough."""
        post = self.post_returning(
            FakeResponse(200, text='<html>Bad Gateway</html>'),
            FakeResponse(200, DATA))
        self.assertEqual(overpass_fetch('q6', 'test', False), DATA)
        self.assertEqual(post.call_count, 2)

    def test_a_failing_mirror_drifts_to_the_back(self):
        """A dead endpoint must stop taxing the front of every later fetch.

        kumi.systems spent a whole day answering 500/502 to everything, and
        every pass of every fetch still asked it first and paid its refusal.
        """
        post = self.post_returning(
            FakeResponse(502), FakeResponse(200, DATA),   # first fetch
            FakeResponse(200, DATA))                      # second fetch
        overpass_fetch('qa', 'test', False)
        overpass_fetch('qb', 'test', False)
        urls = [c.args[0] for c in post.call_args_list]
        self.assertEqual(urls[:2], list(osm_common.OVERPASS_URLS[:2]))
        # The second fetch starts at the mirror that answered, not the one
        # that failed.
        self.assertEqual(urls[2], osm_common.OVERPASS_URLS[1])

    def test_a_recovered_mirror_is_forgiven(self):
        """One success resets the count; a healthy mirror keeps its place."""
        post = self.post_returning(
            FakeResponse(502), FakeResponse(504), FakeResponse(200, DATA))
        overpass_fetch('qc', 'test', False)
        # Mirrors 0 and 1 each carry one failure and sort behind every
        # untouched mirror; mirror 2 answered and leads.
        self.assertEqual(osm_common.mirror_order()[0],
                         osm_common.OVERPASS_URLS[2])
        self.assertEqual(
            osm_common.mirror_order()[-2:],
            [osm_common.OVERPASS_URLS[0], osm_common.OVERPASS_URLS[1]])
        post.side_effect = [FakeResponse(200, DATA)]
        overpass_fetch('qd', 'test', False)
        self.assertEqual(post.call_args_list[-1].args[0],
                         osm_common.OVERPASS_URLS[2])
        self.assertEqual(osm_common._MIRROR_FAILURES.get(
            osm_common.OVERPASS_URLS[2], 0), 0)


class RemarkTest(unittest.TestCase):
    def test_a_server_side_death_is_a_failure(self):
        self.assertTrue(remark_is_failure(
            'runtime error: Query timed out in "query" at line 3.'))
        self.assertTrue(remark_is_failure(
            'runtime error: Query ran out of memory.'))

    def test_an_informational_note_is_not(self):
        self.assertFalse(remark_is_failure('note: nothing of consequence'))


if __name__ == '__main__':
    unittest.main()
