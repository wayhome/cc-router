import {
  BOT_HEADERS,
  BROWSER_USER_AGENT,
  CODEX_BASE_PATH,
  CODEX_MODEL_METADATA,
  ENDPOINTS,
  ROUTE_TYPES,
  SUPPORTED_CLAUDE_MODELS,
  SUPPORTED_CODEX_MODELS,
  TARGET_BASE_URLS
} from './config.js';
import { EndpointHealthManager } from './health.js';
import {
  getCodexModelIdFromPath,
  isCodexChatCompletionsPath,
  isCodexModelsPath,
  parseRequestPath
} from './paths.js';
import { getOpenAIModelResponse, getOpenAIModelsResponse } from './models.js';
import { tryCodexSources, tryEndpoints } from './proxy.js';
import {
  applyCorsHeaders,
  jsonError,
  jsonResponse,
  sanitizeProxyResponseHeaders,
  shouldAllowHigherTierFallback
} from './utils.js';
import {
  convertClaudeStreamToOpenAI,
  convertClaudeToOpenAI,
  convertOpenAIToClaude
} from './conversions/openai-claude.js';
import {
  convertCodexResponseToOpenAIResponse,
  convertOpenAIToCodexRequest
} from './conversions/openai-codex.js';

function optionsResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400'
    }
  });
}

function prepareOpenAIRequest(request, openaiBody, claudeBody) {
  const newHeaders = new Headers(request.headers);
  newHeaders.delete('Content-Length');
  newHeaders.set('Content-Type', 'application/json');

  if (!newHeaders.has('anthropic-version')) {
    newHeaders.set('anthropic-version', '2023-06-01');
  }

  const userAgent = newHeaders.get('user-agent') || '';
  if (userAgent.includes('OpenAI') || userAgent.includes('Python') || userAgent.includes('curl')) {
    newHeaders.set('user-agent', BROWSER_USER_AGENT);

    if (!newHeaders.has('anthropic-beta')) {
      newHeaders.set('anthropic-beta', 'interleaved-thinking-2025-05-14');
    }

    BOT_HEADERS.forEach(header => newHeaders.delete(header));
  }

  return {
    request: new Request(request.url, {
      method: request.method,
      headers: newHeaders,
      body: JSON.stringify(claudeBody)
    }),
    originalModel: openaiBody.model
  };
}

async function handleCodexRoute(request, apiPath) {
  const codexModelId = getCodexModelIdFromPath(apiPath);
  if (codexModelId) {
    if (!SUPPORTED_CODEX_MODELS.includes(codexModelId)) {
      return jsonError(`Model '${codexModelId}' not found`, 'invalid_request_error', 404, {
        'Access-Control-Allow-Origin': '*',
        'X-Route-Type': ROUTE_TYPES.CODEX
      });
    }

    return jsonResponse(getOpenAIModelResponse(codexModelId, 'openai', CODEX_MODEL_METADATA), 200, {
      'Access-Control-Allow-Origin': '*',
      'X-Route-Type': ROUTE_TYPES.CODEX
    });
  }

  if (isCodexModelsPath(apiPath)) {
    return jsonResponse(getOpenAIModelsResponse(SUPPORTED_CODEX_MODELS, 'openai', CODEX_MODEL_METADATA), 200, {
      'Access-Control-Allow-Origin': '*',
      'X-Route-Type': ROUTE_TYPES.CODEX
    });
  }

  const manager = new EndpointHealthManager();
  const isCodexOpenAIChat = isCodexChatCompletionsPath(apiPath);
  let processedCodexRequest = request;
  let codexTargetPath = apiPath;
  let codexOriginalModel = null;
  let codexStreamRequest = false;

  if (isCodexOpenAIChat) {
    if (request.method !== 'POST') {
      return jsonError('Method not allowed for chat completions on codex route', 'invalid_request_error', 405, {
        'Access-Control-Allow-Origin': '*'
      });
    }

    try {
      const openaiBody = await request.clone().json();
      codexOriginalModel = openaiBody.model;

      const codexBody = convertOpenAIToCodexRequest(openaiBody);
      codexStreamRequest = codexBody.stream === true;

      const newHeaders = new Headers(request.headers);
      newHeaders.delete('Content-Length');
      newHeaders.set('Content-Type', 'application/json');
      newHeaders.set('Accept', codexStreamRequest ? 'text/event-stream' : 'application/json');

      processedCodexRequest = new Request(request.url, {
        method: request.method,
        headers: newHeaders,
        body: JSON.stringify(codexBody)
      });
      codexTargetPath = `${CODEX_BASE_PATH}/responses`;
    } catch (error) {
      return jsonError(`Invalid request body: ${error.message}`, 'invalid_request_error', 400, {
        'Access-Control-Allow-Origin': '*'
      });
    }
  }

  const codexResult = await tryCodexSources(processedCodexRequest, manager, codexTargetPath);

  if (!codexResult.success) {
    if (codexResult.response) {
      const failHeaders = sanitizeProxyResponseHeaders(codexResult.response.headers);
      applyCorsHeaders(failHeaders);
      failHeaders.set('X-Route-Type', ROUTE_TYPES.CODEX);
      if (codexResult.baseUrlIndex >= 0) {
        failHeaders.set('X-Used-Base-URL', TARGET_BASE_URLS[codexResult.baseUrlIndex]);
        failHeaders.set('X-Base-URL-Index', codexResult.baseUrlIndex.toString());
      }
      if (isCodexOpenAIChat) {
        failHeaders.set('X-Format-Conversion', 'openai-chat<->codex-responses');
      }

      return new Response(codexResult.response.body, {
        status: codexResult.response.status,
        statusText: codexResult.response.statusText,
        headers: failHeaders
      });
    }

    return jsonError('All codex sources failed', 'api_error', 503, {
      'Access-Control-Allow-Origin': '*',
      'X-Route-Type': ROUTE_TYPES.CODEX
    });
  }

  let finalResponse = codexResult.response;
  if (isCodexOpenAIChat) {
    try {
      finalResponse = await convertCodexResponseToOpenAIResponse(
        codexResult.response,
        codexOriginalModel,
        codexStreamRequest
      );
    } catch (error) {
      console.error('Failed to convert codex response to OpenAI format:', error.message, error.stack);
      return jsonError(`Failed to convert codex response: ${error.message}`, 'api_error', 502, {
        'Access-Control-Allow-Origin': '*',
        'X-Route-Type': ROUTE_TYPES.CODEX
      });
    }
  }

  const codexHeaders = sanitizeProxyResponseHeaders(finalResponse.headers);
  applyCorsHeaders(codexHeaders);
  codexHeaders.set('X-Route-Type', ROUTE_TYPES.CODEX);
  codexHeaders.set('X-Used-Base-URL', TARGET_BASE_URLS[codexResult.baseUrlIndex]);
  codexHeaders.set('X-Base-URL-Index', codexResult.baseUrlIndex.toString());
  if (isCodexOpenAIChat) {
    codexHeaders.set('X-Format-Conversion', 'openai-chat<->codex-responses');
  }

  return new Response(finalResponse.body, {
    status: finalResponse.status,
    statusText: finalResponse.statusText,
    headers: codexHeaders
  });
}

async function handleClaudeRoute(request, route) {
  const { preferredEndpoint, apiPath, isOpenAI, isModels } = route;

  if (isModels) {
    return jsonResponse(getOpenAIModelsResponse(SUPPORTED_CLAUDE_MODELS, 'anthropic'), 200, {
      'Access-Control-Allow-Origin': '*'
    });
  }

  let processedRequest = request;
  let originalModel = null;

  if (isOpenAI && request.method === 'POST') {
    try {
      const openaiBody = await request.json();
      const claudeBody = convertOpenAIToClaude(openaiBody);
      const prepared = prepareOpenAIRequest(request, openaiBody, claudeBody);
      processedRequest = prepared.request;
      originalModel = prepared.originalModel;
    } catch (error) {
      console.error('Error converting OpenAI request:', error.message, error.stack);
      return jsonError(`Invalid request body: ${error.message}`, 'invalid_request_error', 400, {
        'Access-Control-Allow-Origin': '*'
      });
    }
  }

  const manager = new EndpointHealthManager();
  const allowHigherTierFallback = shouldAllowHigherTierFallback(processedRequest.headers);
  const result = await tryEndpoints(
    processedRequest,
    manager,
    apiPath,
    preferredEndpoint,
    allowHigherTierFallback
  );

  if (!result.success) {
    if (result.response) {
      const failHeaders = sanitizeProxyResponseHeaders(result.response.headers);
      applyCorsHeaders(failHeaders);
      failHeaders.set('X-Route-Type', ROUTE_TYPES.CLAUDE);
      if (result.endpointIndex >= 0) {
        failHeaders.set('X-Used-Endpoint', ENDPOINTS[result.endpointIndex]);
        failHeaders.set('X-Endpoint-Index', result.endpointIndex.toString());
      }
      if (result.baseUrlIndex >= 0) {
        failHeaders.set('X-Used-Base-URL', TARGET_BASE_URLS[result.baseUrlIndex]);
        failHeaders.set('X-Base-URL-Index', result.baseUrlIndex.toString());
      }
      failHeaders.set('X-Allow-Higher-Tier-Fallback', allowHigherTierFallback ? 'true' : 'false');
      if (preferredEndpoint) {
        failHeaders.set('X-Preferred-Endpoint', preferredEndpoint);
      }
      if (isOpenAI) {
        failHeaders.set('X-Format-Conversion', 'OpenAI');
      }

      return new Response(result.response.body, {
        status: result.response.status,
        statusText: result.response.statusText,
        headers: failHeaders
      });
    }

    const errorBody = isOpenAI
      ? JSON.stringify({
          error: {
            message: 'All endpoints failed',
            type: 'api_error'
          }
        })
      : 'All endpoints failed';

    return new Response(errorBody, {
      status: 503,
      headers: {
        'Content-Type': isOpenAI ? 'application/json' : 'text/plain',
        'Access-Control-Allow-Origin': '*',
        'X-Route-Type': ROUTE_TYPES.CLAUDE
      }
    });
  }

  let responseBody = result.response.body;
  const responseStatus = result.response.status;
  const contentType = result.response.headers.get('content-type');
  const responseHeaders = sanitizeProxyResponseHeaders(result.response.headers);

  if (isOpenAI && responseStatus === 200) {
    if (contentType?.includes('text/event-stream')) {
      try {
        responseBody = await convertClaudeStreamToOpenAI(result.response.body, originalModel);
      } catch (error) {
        console.error('Failed to convert Claude stream to OpenAI format:', error.message, error.stack);
      }
    } else {
      try {
        const claudeResponse = await result.response.json();
        responseBody = JSON.stringify(convertClaudeToOpenAI(claudeResponse, originalModel));
      } catch (error) {
        console.error('Failed to convert Claude response to OpenAI format:', error.message, error.stack);
      }
    }
  }

  applyCorsHeaders(responseHeaders);
  responseHeaders.set('X-Route-Type', ROUTE_TYPES.CLAUDE);
  responseHeaders.set('X-Used-Endpoint', ENDPOINTS[result.endpointIndex]);
  responseHeaders.set('X-Endpoint-Index', result.endpointIndex.toString());
  responseHeaders.set('X-Used-Base-URL', TARGET_BASE_URLS[result.baseUrlIndex]);
  responseHeaders.set('X-Base-URL-Index', result.baseUrlIndex.toString());
  responseHeaders.set('X-Allow-Higher-Tier-Fallback', allowHigherTierFallback ? 'true' : 'false');
  if (preferredEndpoint) {
    responseHeaders.set('X-Preferred-Endpoint', preferredEndpoint);
  }
  if (isOpenAI) {
    responseHeaders.set('X-Format-Conversion', 'OpenAI');
  }

  return new Response(responseBody, {
    status: responseStatus,
    statusText: result.response.statusText,
    headers: responseHeaders
  });
}

export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method === 'OPTIONS') {
        return optionsResponse();
      }

      const route = parseRequestPath(request.url);

      if (route.routeType === ROUTE_TYPES.CODEX) {
        return await handleCodexRoute(request, route.apiPath);
      }

      return await handleClaudeRoute(request, route);
    } catch (error) {
      console.error('Unexpected error in worker:', error.message, error.stack);

      return jsonError(`Internal server error: ${error.message}`, 'internal_error', 500, {
        'Access-Control-Allow-Origin': '*'
      });
    }
  }
};
