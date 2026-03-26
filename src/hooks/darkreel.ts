import { spawn } from 'node:child_process';

export interface DrkUploadOptions {
  drkBinaryPath: string;
  serverUrl: string;
  username: string;
  password: string;
  filePath: string;
  timeoutMs: number;
}

export interface DrkUploadResult {
  success: boolean;
  error?: string;
}

/**
 * Spawns the `drk upload` CLI to encrypt and upload a file to Darkreel.
 * Returns when the process exits.
 */
export async function uploadToDarkreel(opts: DrkUploadOptions): Promise<DrkUploadResult> {
  const { drkBinaryPath, serverUrl, username, password, filePath, timeoutMs } = opts;

  const args = [
    'upload',
    '-server', serverUrl,
    '-user', username,
    '-pass', password,
    filePath,
  ];

  return new Promise<DrkUploadResult>((resolve, reject) => {
    const proc = spawn(drkBinaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`drk upload timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ success: true });
      } else {
        // Sanitize error — don't include URLs or credentials
        const errorLine = stderr.trim().split('\n').pop() ?? `drk exited with code ${code}`;
        resolve({ success: false, error: errorLine });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve({ success: false, error: `drk binary not found at: ${drkBinaryPath}` });
      } else {
        resolve({ success: false, error: err.message });
      }
    });
  });
}
