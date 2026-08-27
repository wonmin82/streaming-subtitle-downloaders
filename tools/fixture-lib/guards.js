'use strict';

const { isObject } = require('./schema');

const SAFE_REDACTION = /^(?:REDACTED|TOKEN_[1-9]\d*|SESSION_[1-9]\d*|CONTENT_[1-9]\d*)$/;
const SECRET_KEYS = new Set([
  'authorization', 'proxyauthorization', 'cookie', 'cookies', 'setcookie', 'setcookies',
  'accesstoken', 'accesstokens', 'refreshtoken', 'refreshtokens', 'idtoken', 'idtokens',
  'sessiontoken', 'sessiontokens', 'authtoken', 'authtokens', 'token', 'tokens', 'signature',
  'signatures', 'clientsecret', 'clientsecrets', 'secret', 'secrets', 'password', 'passwd',
  'privatekey', 'privatekeys', 'secretkey', 'secretkeys', 'apikey', 'apikeys', 'credential',
  'credentials', 'policy', 'policies', 'keypairid'
]);
const DRM_KEYS = new Set([
  'pssh', 'drmdata', 'licensedata', 'licensechallenge', 'licenseresponse', 'certificatedata',
  'widevinedata', 'fairplaydata', 'playreadydata'
]);
const COPYRIGHT_TEXT_KEYS = new Set([
  'body', 'description', 'overview', 'summary', 'synopsis', 'plot', 'transcript', 'dialogue',
  'lyrics', 'subtitle', 'caption', 'subtitletext', 'captiontext'
]);
const PII_KEYS = new Set([
  'firstname', 'middlename', 'lastname', 'fullname', 'givenname', 'familyname', 'displayname', 'profilename', 'username',
  'accountname', 'subscribername', 'customername', 'viewername', 'email', 'emailaddress',
  'phone', 'phonenumber', 'address', 'birthdate', 'dateofbirth', 'gender', 'accountid',
  'profileid', 'subscriberid', 'customerid', 'userid', 'viewerid', 'deviceid'
]);
const PII_CONTAINERS = /^(?:accounts?|profiles?|subscribers?|customers?|users?|viewers?|persons?|members?)$/;
const DRM_FORMAT = /^(?:drm|license|certificate|cert|pssh|widevine|fairplay|playready|cenc)$/i;
const FORBIDDEN_ARTIFACT = /^(?:har|dom|html|page|media|video|audio|image|binary)$/i;
const DRM_PATH = /\/(?:drm|license|licenses|widevine|fairplay|playready|certificate|cert)(?:\/|$)/i;
const SECRET_QUERY = /^(?:(?:access[_-]?)?token|auth|authorization|signature|sig|policy|expires|key|api[_-]?key|credential|client[_-]?secret|key-pair-id|hdnea|hdntl|hdnts|x-amz-(?:credential|signature|security-token)|x-goog-(?:credential|signature))$/i;
const SIGNED_PATH_SEGMENT = /(?:^|[~;,])(?:dvt\d*|exp(?:ires)?|signature|sig|policy|tokens?|auth(?:orization)?|credentials?|psid|playback_?session_?id)=/i;

function normalizedKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isRedacted(value) {
  return value === null || value === '' || (typeof value === 'string' && SAFE_REDACTION.test(value));
}

function addIssue(issues, code, path, message) {
  const id = `${code}:${path}`;
  if (!issues.some(issue => issue.id === id)) issues.push({ id, code, path, message });
}

function containsSignedPathSegment(value) {
  let decoded = String(value || '');
  try { decoded = decodeURIComponent(decoded); } catch {}
  return SIGNED_PATH_SEGMENT.test(decoded);
}

function scanUrl(value, path, issues) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return;
  let url;
  try {
    url = new URL(value);
  } catch {
    addIssue(issues, 'invalid-url', path, 'contains a malformed HTTP URL');
    return;
  }
  if (url.username || url.password) addIssue(issues, 'url-credentials', path, 'contains credentials in a URL');
  for (const [key, rawValue] of url.searchParams) {
    if (SECRET_QUERY.test(key) && !isRedacted(rawValue)) {
      addIssue(issues, 'signed-url', path, 'contains an unredacted authentication or signature query value');
    }
  }
  if (DRM_PATH.test(url.pathname)) addIssue(issues, 'drm-url', path, 'contains a DRM, license, or certificate endpoint');
  for (const segment of url.pathname.split('/')) {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      // A malformed path is handled by the URL parser; treat the original segment conservatively.
    }
    if (SAFE_REDACTION.test(decoded)) continue;
    if (containsSignedPathSegment(decoded)) {
      addIssue(issues, 'signed-url', path, 'contains an unredacted path-embedded authentication or signature value');
      continue;
    }
    if (/^(?:[a-f0-9]{24,}|[A-Za-z0-9_]{32,})$/i.test(decoded)) {
      addIssue(issues, 'opaque-url-path', path, 'contains a long opaque path identifier that must be tokenized');
    }
  }
}

function scanString(value, path, issues) {
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value)) {
    addIssue(issues, 'private-key', path, 'contains private-key material');
  }
  if (/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_-]{8,}/i.test(value)) {
    addIssue(issues, 'authorization', path, 'contains an authorization credential');
  }
  if (/\b(?:Cookie|Set-Cookie|Authorization)\s*:\s*\S+/i.test(value)) {
    addIssue(issues, 'credential-header', path, 'contains a credential-bearing HTTP header');
  }
  if (/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(value)) {
    addIssue(issues, 'jwt', path, 'contains a JSON Web Token');
  }
  if (/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/.test(value)) {
    addIssue(issues, 'access-key', path, 'contains an access key or token');
  }
  if (!/\s/.test(value) && /^(?:[A-Za-z0-9+/]{256,}={0,2})$/.test(value)) {
    addIssue(issues, 'binary-blob', path, 'contains a large opaque base64 value');
  }
  if (value.split(/[\/\s"'<>]+/).some(containsSignedPathSegment)) {
    addIssue(issues, 'signed-url', path, 'contains an unredacted path-embedded authentication or signature value');
  }
  const queryPattern = /[?&]([^=&#\s]+)=([^&#\s"'<>]*)/g;
  let queryMatch;
  while ((queryMatch = queryPattern.exec(value)) !== null) {
    let queryKey = queryMatch[1];
    let queryValue = queryMatch[2];
    try { queryKey = decodeURIComponent(queryKey); } catch {}
    try { queryValue = decodeURIComponent(queryValue); } catch {}
    if (SECRET_QUERY.test(queryKey) && !isRedacted(queryValue)) {
      addIssue(issues, 'signed-url', path, 'contains an unredacted authentication or signature query value');
    }
  }
  const urls = value.match(/https?:\/\/[^\s"'<>]+/gi) || [];
  for (const url of urls) scanUrl(url.replace(/[),.;]+$/, ''), path, issues);
}

function scanTree(value, path, issues, depth = 0) {
  if (depth > 24) return;
  if (typeof value === 'string') {
    scanString(value, path, issues);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => scanTree(child, `${path}[${index}]`, issues, depth + 1));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    const normalized = normalizedKey(key);
    if (SECRET_KEYS.has(normalized) && !isRedacted(child)) {
      addIssue(issues, 'secret-field', childPath, 'contains an unredacted credential field');
    }
    if (DRM_KEYS.has(normalized) && !isRedacted(child)) {
      addIssue(issues, 'drm-field', childPath, 'contains DRM, license, or certificate data');
    }
    if ((PII_KEYS.has(normalized) || PII_CONTAINERS.test(normalized)) && !isRedacted(child)) {
      addIssue(issues, 'personal-data-field', childPath, 'contains account or profile data that has not been removed');
    }
    if (COPYRIGHT_TEXT_KEYS.has(normalized) && !isRedacted(child) && !(typeof child === 'string' && visibleTextIsPlaceholder(child))) {
      addIssue(issues, 'copyright-text-field', childPath, 'contains long-form content text instead of placeholders');
    }
    scanTree(child, childPath, issues, depth + 1);
  }
}

function visibleTextIsPlaceholder(text) {
  const withoutTags = text.replace(/<[^>]*>/g, '').replace(/&(?:nbsp|amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, ' ');
  const withoutPlaceholders = withoutTags.replace(/\b(?:CAPTION|SPEAKER|TEXT)_0*[1-9]\d*\b/g, '');
  return !/[\p{L}\p{N}]/u.test(withoutPlaceholders);
}

function scanVttOrSrt(text, path, issues) {
  const blocks = text.replace(/^\uFEFF/, '').split(/\r?\n\s*\r?\n/);
  let cueCount = 0;
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const timingIndex = lines.findIndex(line => line.includes('-->'));
    if (timingIndex >= 0) {
      cueCount++;
      const payload = lines.slice(timingIndex + 1).join('\n').trim();
      if (payload && !visibleTextIsPlaceholder(payload)) {
        addIssue(issues, 'subtitle-text', path, 'contains subtitle dialogue instead of placeholders');
      }
      continue;
    }
    if (/^NOTE(?:\s|$)/.test(lines[0] || '')) {
      const note = [lines[0].replace(/^NOTE\s*/, ''), ...lines.slice(1)].join('\n').trim();
      if (note && !visibleTextIsPlaceholder(note)) {
        addIssue(issues, 'subtitle-note', path, 'contains an unsanitized subtitle note');
      }
    }
  }
  if (!cueCount && /-->/.test(text)) addIssue(issues, 'subtitle-shape', path, 'could not validate subtitle cue text');
}

function scanTtml(text, path, issues) {
  const visible = Array.from(text.matchAll(/>([^<]+)</g), match => match[1]).join(' ').trim();
  if (visible && !visibleTextIsPlaceholder(visible)) {
    addIssue(issues, 'subtitle-text', path, 'contains TTML dialogue instead of placeholders');
  }
}

function scanSubtitleArtifact(artifact, path, issues) {
  const format = String(artifact.format || '').toLowerCase();
  const kind = String(artifact.kind || '').toLowerCase();
  const isSubtitle = /subtitle|caption|timedtext/.test(kind) || /^(?:vtt|webvtt|srt|ttml|dfxp|imsc)$/.test(format);
  if (!isSubtitle || typeof artifact.text !== 'string') return;
  if (/^(?:vtt|webvtt|srt)$/.test(format)) {
    scanVttOrSrt(artifact.text, `${path}.text`, issues);
  } else if (/^(?:ttml|dfxp|imsc)$/.test(format)) {
    scanTtml(artifact.text, `${path}.text`, issues);
  } else {
    addIssue(issues, 'subtitle-format', `${path}.format`, 'uses a subtitle format that cannot be checked for dialogue');
  }
}

function scanDrmArtifactText(artifact, path, issues) {
  if (typeof artifact.text !== 'string') return;
  if (/^#EXT-X-(?:SESSION-)?KEY\s*:(?!REDACTED\s*$)/im.test(artifact.text)) {
    addIssue(issues, 'drm-manifest', `${path}.text`, 'contains an HLS key directive that has not been removed');
  }
  if (/<(?:[\w.-]+:)?(?:pssh|pro|ContentProtection)\b/i.test(artifact.text)) {
    addIssue(issues, 'drm-manifest', `${path}.text`, 'contains DASH or XML content-protection material');
  }
}

function securityIssues(value, options = {}) {
  const issues = [];
  scanTree(value, '$', issues);
  const artifacts = options.artifacts || (isObject(value) && isObject(value.artifacts) ? value.artifacts : {});
  for (const [id, artifact] of Object.entries(artifacts)) {
    if (!isObject(artifact)) continue;
    if (DRM_FORMAT.test(String(artifact.kind || '')) || DRM_FORMAT.test(String(artifact.format || ''))) {
      addIssue(issues, 'drm-artifact', `$.artifacts.${id}`, 'contains a DRM, license, or certificate artifact');
    }
    if (FORBIDDEN_ARTIFACT.test(String(artifact.kind || '')) || FORBIDDEN_ARTIFACT.test(String(artifact.format || ''))) {
      addIssue(issues, 'forbidden-artifact', `$.artifacts.${id}`, 'contains a DOM, HAR, binary, or media artifact');
    }
    if (String(artifact.format || '').toLowerCase() === 'json' && typeof artifact.text === 'string') {
      try {
        scanTree(JSON.parse(artifact.text), `$.artifacts.${id}.parsed`, issues);
      } catch {
        addIssue(issues, 'invalid-artifact-json', `$.artifacts.${id}.text`, 'declares JSON format but does not contain valid JSON');
      }
    }
    scanDrmArtifactText(artifact, `$.artifacts.${id}`, issues);
    scanSubtitleArtifact(artifact, `$.artifacts.${id}`, issues);
  }
  return issues;
}

module.exports = {
  SAFE_REDACTION,
  securityIssues,
  visibleTextIsPlaceholder
};
