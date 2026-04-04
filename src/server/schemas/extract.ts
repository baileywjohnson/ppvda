export const extractRequestSchema = {
  type: 'object',
  required: ['url'],
  properties: {
    url: { type: 'string', format: 'uri' },
    timeout: { type: 'number', minimum: 1000, maximum: 120000 },
    useVpn: { type: 'boolean' },
    includeImages: { type: 'boolean' },
  },
  additionalProperties: false,
} as const;

export const extractResponseSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    data: {
      type: 'object',
      properties: {
        pageUrl: { type: 'string' },
        pageTitle: { type: 'string' },
        videos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              url: { type: 'string' },
              type: { type: 'string' },
              mimeType: { type: 'string' },
              quality: { type: 'string' },
              fileExtension: { type: 'string' },
              discoveredVia: { type: 'string' },
            },
          },
        },
        extractedAt: { type: 'string' },
        durationMs: { type: 'number' },
      },
    },
    error: { type: 'string' },
  },
} as const;
