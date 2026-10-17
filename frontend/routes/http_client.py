"""Small, resilient HTTP client for the internal attendance services."""
from __future__ import annotations

from threading import Event, Lock
from time import monotonic

from datetime import date, timedelta
from urllib.parse import urlencode

import requests

# A single Session reuses TCP connections to the internal attendance service.
# Its default urllib3 pool is only 10 connections, which is easy to exhaust
# when several dashboards refresh at the same time.
_session = requests.Session()
_session.mount("http://", requests.adapters.HTTPAdapter(pool_connections=10, pool_maxsize=20))
_session.mount("https://", requests.adapters.HTTPAdapter(pool_connections=10, pool_maxsize=20))
_cache: dict[str, tuple[float, object]] = {}
_refreshing: set[str] = set()
_refresh_events: dict[str, Event] = {}
_lock = Lock()


def get_json(url: str, *, ttl: float = 5, timeout: float = 10, default=None):
    """Return JSON with a short TTL, stale fallback, and refresh coalescing.

    When a popular dashboard cache entry expires, only one request refreshes
    it. Other requests immediately receive the last known-good payload rather
    than opening identical upstream connections or waiting behind a slow one.
    """
    now = monotonic()
    with _lock:
        cached = _cache.get(url)
        if cached and now - cached[0] < ttl:
            return cached[1]
        if url in _refreshing:
            # Serving stale data is preferable once the dashboard has a value.
            # On a cold cache, wait for the first request so simultaneous page
            # loads do not briefly render an empty dashboard.
            if cached:
                return cached[1]
            refresh_event = _refresh_events[url]
        else:
            refresh_event = Event()
            _refreshing.add(url)
            _refresh_events[url] = refresh_event
            refresh_event = None
    if refresh_event is not None:
        refresh_event.wait(timeout=timeout)
        with _lock:
            cached = _cache.get(url)
        return cached[1] if cached else default
    try:
        response = _session.get(url, timeout=timeout)
        response.raise_for_status()
        payload = response.json()
    except (requests.RequestException, ValueError):
        with _lock:
            cached = _cache.get(url)
        return cached[1] if cached else default
    else:
        with _lock:
            _cache[url] = (monotonic(), payload)
            if len(_cache) > 128:
                oldest = min(_cache, key=lambda key: _cache[key][0])
                _cache.pop(oldest, None)
        return payload
    finally:
        with _lock:
            _refreshing.discard(url)
            refresh_event = _refresh_events.pop(url, None)
            if refresh_event is not None:
                refresh_event.set()


def put_json(url: str, payload: object, *, timeout: float = 20):
    return _session.put(url, json=payload, timeout=timeout)


def attendance_window_url(base_url, start=None, end=None):
    """Include yesterday for overnight shifts; callers keep their status rules."""
    end = end or date.today()
    start = start or end - timedelta(days=1)
    return base_url + "?" + urlencode({"start_date": start.isoformat(), "end_date": end.isoformat()})
