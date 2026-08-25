import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Safe, secret-free summary of local Google authentication readiness. */
export interface GoogleApplicationDefaultAuthStatus {
  /** Whether a supported credential source is available to the Google SDK. */
  readonly ready: boolean;
  /** User-facing state that never includes a credential value or filesystem path. */
  readonly message: string;
}

/**
 * Invokes and inspects Google Application Default Credentials for the Umbra CLI.
 *
 * This class deliberately delegates authentication to the official `gcloud`
 * command. Umbra never receives, stores, prints, or copies OAuth tokens.
 */
export class GoogleApplicationDefaultAuth {
  /**
   * Checks supported credential locations without reading credential contents.
   *
   * @returns A secret-free readiness result for `umbra auth status`.
   */
  public static getStatus(): GoogleApplicationDefaultAuthStatus {
    const serviceAccount = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (serviceAccount && fs.existsSync(path.resolve(process.cwd(), serviceAccount))) {
      return {
        ready: true,
        message: 'Vertex credentials are ready through GOOGLE_APPLICATION_CREDENTIALS.',
      };
    }

    if (fs.existsSync(GoogleApplicationDefaultAuth.getAdcPath())) {
      return {
        ready: true,
        message: 'Local Google Application Default Credentials are ready.',
      };
    }

    return {
      ready: false,
      message: 'No Google credentials found. Run "umbra auth login --project <project-id>" or configure GOOGLE_APPLICATION_CREDENTIALS.',
    };
  }

  /**
   * Starts the official interactive Google Cloud ADC login process.
   *
   * @param projectId - Optional GCP project identifier passed to the official CLI.
   * @returns The `gcloud` process exit code, or 1 when it could not start.
   */
  public static login(projectId?: string): Promise<number> {
    const args = ['auth', 'application-default', 'login'];
    if (projectId) args.push('--project', projectId);

    const executable = process.platform === 'win32' ? 'gcloud.cmd' : 'gcloud';
    return new Promise((resolve) => {
      const child = spawn(executable, args, { stdio: 'inherit' });
      child.once('error', () => {
        process.stderr.write(
          'Could not start the Google Cloud CLI. Install it from https://cloud.google.com/sdk/docs/install and retry.\n',
        );
        resolve(1);
      });
      child.once('close', (code) => resolve(code ?? 1));
    });
  }

  /**
   * Resolves the operating-system default ADC location without exposing it.
   *
   * @returns The local Application Default Credentials file path.
   */
  private static getAdcPath(): string {
    if (process.platform === 'win32') {
      const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
      return path.join(appData, 'gcloud', 'application_default_credentials.json');
    }

    return path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json');
  }
}
