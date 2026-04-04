export const streamDownloadRequestSchema = {
  type: 'object',
  required: ['videoUrl'],
  properties: {
    videoUrl: { type: 'string', minLength: 1 },
    filename: { type: 'string', maxLength: 200 },
    useVpn: { type: 'boolean' },
  },
  additionalProperties: false,
} as const;
