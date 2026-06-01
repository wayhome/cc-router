import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizeProxyResponseHeaders } from '../src/utils.js';

test('sanitizeProxyResponseHeaders removes stale body framing headers', () => {
  const headers = new Headers({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Content-Encoding': 'gzip',
    'Content-Length': '1234',
    'Transfer-Encoding': 'chunked',
    'X-Route-Type': 'codex',
    'X-Used-Base-URL': 'https://example.test'
  });

  const sanitized = sanitizeProxyResponseHeaders(headers);

  assert.equal(sanitized.get('content-type'), 'text/event-stream; charset=utf-8');
  assert.equal(sanitized.get('x-route-type'), 'codex');
  assert.equal(sanitized.get('x-used-base-url'), 'https://example.test');
  assert.equal(sanitized.has('content-encoding'), false);
  assert.equal(sanitized.has('content-length'), false);
  assert.equal(sanitized.has('transfer-encoding'), false);
});

