import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GoogleApplicationDefaultAuth } from './google-application-default-auth';

interface GoogleApplicationDefaultAuthInternals {
  buildLoginProcess(
    projectId: string | undefined,
    platform: NodeJS.Platform,
    commandInterpreter: string,
  ): { executable: string; args: string[] };
}

describe('GoogleApplicationDefaultAuth', () => {
  const originalAppData = process.env.APPDATA;
  const originalServiceAccount = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  let temporaryDirectory = '';

  beforeEach(() => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-adc-'));
    process.env.APPDATA = temporaryDirectory;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppData;

    if (originalServiceAccount === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    else process.env.GOOGLE_APPLICATION_CREDENTIALS = originalServiceAccount;

    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it('reports missing credentials without exposing a local credential path', () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(temporaryDirectory, 'missing.json');
    const status = GoogleApplicationDefaultAuth.getStatus();

    expect(status.ready).toBe(false);
    expect(status.message).toContain('umbra auth login');
    expect(status.message).not.toContain(temporaryDirectory);
  });

  it('recognizes a service-account file without reading its contents', () => {
    const credentialFile = path.join(temporaryDirectory, 'service-account.json');
    fs.writeFileSync(credentialFile, '{"private_key":"not-a-real-secret"}', 'utf8');
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialFile;

    const status = GoogleApplicationDefaultAuth.getStatus();

    expect(status).toEqual({
      ready: true,
      message: 'Vertex credentials are ready through GOOGLE_APPLICATION_CREDENTIALS.',
    });
  });

  it('launches gcloud.cmd through the Windows command interpreter', () => {
    const internals = GoogleApplicationDefaultAuth as unknown as
      GoogleApplicationDefaultAuthInternals;

    expect(internals.buildLoginProcess(
      'blue-label',
      'win32',
      'C:\\Windows\\System32\\cmd.exe',
    )).toEqual({
      executable: 'C:\\Windows\\System32\\cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        'gcloud.cmd',
        'auth',
        'application-default',
        'login',
        '--project',
        'blue-label',
      ],
    });
  });

  it('rejects an unsafe project id before starting Google Cloud CLI', async () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true);

    await expect(GoogleApplicationDefaultAuth.login('blue-label & calc'))
      .resolves.toBe(1);

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid Google Cloud project ID'),
    );
  });
});
