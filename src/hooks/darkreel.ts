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
  detail?: string;
}

/**
 * Spawns the `drk upload` CLI to encrypt and upload a file to Darkreel.
 * Credentials are passed via environment variables (DRK_SERVER, DRK_USER, DRK_PASS)
 * instead of CLI arguments to prevent exposure in `ps aux` / /proc/pid/cmdline.
 */
export async function uploadToDarkreel(opts: DrkUploadOptions): Promise<DrkUploadResult> {
  const { drkBinaryPath, serverUrl, username, password, filePath, timeoutMs } = opts;

  // Only pass the file path as a CLI arg — credentials go through env vars.
  // Allow plaintext HTTP if the server URL isn't HTTPS (e.g., Docker internal
  // networking or reverse-proxy setups where TLS terminates upstream).
  const args = ['upload'];
  if (!serverUrl.startsWith('https://')) {
    args.push('-insecure');
  }
  args.push(filePath);

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
        // Detect auth failures from CLI output
        const combined = (stdout + stderr).toLowerCase();
        if (combined.includes('401') || combined.includes('invalid credentials') || combined.includes('login failed')) {
          resolve({ success: false, error: 'Darkreel authentication failed — check your credentials in Settings' });
        } else if (combined.includes('connect') || combined.includes('no such host') || combined.includes('connection refused')) {
          resolve({ success: false, error: 'Could not connect to Darkreel server — check the server URL in Settings' });
        } else {
          // Log the CLI's stderr for debugging — it only contains high-level
          // status ("FAILED", "Done: N uploaded, M failed"), not sensitive data.
          resolve({ success: false, error: `Upload failed (exit code ${code})`, detail: stderr.trim() || undefined });
        }
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
