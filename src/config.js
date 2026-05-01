export const TARGET_BASE_URLS = [
  'https://code.newcli.com',
  'https://dm-fox.rjj.cc'
];

export const ENDPOINTS = [
  '/claude/aws',
  '/codex',
  '/claude/ultra',
  '/claude/turbo',
  '/claude/super',
  '/claude'
];

export const ENDPOINT_TIERS = {
  '/claude/aws': 0,
  '/codex': 1,
  '/claude/ultra': 2,
  '/claude/turbo': 3,
  '/claude/super': 4,
  '/claude': 5
};

export const ALLOW_HIGHER_TIER_FALLBACK_HEADER = 'x-ccr-tier';
export const CODEX_BASE_PATH = '/codex/v1';

export const ROUTE_TYPES = {
  CLAUDE: 'claude',
  CODEX: 'codex'
};

export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';

export const SUPPORTED_CLAUDE_MODELS = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001'
];

export const SUPPORTED_CODEX_MODELS = [
  'gpt-5.2',
  'gpt-5.3-codex',
  'gpt-5.4',
  'gpt-5.5',
  'gpt-image-2'
];

export const CODEX_MODEL_METADATA = {
  'gpt-5.2': {
    context_length: 400000,
    max_context_length: 400000,
    input_token_limit: 400000,
    max_output_tokens: 128000,
    max_completion_tokens: 128000,
    output_token_limit: 128000
  },
  'gpt-5.3-codex': {
    context_length: 400000,
    max_context_length: 400000,
    input_token_limit: 400000,
    max_output_tokens: 128000,
    max_completion_tokens: 128000,
    output_token_limit: 128000
  },
  'gpt-5.4': {
    context_length: 400000,
    max_context_length: 400000,
    input_token_limit: 400000,
    max_output_tokens: 128000,
    max_completion_tokens: 128000,
    output_token_limit: 128000
  },
  'gpt-5.5': {
    context_length: 400000,
    max_context_length: 400000,
    input_token_limit: 400000,
    max_output_tokens: 128000,
    max_completion_tokens: 128000,
    output_token_limit: 128000
  },
  'gpt-image-2': {
    modalities: ['image'],
    input_modalities: ['text'],
    output_modalities: ['image']
  }
};

export const HEALTH_CHECK_CONFIG = {
  COOLDOWN_TIME: 60,
  MAX_FAILURES: 3
};

export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) CherryStudio/1.7.13 Chrome/140.0.7339.249 Electron/38.7.0 Safari/537.36';

export const BOT_HEADERS = [
  'x-stainless-arch',
  'x-stainless-async',
  'x-stainless-lang',
  'x-stainless-os',
  'x-stainless-package-version',
  'x-stainless-read-timeout',
  'x-stainless-retry-count',
  'x-stainless-runtime',
  'x-stainless-runtime-version'
];
