export const loginRequestSchema = {
  type: 'object',
  required: ['username', 'password'],
  properties: {
    username: { type: 'string', minLength: 1, maxLength: 256 },
    password: { type: 'string', minLength: 1, maxLength: 1024 },
  },
  additionalProperties: false,
} as const;

export const loginResponseSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    token: { type: 'string' },
  },
} as const;
