import {
  ALLOW_HIGHER_TIER_FALLBACK_HEADER,
  ENDPOINTS,
  ENDPOINT_TIERS
} from './config.js';

const DEFAULT_AUTO_FALLBACK_CEILING = '/claude/ultra';

export function isValidValue(value) {
  if (value === undefined || value === null || value === '[undefined]' || value === 'undefined') {
    return false;
  }

  if (typeof value === 'object') {
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    return Object.keys(value).length > 0;
  }

  return true;
}

export function cleanObject(obj) {
  if (!obj || typeof obj !== 'object') {
    return obj;
  }

  const cleaned = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isValidValue(value)) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

export function applyCorsHeaders(headers) {
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', '*');
}

export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers
    }
  });
}

export function jsonError(message, type = 'api_error', status = 500, headers = {}) {
  return jsonResponse({ error: { message, type } }, status, headers);
}

export function getEndpointTier(endpoint) {
  if (Object.prototype.hasOwnProperty.call(ENDPOINT_TIERS, endpoint)) {
    return ENDPOINT_TIERS[endpoint];
  }
  return Number.MAX_SAFE_INTEGER;
}

export function parseBooleanHeader(value) {
  if (value === null || value === undefined) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function parseCustomHeaderLines(rawValue) {
  if (!rawValue) return new Map();

  const normalized = String(rawValue).replace(/\\n/g, '\n');
  const lines = normalized.split(/\r?\n/);
  const parsed = new Map();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) continue;

    const key = trimmed.slice(0, colonIndex).trim().toLowerCase();
    const value = trimmed.slice(colonIndex + 1).trim();
    if (!key) continue;

    parsed.set(key, value);
  }

  return parsed;
}

export function shouldAllowHigherTierFallback(headers) {
  const explicit = headers.get(ALLOW_HIGHER_TIER_FALLBACK_HEADER);
  if (explicit !== null) {
    return parseBooleanHeader(explicit);
  }

  const customHeadersRaw = headers.get('anthropic-custom-headers');
  if (!customHeadersRaw) return false;

  const customHeaders = parseCustomHeaderLines(customHeadersRaw);
  if (customHeaders.has(ALLOW_HIGHER_TIER_FALLBACK_HEADER)) {
    return parseBooleanHeader(customHeaders.get(ALLOW_HIGHER_TIER_FALLBACK_HEADER));
  }

  return false;
}

export function buildEndpointAttemptOrder(preferredEndpoint, allowHigherTierFallback) {
  let startIndex = 0;
  if (preferredEndpoint) {
    const preferredIndex = ENDPOINTS.indexOf(preferredEndpoint);
    if (preferredIndex !== -1) {
      startIndex = preferredIndex;
    }
  }

  const defaultMaxEndpoint = preferredEndpoint || DEFAULT_AUTO_FALLBACK_CEILING;
  const maxAllowedTier = allowHigherTierFallback
    ? Number.POSITIVE_INFINITY
    : getEndpointTier(defaultMaxEndpoint);

  const orderedIndices = [];
  for (let i = startIndex; i < ENDPOINTS.length; i++) {
    orderedIndices.push(i);
  }
  for (let i = 0; i < startIndex; i++) {
    orderedIndices.push(i);
  }

  return orderedIndices.filter(index => getEndpointTier(ENDPOINTS[index]) <= maxAllowedTier);
}
