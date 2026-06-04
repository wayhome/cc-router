import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../src/worker.js';

test('Claude route preserves upstream 429 after exhausting failover candidates', async () => {
  const originalFetch = globalThis.fetch;
  const upstreamRequests = [];

  globalThis.fetch = async request => {
    upstreamRequests.push(new URL(request.url).pathname);
    return new Response('rate limited', {
      status: 429,
      statusText: 'Too Many Requests',
      headers: {
        'Content-Type': 'text/plain',
        'Retry-After': '2'
      }
    });
  };

  try {
    const response = await worker.fetch(new Request('https://router.test/v1/messages'));

    assert.equal(response.status, 429);
    assert.equal(response.statusText, 'Too Many Requests');
    assert.equal(response.headers.get('retry-after'), '2');
    assert.equal(response.headers.get('x-route-type'), 'claude');
    assert.equal(await response.text(), 'rate limited');
    assert.equal(upstreamRequests.length, 6);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Codex route preserves upstream 429 after exhausting source failover', async () => {
  const originalFetch = globalThis.fetch;
  const upstreamRequests = [];

  globalThis.fetch = async request => {
    const url = new URL(request.url);
    upstreamRequests.push(`${url.host}${url.pathname}`);
    return new Response('codex rate limited', {
      status: 429,
      statusText: 'Too Many Requests',
      headers: {
        'Content-Type': 'text/plain',
        'Retry-After': '3'
      }
    });
  };

  try {
    const response = await worker.fetch(new Request('https://router.test/codex/v1/responses'));

    assert.equal(response.status, 429);
    assert.equal(response.statusText, 'Too Many Requests');
    assert.equal(response.headers.get('retry-after'), '3');
    assert.equal(response.headers.get('x-route-type'), 'codex');
    assert.equal(await response.text(), 'codex rate limited');
    assert.deepEqual(upstreamRequests, [
      'code.newcli.com/codex/v1/responses',
      'code.newcli.com/codex/v1/responses',
      'code.newcli.com/codex/v1/responses',
      'dm-fox.rjj.cc/codex/v1/responses',
      'dm-fox.rjj.cc/codex/v1/responses',
      'dm-fox.rjj.cc/codex/v1/responses'
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Codex route stays on the same source when a 429 retry succeeds', async () => {
  const originalFetch = globalThis.fetch;
  const upstreamRequests = [];
  let attempts = 0;

  globalThis.fetch = async request => {
    attempts++;
    const url = new URL(request.url);
    upstreamRequests.push(`${url.host}${url.pathname}`);

    if (attempts < 3) {
      return new Response('codex rate limited', {
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'Retry-After': '1' }
      });
    }

    return new Response('codex ok', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' }
    });
  };

  try {
    const response = await worker.fetch(new Request('https://router.test/codex/v1/responses'));

    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'codex ok');
    assert.deepEqual(upstreamRequests, [
      'code.newcli.com/codex/v1/responses',
      'code.newcli.com/codex/v1/responses',
      'code.newcli.com/codex/v1/responses'
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Codex route avoids a source after its SSE stream fails', async () => {
  const originalFetch = globalThis.fetch;
  const upstreamRequests = [];

  globalThis.fetch = async request => {
    const url = new URL(request.url);
    upstreamRequests.push(`${url.host}${url.pathname}`);

    if (upstreamRequests.length === 1) {
      return new Response([
        'event: response.created',
        'data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.3-codex"}}',
        '',
        'event: response.failed',
        'data: {"type":"response.failed","error":{"message":"Upstream request failed","type":"api_error"}}',
        '',
        ''
      ].join('\n'), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8' }
      });
    }

    return new Response([
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_2","model":"gpt-5.3-codex","output_text":"ok"}}',
      '',
      ''
    ].join('\n'), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8' }
    });
  };

  try {
    const firstResponse = await worker.fetch(new Request('https://router.test/codex/v1/responses'));
    assert.equal(firstResponse.status, 200);
    assert.match(await firstResponse.text(), /response\.failed/);

    const secondResponse = await worker.fetch(new Request('https://router.test/codex/v1/responses'));
    assert.equal(secondResponse.status, 200);
    assert.match(await secondResponse.text(), /response\.completed/);

    assert.deepEqual(upstreamRequests, [
      'code.newcli.com/codex/v1/responses',
      'dm-fox.rjj.cc/codex/v1/responses'
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Codex route avoids a source after stream closes without completion', async () => {
  const originalFetch = globalThis.fetch;
  const upstreamRequests = [];

  globalThis.fetch = async request => {
    const url = new URL(request.url);
    upstreamRequests.push(`${url.host}${url.pathname}`);

    if (upstreamRequests.length === 1) {
      return new Response([
        'event: response.created',
        'data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.3-codex"}}',
        '',
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"partial"}',
        '',
        ''
      ].join('\n'), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8' }
      });
    }

    return new Response([
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_2","model":"gpt-5.3-codex","output_text":"ok"}}',
      '',
      ''
    ].join('\n'), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8' }
    });
  };

  try {
    const firstResponse = await worker.fetch(new Request('https://router.test/codex/v1/responses'));
    assert.equal(firstResponse.status, 200);
    const firstText = await firstResponse.text();
    assert.match(firstText, /response\.created/);
    assert.match(firstText, /partial/);
    assert.doesNotMatch(firstText, /response\.completed/);

    const secondResponse = await worker.fetch(new Request('https://router.test/codex/v1/responses'));
    assert.equal(secondResponse.status, 200);
    assert.match(await secondResponse.text(), /response\.completed/);

    assert.equal(upstreamRequests.length, 2);
    assert.notEqual(upstreamRequests[0], upstreamRequests[1]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
