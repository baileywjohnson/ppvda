export const createJobRequestSchema = {
  type: 'object',
  properties: {
    url: { type: 'string' },
    videoUrl: { type: 'string' },
    filename: { type: 'string', maxLength: 200 },
    // Same bounds as /extract: each second of timeout pins a Chromium
    // context and a download slot.
    timeout: { type: 'number', minimum: 1000, maximum: 120000 },
    useVpn: { type: 'boolean' },
    autoPlay: { type: 'boolean' },
  },
  anyOf: [
    { required: ['url'] },
    { required: ['videoUrl'] },
  ],
  additionalProperties: false,
} as const;

export const jobResponseSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    data: {
      type: 'object',
      properties: {
        id: { type: 'string' },
      },
    },
  },
} as const;

export const jobListResponseSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    data: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string' },
          createdAt: { type: 'string' },
          updatedAt: { type: 'string' },
          error: { type: 'string' },
          videoType: { type: 'string' },
          fileSize: { type: 'number' },
          durationSec: { type: 'number' },
          format: { type: 'string' },
          darkreelMediaId: { type: 'string' },
        },
      },
    },
  },
} as const;
