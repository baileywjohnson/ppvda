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
 * Credentials are passed via environment variables (DRK_SERVER, DRK_USER, DRK_PASS)
 * instead of CLI arguments to prevent exposure in `ps aux` / /proc/pid/cmdline.
 */
export async function uploadToDarkreel(opts: DrkUploadOptions): Promise<DrkUploadResult> {
  const { drkBinaryPath, serverUrl, username, password, filePath, timeoutMs } = opts;

  // Only pass the file path as a CLI arg — credentials go through env vars
  const args = ['upload', filePath];

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    DRK_SERVER: serverUrl,
    DRK_USER: username,
    DRK_PASS: password,
  };

  return new Promise<DrkUploadResult>((resolve, reject) => {
    const proc = spawn(drkBinaryPath, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';

    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`drk upload timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ success: true });
      } else {
        // Return generic error — don't leak stderr which may contain URLs or paths
        resolve({ success: false, error: `Upload failed (exit code ${code})` });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve({ success: false, error: `drk binary not found at: ${drkBinaryPath}` });
      } else {
        resolve({ success: false, error: 'Upload process failed to start' });
      }
    });
  });
}
