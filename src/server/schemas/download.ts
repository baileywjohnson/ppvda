export const downloadRequestSchema = {
  type: 'object',
  properties: {
    url: { type: 'string', format: 'uri' },
    videoUrl: { type: 'string' },
    filename: { type: 'string', maxLength: 200 },
    timeout: { type: 'number', minimum: 1000, maximum: 600000 },
  },
  anyOf: [
    { required: ['url'] },
    { required: ['videoUrl'] },
  ],
  additionalProperties: false,
} as const;

export const downloadResponseSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    data: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        filePath: { type: 'string' },
        fileSize: { type: 'number' },
        format: { type: 'string' },
        durationSec: { type: 'number' },
      },
    },
    error: { type: 'string' },
  },
} as const;
