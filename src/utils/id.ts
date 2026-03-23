import { nanoid } from 'nanoid';

export function generateId(size: number = 12): string {
  return nanoid(size);
}
