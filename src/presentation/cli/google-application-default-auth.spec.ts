import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GoogleApplicationDefaultAuth } from './google-application-default-auth';

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
});
