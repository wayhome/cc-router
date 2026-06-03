import {
  BROWSER_USER_AGENT,
  ENDPOINTS,
  ROUTE_TYPES,
  TARGET_BASE_URLS
} from './config.js';
import { buildEndpointAttemptOrder } from './utils.js';

const CODEX_RATE_LIMIT_ATTEMPTS_PER_SOURCE = 3;

function withBrowserUserAgent(headers) {
  if (!headers.has('user-agent') || headers.get('user-agent').includes('curl')) {
    headers.set('user-agent', BROWSER_USER_AGENT);
  }
  return headers;
}

export async function proxyRequest(request, baseUrlIndex, endpointPath, apiPath) {
  const url = new URL(request.url);
  const targetUrl = `${TARGET_BASE_URLS[baseUrlIndex]}${endpointPath}${apiPath}${url.search}`;
  const headers = withBrowserUserAgent(new Headers(request.headers));

  return await fetch(new Request(targetUrl, {
    method: request.method,
    headers,
    body: request.body,
    redirect: 'follow'
  }));
}

export async function proxyDirectRequest(request, baseUrlIndex, path) {
  const url = new URL(request.url);
  const targetUrl = `${TARGET_BASE_URLS[baseUrlIndex]}${path}${url.search}`;
  const headers = withBrowserUserAgent(new Headers(request.headers));

  return await fetch(new Request(targetUrl, {
    method: request.method,
    headers,
    body: request.body,
    redirect: 'follow'
  }));
}

export async function tryEndpoints(request, manager, apiPath, preferredEndpoint = null, allowHigherTierFallback = false) {
  const requestBody = await request.clone().arrayBuffer();
  const requestHeaders = new Headers(request.headers);
  const triedEndpoints = new Set();
  const candidateEndpointIndices = buildEndpointAttemptOrder(preferredEndpoint, allowHigherTierFallback);
  let lastResponse = null;
  let lastEndpointIndex = -1;
  let lastBaseUrlIndex = -1;

  if (candidateEndpointIndices.length === 0) {
    return { response: null, endpointIndex: -1, baseUrlIndex: -1, success: false };
  }

  for (let attempt = 0; attempt < candidateEndpointIndices.length; attempt++) {
    let currentIndex = -1;

    for (const endpointIndex of candidateEndpointIndices) {
      if (triedEndpoints.has(endpointIndex)) continue;

      let hasAvailableSource = false;
      for (let baseUrlIndex = 0; baseUrlIndex < TARGET_BASE_URLS.length; baseUrlIndex++) {
        if (await manager.isAvailable(endpointIndex, baseUrlIndex, ROUTE_TYPES.CLAUDE)) {
          hasAvailableSource = true;
          break;
        }
      }

      if (hasAvailableSource) {
        currentIndex = endpointIndex;
        break;
      }
    }

    if (currentIndex === -1) {
      for (const endpointIndex of candidateEndpointIndices) {
        if (!triedEndpoints.has(endpointIndex)) {
          currentIndex = endpointIndex;
          break;
        }
      }
    }

    if (currentIndex === -1) break;

    triedEndpoints.add(currentIndex);
    const endpoint = ENDPOINTS[currentIndex];

    for (let baseUrlIndex = 0; baseUrlIndex < TARGET_BASE_URLS.length; baseUrlIndex++) {
      try {
        const clonedRequest = new Request(request.url, {
          method: request.method,
          headers: requestHeaders,
          body: requestBody.byteLength > 0 ? requestBody : null
        });

        const response = await proxyRequest(clonedRequest, baseUrlIndex, endpoint, apiPath);
        if (response.status < 400) {
          await manager.recordSuccess(currentIndex, baseUrlIndex, ROUTE_TYPES.CLAUDE);
          return {
            response,
            endpointIndex: currentIndex,
            baseUrlIndex,
            success: true
          };
        }

        lastResponse = response;
        lastEndpointIndex = currentIndex;
        lastBaseUrlIndex = baseUrlIndex;
        await manager.recordFailure(currentIndex, baseUrlIndex, ROUTE_TYPES.CLAUDE);
      } catch (error) {
        await manager.recordFailure(currentIndex, baseUrlIndex, ROUTE_TYPES.CLAUDE);
      }
    }
  }

  return {
    response: lastResponse,
    endpointIndex: lastEndpointIndex,
    baseUrlIndex: lastBaseUrlIndex,
    success: false
  };
}

export async function tryCodexSources(request, manager, codexPath) {
  const requestBody = await request.clone().arrayBuffer();
  const requestHeaders = new Headers(request.headers);
  const triedSources = new Set();
  let lastResponse = null;
  let lastBaseUrlIndex = -1;

  for (let attempt = 0; attempt < TARGET_BASE_URLS.length; attempt++) {
    let currentBaseUrlIndex = -1;

    for (let i = 0; i < TARGET_BASE_URLS.length; i++) {
      if (triedSources.has(i)) continue;
      if (await manager.isAvailable(0, i, ROUTE_TYPES.CODEX)) {
        currentBaseUrlIndex = i;
        break;
      }
    }

    if (currentBaseUrlIndex === -1) {
      for (let i = 0; i < TARGET_BASE_URLS.length; i++) {
        if (!triedSources.has(i)) {
          currentBaseUrlIndex = i;
          break;
        }
      }
    }

    if (currentBaseUrlIndex === -1) {
      break;
    }

    triedSources.add(currentBaseUrlIndex);
    lastBaseUrlIndex = currentBaseUrlIndex;

    try {
      for (let sourceAttempt = 0; sourceAttempt < CODEX_RATE_LIMIT_ATTEMPTS_PER_SOURCE; sourceAttempt++) {
        const clonedRequest = new Request(request.url, {
          method: request.method,
          headers: requestHeaders,
          body: requestBody.byteLength > 0 ? requestBody : null
        });

        const response = await proxyDirectRequest(clonedRequest, currentBaseUrlIndex, codexPath);
        if (response.status < 400) {
          await manager.recordSuccess(0, currentBaseUrlIndex, ROUTE_TYPES.CODEX);
          return {
            response,
            baseUrlIndex: currentBaseUrlIndex,
            success: true
          };
        }

        lastResponse = response;
        if (response.status !== 429 || sourceAttempt === CODEX_RATE_LIMIT_ATTEMPTS_PER_SOURCE - 1) {
          await manager.recordFailure(0, currentBaseUrlIndex, ROUTE_TYPES.CODEX);
          break;
        }
      }
    } catch (error) {
      await manager.recordFailure(0, currentBaseUrlIndex, ROUTE_TYPES.CODEX);
    }
  }

  return {
    response: lastResponse,
    baseUrlIndex: lastBaseUrlIndex,
    success: false
  };
}
