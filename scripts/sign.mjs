// Signs a release for the Windows updater (installer/updater.ps1 pins the public key and refuses anything else).
// The private key stays on the publisher's PC: REELFETCH_SIGNING_KEY, or ~/.reelfetch/update-signing-key.pem.
// New key (then put its public half into $UpdateKey in updater.ps1 - signRelease prints it when they differ):
//   node -e "require('fs').writeFileSync(process.argv[1], require('crypto').generateKeyPairSync('rsa',{modulusLength:3072}).privateKey.export({type:'pkcs8',format:'pem'}))" <file>
import { createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const keyFile = process.env.REELFETCH_SIGNING_KEY ?? join(homedir(), '.reelfetch', 'update-signing-key.pem');

/** Base64 signature (RSA PKCS#1 v1.5, SHA-256) over "<version>\n<sha256>". */
export function signRelease(version, sha256) {
  let key;
  try {
    key = readFileSync(keyFile);
  } catch {
    throw new Error(`Release signing key not found at ${keyFile} (see scripts/sign.mjs)`);
  }
  const data = Buffer.from(`${version}\n${sha256.toLowerCase()}`);
  const sig = sign('sha256', data, key);
  // The updater must accept it: check against the key pinned in updater.ps1, not against our own key.
  const ps1 = readFileSync(resolve(import.meta.dirname, '..', 'installer', 'updater.ps1'), 'utf8');
  const [, n, e] = /<Modulus>([^<]+)<\/Modulus><Exponent>([^<]+)<\/Exponent>/.exec(ps1) ?? [];
  const b64url = (s) => Buffer.from(s ?? '', 'base64').toString('base64url');
  const pinned = n && createPublicKey({ key: { kty: 'RSA', n: b64url(n), e: b64url(e) }, format: 'jwk' });
  if (!pinned || !verify('sha256', data, pinned, sig)) {
    const jwk = createPublicKey(key).export({ format: 'jwk' });
    const b64 = (s) => Buffer.from(s, 'base64url').toString('base64');
    throw new Error(
      `The signing key does not match $UpdateKey in installer/updater.ps1. Its public half is:\n<RSAKeyValue><Modulus>${b64(jwk.n)}</Modulus><Exponent>${b64(jwk.e)}</Exponent></RSAKeyValue>`,
    );
  }
  return sig.toString('base64');
}
