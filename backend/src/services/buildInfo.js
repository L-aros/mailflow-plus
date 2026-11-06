import { readFileSync } from 'node:fs';

const SOURCE_REPOSITORY = 'https://github.com/L-aros/mailflow-plus';
const packageMeta = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
let baked = {};
try {
  baked = JSON.parse(readFileSync(new URL('../../build-meta.json', import.meta.url), 'utf8'));
} catch {
  // Source checkouts do not have the metadata baked into prepared images.
}

export function resolveBuildInfo(metadata, env, packageVersion) {
  // Prepared images identify their baked source even if runtime env overrides drift.
  const version = String(metadata.version || env.APP_VERSION || packageVersion).replace(/^v[.]?/, '');
  const sha = metadata.sha || env.BUILD_SHA || 'dev';
  const sourceUrl = `${SOURCE_REPOSITORY}/tree/${/^[a-f0-9]{40}$/.test(sha) ? sha : 'mailflow-plus'}`;
  return { version, sha, product: 'MailFlow Plus', sourceUrl };
}

export const BUILD_INFO = resolveBuildInfo(baked, process.env, packageMeta.version);
export const APP_VERSION = BUILD_INFO.version;
