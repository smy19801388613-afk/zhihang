"""Bounded public JobSpy bridge. stdin contains only search terms and locations.

No login, cookies, applicant data, model keys or application submission. Emit one
JSON line per query, so the parent can retain finished queries on total timeout.
JobSpy sometimes logs errors and returns an empty frame: transport diagnostics
are tracked separately rather than interpreting every empty frame as success.
"""
from __future__ import annotations

import concurrent.futures
import datetime
import json
import sys
import threading
from urllib.parse import urlparse
from urllib.request import getproxies

MAX_QUERIES = 6
MAX_RESULTS = 5
MAX_REQUESTS = 8


def emit(value):
    print(json.dumps(value, ensure_ascii=False, allow_nan=False), flush=True)


def main():
    try:
        payload = json.loads(sys.stdin.buffer.read(32769).decode('utf-8'))
        queries = payload['queries']
        if not isinstance(queries, list) or len(queries) > MAX_QUERIES:
            raise ValueError('query limit')
        for query in queries:
            if query['source'] not in ('linkedin', 'indeed'):
                raise ValueError('source')
            if not all(isinstance(query[key], str) and 0 < len(query[key]) <= 120 for key in ('id', 'term', 'location')):
                raise ValueError('query shape')
    except (KeyError, ValueError, TypeError):
        emit({'fatal': '输入参数无效'}); return 2
    try:
        import requests
        from jobspy import scrape_jobs
    except ImportError:
        emit({'fatal': '未安装 JobSpy，请运行 scripts/setup-jobspy.ps1 或配置 JOBSPY_PYTHON'}); return 2

    original_request = requests.Session.request
    original_init = requests.Session.__init__
    # Respect the user's existing OS network connection (including the Windows
    # system proxy), without loading .netrc credentials or rotating proxies.
    system_proxies = {key: val for key, val in getproxies().items() if key in ('http', 'https')}
    all_requests = {'count': 0, 'failuresBySource': {}}
    lock = threading.Lock()

    def init_session(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        # Do not use local browser/session credentials or .netrc account data.
        self.trust_env = False
        self.proxies.update(system_proxies)
        self._zhihang_requests = 0
        self._zhihang_searches = 0

    def bounded_request(self, method, url, **kwargs):
        host = (urlparse(url).hostname or '').lower()
        source = 'linkedin' if host.endswith('linkedin.com') else 'indeed'
        def failed():
            with lock:
                failures = all_requests['failuresBySource']
                failures[source] = failures.get(source, 0) + 1
        if host not in ('www.linkedin.com', 'linkedin.com', 'apis.indeed.com'):
            failed()
            raise RuntimeError('招聘请求地址不在允许范围')
        self._zhihang_requests += 1
        is_search = '/search' in url or '/graphql' in url
        self._zhihang_searches += int(is_search)
        # At most one source page and five description fetches, no pagination.
        if self._zhihang_requests > MAX_REQUESTS or self._zhihang_searches > 1:
            failed()
            raise RuntimeError('已达到本次公开查询请求上限')
        for adapter in self.adapters.values():
            adapter.max_retries = 0
        kwargs['timeout'] = (5, 8)
        kwargs['allow_redirects'] = False
        with lock:
            all_requests['count'] += 1
        try:
            response = original_request(self, method, url, **kwargs)
            if response.status_code != 200:
                raise RuntimeError(f'招聘来源 HTTP {response.status_code}')
            if len(response.content) > 3_000_000:
                raise RuntimeError('招聘来源响应过大')
            return response
        except Exception:
            failed()
            raise

    requests.Session.__init__ = init_session
    requests.Session.request = bounded_request

    def run(query):
        # Query-level subprocess is unnecessary: the Node parent owns one hard
        # deadline for this Python process, including JobSpy's worker threads.
        try:
            frame = scrape_jobs(site_name=[query['source']], search_term=query['term'],
                location=query['location'], country_indeed='china', job_type='internship',
                results_wanted=MAX_RESULTS, fetch_description=True,
                description_format='plain', enforce_annual_salary=False, verbose=0)
            fields = ['id', 'title', 'company', 'company_industry', 'company_logo', 'location',
                'job_url', 'job_url_direct', 'description', 'job_type', 'date_posted',
                'salary_source', 'interval', 'min_amount', 'max_amount', 'currency']
            rows = frame.reindex(columns=fields).head(MAX_RESULTS).to_json(orient='records', date_format='iso', force_ascii=False)
            return {'id': query['id'], 'rows': json.loads(rows), 'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
        except Exception:
            return {'id': query['id'], 'rows': [], 'error': '公开招聘来源请求失败或已达到查询上限',
                'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}

    # Two at a time limits traffic; every query retains its source identity.
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(run, query) for query in queries]
        for future in concurrent.futures.as_completed(futures):
            emit(future.result())
    emit({'diagnostics': all_requests})
    return 0


if __name__ == '__main__':
    sys.exit(main())
