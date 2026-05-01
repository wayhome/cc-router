import {
  CODEX_BASE_PATH,
  ENDPOINTS,
  ROUTE_TYPES
} from './config.js';

export function parseRequestPath(url) {
  const pathname = new URL(url).pathname;

  if (isNativeCodexClientPath(pathname)) {
    return {
      routeType: ROUTE_TYPES.CODEX,
      preferredEndpoint: null,
      apiPath: pathname,
      isOpenAI: false,
      isModels: false
    };
  }

  if (pathname === '/v1/models' || pathname.endsWith('/v1/models')) {
    return {
      routeType: ROUTE_TYPES.CLAUDE,
      preferredEndpoint: null,
      apiPath: '/v1/models',
      isOpenAI: true,
      isModels: true
    };
  }

  if (pathname === '/v1/chat/completions' || pathname.endsWith('/v1/chat/completions')) {
    for (const endpoint of ENDPOINTS) {
      if (endpointMatchesPath(endpoint, pathname)) {
        return {
          routeType: ROUTE_TYPES.CLAUDE,
          preferredEndpoint: endpoint,
          apiPath: '/v1/messages',
          isOpenAI: true,
          isModels: false
        };
      }
    }
    return {
      routeType: ROUTE_TYPES.CLAUDE,
      preferredEndpoint: null,
      apiPath: '/v1/messages',
      isOpenAI: true,
      isModels: false
    };
  }

  for (const endpoint of ENDPOINTS) {
    if (endpointMatchesPath(endpoint, pathname)) {
      return {
        routeType: ROUTE_TYPES.CLAUDE,
        preferredEndpoint: endpoint,
        apiPath: pathname.slice(endpoint.length) || '/',
        isOpenAI: false,
        isModels: false
      };
    }
  }

  return {
    routeType: ROUTE_TYPES.CLAUDE,
    preferredEndpoint: null,
    apiPath: pathname,
    isOpenAI: false,
    isModels: false
  };
}

function endpointMatchesPath(endpoint, pathname) {
  if (pathname === endpoint) return true;

  if (endpoint === '/claude') {
    return pathname === '/claude/v1' || pathname.startsWith('/claude/v1/');
  }

  return pathname.startsWith(endpoint + '/');
}

function isNativeCodexClientPath(pathname) {
  if (pathname === CODEX_BASE_PATH) return true;

  if (!pathname.startsWith(`${CODEX_BASE_PATH}/`)) return false;

  // `/codex` is also a Claude-compatible endpoint. Claude clients configured
  // with that base URL call `/codex/v1/messages`, which must route to the
  // official Claude-compatible Codex endpoint instead of the native Codex API.
  return pathname !== `${CODEX_BASE_PATH}/messages` &&
         !pathname.startsWith(`${CODEX_BASE_PATH}/messages/`);
}

export function isCodexChatCompletionsPath(pathname) {
  return pathname === `${CODEX_BASE_PATH}/chat/completions` ||
         pathname === `${CODEX_BASE_PATH}/chat/completions/`;
}

export function isCodexModelsPath(pathname) {
  return pathname === `${CODEX_BASE_PATH}/models` ||
         pathname === `${CODEX_BASE_PATH}/models/`;
}

export function getCodexModelIdFromPath(pathname) {
  const prefix = `${CODEX_BASE_PATH}/models/`;
  if (!pathname.startsWith(prefix)) return null;
  const raw = pathname.slice(prefix.length).trim();
  if (!raw) return null;
  return decodeURIComponent(raw);
}
