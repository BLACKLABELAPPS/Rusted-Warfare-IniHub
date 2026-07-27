import { DurableObject } from 'cloudflare:workers';

/**
 * RW Cloud Personal — Cloudflare Worker + R2 + Durable Objects.
 *
 * Every RW Studio user deploys this Worker inside their own Cloudflare account.
 * No Google Drive, Firebase, Apps Script or central RW Studio server is used.
 */

export interface Env {
  RW_BUCKET: R2Bucket;
  RW_ACCOUNT: DurableObjectNamespace;
  RW_PROJECTS: DurableObjectNamespace;
  RW_BOOTSTRAP_SECRET: string;
  RW_FREE_MODE?: string;
  RW_MAX_STORAGE_BYTES?: string;
  RW_MAX_FILE_BYTES?: string;
  RW_LOCK_LEASE_SECONDS?: string;
  RW_SESSION_DAYS?: string;
  RW_SCHEMA_VERSION?: string;
}

type Role = 'owner' | 'editor' | 'reader';
type JsonObject = Record<string, unknown>;

interface TokenPayload {
  kind: 'account_owner' | 'project_session' | 'invite';
  exp: number;
  iat: number;
  [key: string]: unknown;
}

interface SessionClaims extends TokenPayload {
  kind: 'project_session';
  project_id: string;
  participant_id: string;
  session_id: string;
  device_id: string;
  role: Role;
}

interface AccountOwnerClaims extends TokenPayload {
  kind: 'account_owner';
  owner_id: string;
  device_id: string;
}

interface InviteClaims extends TokenPayload {
  kind: 'invite';
  project_id: string;
  invite_id: string;
  role: Role;
}

const API_VERSION = 3;
const CODE_PREFIX = 'RWLS3';
const RECOVERY_PREFIX = 'RWREC3';
const DEFAULT_MAX_STORAGE = 8 * 1024 * 1024 * 1024;
const DEFAULT_MAX_FILE = 512 * 1024 * 1024;
const DEFAULT_LEASE_SECONDS = 45;
const DEFAULT_SESSION_DAYS = 30;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    try {
      return cors(await route(request, env, ctx));
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof HttpError ? error.status : 500;
      return cors(json({ ok: false, error: message }, status));
    }
  },
};

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (request.method === 'GET' && path === '/') return landingPage(url.origin, env);
  if (request.method === 'GET' && path === '/v1/health') {
    return json({
      ok: true,
      service: 'rw-cloud-personal',
      api_version: API_VERSION,
      schema_version: env.RW_SCHEMA_VERSION ?? '3',
      free_mode: parseBool(env.RW_FREE_MODE, true),
      endpoint: url.origin,
    });
  }
  if (request.method === 'GET' && path === '/v1/setup/status') {
    return proxyAccount(env, '/status', { method: 'GET' });
  }
  if (request.method === 'POST' && path === '/v1/setup/pair') {
    return handlePair(request, env, url.origin);
  }
  if (request.method === 'POST' && path === '/v1/setup/recover') {
    return handleRecoverAccount(request, env, url.origin);
  }
  if (request.method === 'POST' && path === '/v1/projects') {
    return handleCreateProject(request, env, url.origin);
  }
  if (request.method === 'POST' && path === '/v1/invitations/inspect') {
    return handleInspectInvitation(request, env, url.origin);
  }
  if (request.method === 'POST' && path === '/v1/invitations/join') {
    return handleJoin(request, env, url.origin);
  }

  const match = path.match(/^\/v1\/projects\/([^/]+)(\/.*)?$/);
  if (!match) throw new HttpError(404, 'Route not found');
  const projectId = validateProjectId(match[1]);
  const suffix = match[2] || '';
  const claims = await requireSession(request, env, projectId);

  if (request.method === 'GET' && suffix === '/state') {
    return proxyProject(env, projectId, '/state', internalRequest('POST', { claims }));
  }
  if (request.method === 'POST' && suffix === '/presence') {
    const body = await readJson(request);
    return proxyProject(env, projectId, '/presence', internalRequest('POST', { claims, ...body }));
  }
  if (request.method === 'POST' && suffix === '/offline') {
    const body = await readJson(request, true);
    return proxyProject(env, projectId, '/offline', internalRequest('POST', { claims, ...body }));
  }
  if (request.method === 'POST' && suffix === '/locks/acquire') {
    const body = await readJson(request);
    return proxyProject(env, projectId, '/locks/acquire', internalRequest('POST', {
      claims,
      path: normalizeProjectPath(asString(body.path, 'path')),
      lease_seconds: envInt(env.RW_LOCK_LEASE_SECONDS, DEFAULT_LEASE_SECONDS),
    }));
  }
  if (request.method === 'POST' && suffix === '/locks/heartbeat') {
    const body = await readJson(request);
    return proxyProject(env, projectId, '/locks/heartbeat', internalRequest('POST', {
      claims,
      path: normalizeProjectPath(asString(body.path, 'path')),
      lease_id: asString(body.lease_id, 'lease_id'),
      active_path: optionalString(body.active_path),
      lease_seconds: envInt(env.RW_LOCK_LEASE_SECONDS, DEFAULT_LEASE_SECONDS),
    }));
  }
  if (request.method === 'POST' && suffix === '/locks/release') {
    const body = await readJson(request);
    return proxyProject(env, projectId, '/locks/release', internalRequest('POST', {
      claims,
      path: normalizeProjectPath(asString(body.path, 'path')),
      lease_id: optionalString(body.lease_id),
    }));
  }
  if (request.method === 'POST' && suffix === '/locks/release-all') {
    return proxyProject(env, projectId, '/locks/release-all', internalRequest('POST', { claims }));
  }
  if (request.method === 'GET' && suffix === '/manifest') {
    await authorizeProject(env, projectId, claims, 'reader');
    return listManifest(env, projectId, url.searchParams.get('cursor'));
  }
  if (suffix === '/files') {
    const relativePath = normalizeProjectPath(requiredQuery(url, 'path'));
    if (request.method === 'GET') return getProjectFile(env, projectId, relativePath, claims, request);
    if (request.method === 'PUT') return putProjectFile(env, projectId, relativePath, claims, request);
    if (request.method === 'DELETE') return deleteProjectFile(env, projectId, relativePath, claims, request);
  }
  if (request.method === 'POST' && suffix === '/files/rename') {
    return renameProjectFile(env, projectId, claims, request);
  }
  if (suffix === '/drafts') {
    const relativePath = normalizeProjectPath(requiredQuery(url, 'path'));
    if (request.method === 'PUT') return putDraft(env, projectId, relativePath, claims, request);
    if (request.method === 'GET') return getDraft(env, projectId, relativePath, claims);
    if (request.method === 'DELETE') return deleteDraft(env, projectId, relativePath, claims);
  }
  if (request.method === 'POST' && suffix === '/invites') {
    return createInvite(env, projectId, claims, request, url.origin);
  }
  if (request.method === 'POST' && suffix === '/invites/revoke') {
    const body = await readJson(request);
    return proxyProject(env, projectId, '/invites/revoke', internalRequest('POST', {
      claims,
      invite_id: asString(body.invite_id, 'invite_id'),
    }));
  }
  if (request.method === 'GET' && suffix === '/usage') {
    await authorizeProject(env, projectId, claims, 'reader');
    return projectUsage(env, projectId);
  }
  if (request.method === 'POST' && suffix === '/uploads/create') {
    return createMultipart(env, projectId, claims, request, url);
  }
  if (request.method === 'PUT' && suffix === '/uploads/part') {
    return uploadMultipartPart(env, projectId, claims, request, url);
  }
  if (request.method === 'POST' && suffix === '/uploads/complete') {
    return completeMultipart(env, projectId, claims, request, url);
  }
  if (request.method === 'DELETE' && suffix === '/uploads/abort') {
    return abortMultipart(env, projectId, claims, url);
  }

  throw new HttpError(404, 'Project route not found');
}

async function handlePair(request: Request, env: Env, origin: string): Promise<Response> {
  const body = await readJson(request);
  const provided = asString(body.bootstrap_secret, 'bootstrap_secret');
  if (!(await secretEquals(provided, env.RW_BOOTSTRAP_SECRET))) {
    throw new HttpError(401, 'Invalid bootstrap secret');
  }
  const nickname = cleanNickname(asString(body.nickname, 'nickname'));
  const deviceId = cleanIdentifier(asString(body.device_id, 'device_id'), 'device_id');
  const response = await proxyAccount(env, '/pair', internalRequest('POST', {
    nickname,
    device_id: deviceId,
    bootstrap_valid: true,
  }));
  const data = await responseJson(response);
  const ownerId = asString(data.owner_id, 'owner_id');
  const ownerToken = await seal(env, 'account-owner', {
    kind: 'account_owner',
    owner_id: ownerId,
    device_id: deviceId,
    iat: nowSeconds(),
    exp: nowSeconds() + 10 * 365 * 86400,
  });
  return json({ ...data, owner_token: ownerToken, endpoint: origin, api_version: API_VERSION });
}

async function handleRecoverAccount(request: Request, env: Env, origin: string): Promise<Response> {
  const body = await readJson(request);
  const nickname = cleanNickname(asString(body.nickname, 'nickname'));
  const deviceId = cleanIdentifier(asString(body.device_id, 'device_id'), 'device_id');
  const recoveryCode = asString(body.recovery_code, 'recovery_code');
  const response = await proxyAccount(env, '/recover', internalRequest('POST', {
    nickname,
    device_id: deviceId,
    recovery_hash: await digestHex(recoveryCode),
  }));
  const data = await responseJson(response);
  const ownerId = asString(data.owner_id, 'owner_id');
  const ownerToken = await seal(env, 'account-owner', {
    kind: 'account_owner',
    owner_id: ownerId,
    device_id: deviceId,
    iat: nowSeconds(),
    exp: nowSeconds() + 10 * 365 * 86400,
  });
  return json({ ...data, owner_token: ownerToken, endpoint: origin, api_version: API_VERSION });
}

async function handleCreateProject(request: Request, env: Env, origin: string): Promise<Response> {
  const owner = await requireAccountOwner(request, env);
  const body = await readJson(request);
  const name = cleanProjectName(asString(body.name, 'name'));
  const nickname = cleanNickname(optionalString(body.nickname) || 'Owner');
  const deviceId = cleanIdentifier(optionalString(body.device_id) || owner.device_id, 'device_id');
  const projectId = `p_${randomId(16)}`;
  const participantId = `usr_${randomId(14)}`;
  const sessionId = `ses_${randomId(20)}`;
  const recoveryCode = `${RECOVERY_PREFIX}-${groupCode(randomId(30).toUpperCase(), 5)}`;
  const createdAt = new Date().toISOString();
  await proxyProject(env, projectId, '/init', internalRequest('POST', {
    project_id: projectId,
    name,
    created_at: createdAt,
    owner_id: owner.owner_id,
    participant_id: participantId,
    session_id: sessionId,
    nickname,
    device_id: deviceId,
    recovery_hash: await digestHex(recoveryCode),
  }));
  await proxyAccount(env, '/projects/register', internalRequest('POST', {
    project_id: projectId,
    name,
    created_at: createdAt,
  }));
  const sessionToken = await issueSession(env, {
    project_id: projectId,
    participant_id: participantId,
    session_id: sessionId,
    device_id: deviceId,
    role: 'owner',
  });
  await writeProjectJson(env, projectId, {
    schema_version: API_VERSION,
    project_id: projectId,
    name,
    owner: nickname,
    created_at: createdAt,
    main_mod_path: 'mod/',
    community_mods_path: 'community-mods/',
    members: 1,
  });
  return json({
    ok: true,
    endpoint: origin,
    project_id: projectId,
    project_name: name,
    participant_id: participantId,
    role: 'owner',
    session_token: sessionToken,
    recovery_code: recoveryCode,
  }, 201);
}


async function handleInspectInvitation(request: Request, env: Env, origin: string): Promise<Response> {
  const body = await readJson(request);
  const code = asString(body.code, 'code').trim();
  const parsed = parseAccessCode(code);
  const codeOrigin = decodeBase64UrlText(parsed.endpointPart);
  if (normalizeOrigin(codeOrigin) !== normalizeOrigin(origin)) {
    throw new HttpError(400, 'This code belongs to another RW Cloud endpoint');
  }
  const invite = await open<InviteClaims>(env, 'invite', parsed.tokenPart);
  if (invite.kind !== 'invite' || invite.exp < nowSeconds()) {
    throw new HttpError(401, 'Invitation is invalid or expired');
  }
  return proxyProject(env, invite.project_id, '/invites/inspect', internalRequest('POST', { invite }));
}

async function handleJoin(request: Request, env: Env, origin: string): Promise<Response> {
  const body = await readJson(request);
  const code = asString(body.code, 'code').trim();
  const parsed = parseAccessCode(code);
  const codeOrigin = decodeBase64UrlText(parsed.endpointPart);
  if (normalizeOrigin(codeOrigin) !== normalizeOrigin(origin)) {
    throw new HttpError(400, 'This code belongs to another RW Cloud endpoint');
  }
  const invite = await open<InviteClaims>(env, 'invite', parsed.tokenPart);
  if (invite.kind !== 'invite' || invite.exp < nowSeconds()) {
    throw new HttpError(401, 'Invitation is invalid or expired');
  }
  const nickname = cleanNickname(asString(body.nickname, 'nickname'));
  const deviceId = cleanIdentifier(asString(body.device_id, 'device_id'), 'device_id');
  const recoveryCode = optionalString(body.recovery_code);
  const requestedParticipantId = optionalString(body.participant_id);
  const response = await proxyProject(env, invite.project_id, '/invites/join', internalRequest('POST', {
    invite,
    nickname,
    device_id: deviceId,
    recovery_hash: recoveryCode ? await digestHex(recoveryCode) : null,
    participant_id: requestedParticipantId,
  }));
  const data = await responseJson(response);
  const sessionToken = await issueSession(env, {
    project_id: invite.project_id,
    participant_id: asString(data.participant_id, 'participant_id'),
    session_id: asString(data.session_id, 'session_id'),
    device_id: deviceId,
    role: data.role as Role,
  });
  return json({ ...data, endpoint: origin, project_id: invite.project_id, session_token: sessionToken });
}

async function createInvite(
  env: Env,
  projectId: string,
  claims: SessionClaims,
  request: Request,
  origin: string,
): Promise<Response> {
  const body = await readJson(request);
  const role = parseRole(body.role, true);
  const expiresAt = optionalString(body.expires_at);
  const maxUses = clampInt(body.max_uses, 0, 100000, 0);
  const response = await proxyProject(env, projectId, '/invites/create', internalRequest('POST', {
    claims,
    role,
    expires_at: expiresAt,
    max_uses: maxUses,
  }));
  const data = await responseJson(response);
  const exp = expiresAt ? Math.floor(new Date(expiresAt).getTime() / 1000) : nowSeconds() + 10 * 365 * 86400;
  const sealed = await seal(env, 'invite', {
    kind: 'invite',
    project_id: projectId,
    invite_id: asString(data.invite_id, 'invite_id'),
    role,
    iat: nowSeconds(),
    exp,
  });
  const endpointPart = encodeBase64UrlText(normalizeOrigin(origin));
  return json({
    ...data,
    code: `${CODE_PREFIX}.${endpointPart}.${sealed}`,
    role,
    expires_at: expiresAt,
  }, 201);
}

async function getProjectFile(
  env: Env,
  projectId: string,
  relativePath: string,
  claims: SessionClaims,
  request: Request,
): Promise<Response> {
  await authorizeProject(env, projectId, claims, 'reader');
  const object = await env.RW_BUCKET.get(fileKey(projectId, relativePath), {
    onlyIf: request.headers,
    range: request.headers,
  });
  if (object === null) throw new HttpError(404, 'File not found');
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('x-rw-version', object.customMetadata?.rwVersion ?? '0');
  headers.set('x-rw-path', encodeURIComponent(relativePath));
  return new Response('body' in object ? object.body : undefined, {
    status: 'body' in object ? 200 : 412,
    headers,
  });
}

async function putProjectFile(
  env: Env,
  projectId: string,
  relativePath: string,
  claims: SessionClaims,
  request: Request,
): Promise<Response> {
  if (!request.body) throw new HttpError(400, 'Missing file body');
  const length = Number(request.headers.get('content-length') || 0);
  const maxFile = envInt(env.RW_MAX_FILE_BYTES, DEFAULT_MAX_FILE);
  if (length > maxFile) throw new HttpError(413, 'File exceeds the configured RW Cloud limit');
  const leaseId = request.headers.get('x-rw-lease-id') || '';
  const expectedEtag = stripEtag(request.headers.get('if-match'));
  const digest = request.headers.get('x-rw-digest') || '';
  const preflightResponse = await proxyProject(env, projectId, '/files/preflight', internalRequest('POST', {
    claims,
    path: relativePath,
    lease_id: leaseId,
    expected_etag: expectedEtag,
  }));
  const preflight = await responseJson(preflightResponse);
  await enforceStorageQuota(env, length);
  const current = await env.RW_BUCKET.head(fileKey(projectId, relativePath));
  if (expectedEtag && (!current || current.etag !== expectedEtag)) {
    throw new HttpError(412, 'Remote file changed; download or merge before saving');
  }
  const version = Number(preflight.next_version || 1);
  const options: R2PutOptions = {
    httpMetadata: { contentType: request.headers.get('content-type') || guessContentType(relativePath) },
    customMetadata: {
      rwVersion: String(version),
      rwUpdatedBy: claims.participant_id,
      rwUpdatedAt: new Date().toISOString(),
      rwDigest: digest,
    },
  };
  if (expectedEtag) options.onlyIf = { etagMatches: expectedEtag };
  const object = await env.RW_BUCKET.put(fileKey(projectId, relativePath), request.body, options);
  if (!object) throw new HttpError(412, 'Conditional upload failed because the remote file changed');
  await proxyProject(env, projectId, '/files/commit', internalRequest('POST', {
    claims,
    path: relativePath,
    lease_id: leaseId,
    etag: object.etag,
    size: object.size,
    version,
    digest,
  }));
  return json({ ok: true, path: relativePath, etag: object.etag, version, size: object.size });
}

async function deleteProjectFile(
  env: Env,
  projectId: string,
  relativePath: string,
  claims: SessionClaims,
  request: Request,
): Promise<Response> {
  const leaseId = request.headers.get('x-rw-lease-id') || '';
  await proxyProject(env, projectId, '/files/delete', internalRequest('POST', {
    claims,
    path: relativePath,
    lease_id: leaseId,
  }));
  await env.RW_BUCKET.delete(fileKey(projectId, relativePath));
  return json({ ok: true, path: relativePath });
}

async function renameProjectFile(env: Env, projectId: string, claims: SessionClaims, request: Request): Promise<Response> {
  const body = await readJson(request);
  const from = normalizeProjectPath(asString(body.from, 'from'));
  const to = normalizeProjectPath(asString(body.to, 'to'));
  const leaseId = optionalString(body.lease_id) || '';
  const backup = body.backup !== false;
  await proxyProject(env, projectId, '/files/rename-preflight', internalRequest('POST', {
    claims,
    from,
    to,
    lease_id: leaseId,
  }));
  const source = await env.RW_BUCKET.get(fileKey(projectId, from));
  if (!source || !('body' in source)) throw new HttpError(404, 'Source file not found');
  const bytes = await source.arrayBuffer();
  if (backup) {
    const stamp = timestampName();
    await env.RW_BUCKET.put(backupKey(projectId, stamp, from), bytes, {
      httpMetadata: source.httpMetadata,
      customMetadata: { sourcePath: from, createdAt: new Date().toISOString(), reason: 'before_rename' },
    });
  }
  const target = await env.RW_BUCKET.put(fileKey(projectId, to), bytes, {
    httpMetadata: source.httpMetadata,
    customMetadata: { ...(source.customMetadata || {}), rwUpdatedAt: new Date().toISOString(), rwUpdatedBy: claims.participant_id },
  });
  if (!target) throw new HttpError(500, 'Could not create renamed file');
  await env.RW_BUCKET.delete(fileKey(projectId, from));
  await proxyProject(env, projectId, '/files/rename-commit', internalRequest('POST', {
    claims,
    from,
    to,
    etag: target.etag,
    size: target.size,
    backup,
  }));
  return json({ ok: true, from, to, etag: target.etag, backup_created: backup });
}

async function putDraft(env: Env, projectId: string, relativePath: string, claims: SessionClaims, request: Request): Promise<Response> {
  await authorizeProject(env, projectId, claims, 'editor');
  if (!request.body) throw new HttpError(400, 'Missing draft body');
  const key = draftKey(projectId, relativePath, claims.participant_id);
  const object = await env.RW_BUCKET.put(key, request.body, {
    httpMetadata: { contentType: 'text/plain; charset=utf-8' },
    customMetadata: { path: relativePath, participantId: claims.participant_id, updatedAt: new Date().toISOString() },
  });
  await proxyProject(env, projectId, '/drafts/commit', internalRequest('POST', {
    claims,
    path: relativePath,
    key,
    etag: object?.etag ?? '',
  }));
  return json({ ok: true, path: relativePath, etag: object?.etag ?? '' });
}

async function getDraft(env: Env, projectId: string, relativePath: string, claims: SessionClaims): Promise<Response> {
  await authorizeProject(env, projectId, claims, 'reader');
  const stateResponse = await proxyProject(env, projectId, '/drafts/find', internalRequest('POST', { claims, path: relativePath }));
  const data = await responseJson(stateResponse);
  const key = optionalString(data.key);
  if (!key) throw new HttpError(404, 'Draft not found');
  const object = await env.RW_BUCKET.get(key);
  if (!object || !('body' in object)) throw new HttpError(404, 'Draft body not found');
  const headers = new Headers({ 'content-type': 'text/plain; charset=utf-8', etag: object.httpEtag });
  return new Response(object.body, { headers });
}

async function deleteDraft(env: Env, projectId: string, relativePath: string, claims: SessionClaims): Promise<Response> {
  const response = await proxyProject(env, projectId, '/drafts/delete', internalRequest('POST', { claims, path: relativePath }));
  const data = await responseJson(response);
  const key = optionalString(data.key);
  if (key) await env.RW_BUCKET.delete(key);
  return json({ ok: true, path: relativePath });
}

async function listManifest(env: Env, projectId: string, initialCursor: string | null): Promise<Response> {
  const prefix = `projects/${projectId}/files/`;
  let cursor = initialCursor || undefined;
  const entries: JsonObject[] = [];
  do {
    const page = await env.RW_BUCKET.list({ prefix, cursor, limit: 1000, include: ['customMetadata', 'httpMetadata'] });
    for (const object of page.objects) {
      entries.push({
        path: object.key.slice(prefix.length),
        etag: object.etag,
        size: object.size,
        uploaded_at: object.uploaded.toISOString(),
        version: Number(object.customMetadata?.rwVersion || 0),
        digest: object.customMetadata?.rwDigest || '',
        content_type: object.httpMetadata?.contentType || guessContentType(object.key),
      });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && entries.length < 20000);
  return json({ ok: true, project_id: projectId, files: entries, truncated: Boolean(cursor), cursor: cursor ?? null });
}

async function projectUsage(env: Env, projectId: string): Promise<Response> {
  const prefix = `projects/${projectId}/`;
  let cursor: string | undefined;
  let bytes = 0;
  let objects = 0;
  do {
    const page = await env.RW_BUCKET.list({ prefix, cursor, limit: 1000 });
    for (const object of page.objects) {
      bytes += object.size;
      objects += 1;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return json({ ok: true, project_id: projectId, bytes, objects, free_mode: parseBool(env.RW_FREE_MODE, true) });
}

async function createMultipart(env: Env, projectId: string, claims: SessionClaims, request: Request, url: URL): Promise<Response> {
  const path = normalizeProjectPath(requiredQuery(url, 'path'));
  const body = await readJson(request, true);
  const leaseId = optionalString(body.lease_id) || '';
  const expectedEtag = optionalString(body.expected_etag);
  await proxyProject(env, projectId, '/files/preflight', internalRequest('POST', {
    claims, path, lease_id: leaseId, expected_etag: expectedEtag,
  }));
  const current = await env.RW_BUCKET.head(fileKey(projectId, path));
  if (expectedEtag && (!current || current.etag !== stripEtag(expectedEtag))) {
    throw new HttpError(412, 'Remote file changed before multipart upload');
  }
  const upload = await env.RW_BUCKET.createMultipartUpload(fileKey(projectId, path), {
    httpMetadata: { contentType: optionalString(body.content_type) || guessContentType(path) },
    customMetadata: {
      participantId: claims.participant_id,
      leaseId,
      expectedEtag: expectedEtag || '',
      createdAt: new Date().toISOString(),
    },
  });
  return json({ ok: true, upload_id: upload.uploadId, key: upload.key, part_size: 8 * 1024 * 1024 }, 201);
}

async function uploadMultipartPart(env: Env, projectId: string, claims: SessionClaims, request: Request, url: URL): Promise<Response> {
  await authorizeProject(env, projectId, claims, 'editor');
  if (!request.body) throw new HttpError(400, 'Missing upload part body');
  const path = normalizeProjectPath(requiredQuery(url, 'path'));
  const uploadId = requiredQuery(url, 'upload_id');
  const partNumber = clampInt(requiredQuery(url, 'part_number'), 1, 10000, -1);
  if (partNumber < 1) throw new HttpError(400, 'Invalid part_number');
  const upload = env.RW_BUCKET.resumeMultipartUpload(fileKey(projectId, path), uploadId);
  const part = await upload.uploadPart(partNumber, request.body);
  return json({ ok: true, part_number: part.partNumber, etag: part.etag });
}

async function completeMultipart(env: Env, projectId: string, claims: SessionClaims, request: Request, url: URL): Promise<Response> {
  const path = normalizeProjectPath(requiredQuery(url, 'path'));
  const uploadId = requiredQuery(url, 'upload_id');
  const body = await readJson(request);
  const parts = Array.isArray(body.parts) ? body.parts.map((item) => {
    const row = item as JsonObject;
    return { partNumber: clampInt(row.part_number ?? row.partNumber, 1, 10000, -1), etag: asString(row.etag, 'etag') };
  }) : [];
  if (!parts.length || parts.some((item) => item.partNumber < 1)) throw new HttpError(400, 'Multipart parts are missing');
  const leaseId = optionalString(body.lease_id) || '';
  const expectedEtag = stripEtag(optionalString(body.expected_etag));
  const current = await env.RW_BUCKET.head(fileKey(projectId, path));
  if (expectedEtag && (!current || current.etag !== expectedEtag)) {
    throw new HttpError(412, 'Remote file changed before multipart completion');
  }
  const preflightResponse = await proxyProject(env, projectId, '/files/preflight', internalRequest('POST', {
    claims, path, lease_id: leaseId, expected_etag: expectedEtag,
  }));
  const preflight = await responseJson(preflightResponse);
  const upload = env.RW_BUCKET.resumeMultipartUpload(fileKey(projectId, path), uploadId);
  const object = await upload.complete(parts);
  const version = Number(preflight.next_version || 1);
  await proxyProject(env, projectId, '/files/commit', internalRequest('POST', {
    claims, path, lease_id: leaseId, etag: object.etag, size: object.size, version, digest: optionalString(body.digest) || '',
  }));
  return json({ ok: true, path, etag: object.etag, size: object.size, version });
}

async function abortMultipart(env: Env, projectId: string, claims: SessionClaims, url: URL): Promise<Response> {
  await authorizeProject(env, projectId, claims, 'editor');
  const path = normalizeProjectPath(requiredQuery(url, 'path'));
  const uploadId = requiredQuery(url, 'upload_id');
  await env.RW_BUCKET.resumeMultipartUpload(fileKey(projectId, path), uploadId).abort();
  return json({ ok: true });
}

async function authorizeProject(env: Env, projectId: string, claims: SessionClaims, minimum: Role): Promise<JsonObject> {
  const response = await proxyProject(env, projectId, '/authorize', internalRequest('POST', { claims, minimum }));
  return responseJson(response);
}

async function requireSession(request: Request, env: Env, expectedProjectId: string): Promise<SessionClaims> {
  const token = bearerToken(request);
  const claims = await open<SessionClaims>(env, 'project-session', token);
  if (claims.kind !== 'project_session' || claims.exp < nowSeconds()) throw new HttpError(401, 'Session expired');
  if (claims.project_id !== expectedProjectId) throw new HttpError(403, 'Session belongs to another project');
  return claims;
}

async function requireAccountOwner(request: Request, env: Env): Promise<AccountOwnerClaims> {
  const token = bearerToken(request);
  const claims = await open<AccountOwnerClaims>(env, 'account-owner', token);
  if (claims.kind !== 'account_owner' || claims.exp < nowSeconds()) throw new HttpError(401, 'Owner session expired');
  return claims;
}

async function issueSession(env: Env, values: Omit<SessionClaims, 'kind' | 'iat' | 'exp'>): Promise<string> {
  const days = envInt(env.RW_SESSION_DAYS, DEFAULT_SESSION_DAYS);
  return seal(env, 'project-session', {
    kind: 'project_session',
    ...values,
    iat: nowSeconds(),
    exp: nowSeconds() + days * 86400,
  });
}

async function proxyAccount(env: Env, path: string, init: RequestInit): Promise<Response> {
  const id = env.RW_ACCOUNT.idFromName('rw-cloud-account');
  return env.RW_ACCOUNT.get(id).fetch(`https://rw-account.internal${path}`, init);
}

async function proxyProject(env: Env, projectId: string, path: string, init: RequestInit): Promise<Response> {
  const id = env.RW_PROJECTS.idFromName(projectId);
  const response = await env.RW_PROJECTS.get(id).fetch(`https://rw-project.internal${path}`, init);
  if (!response.ok) {
    const data = await response.clone().json().catch(() => ({ error: response.statusText })) as JsonObject;
    throw new HttpError(response.status, optionalString(data.error) || 'Project coordinator rejected the request');
  }
  return response;
}

function internalRequest(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json', 'x-rw-internal': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

export class AccountCoordinator extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'GET' && path === '/status') {
      const owner = await this.ctx.storage.get<JsonObject>('owner');
      return json({ ok: true, claimed: Boolean(owner), owner_nickname: owner?.nickname ?? null });
    }
    if (request.method === 'POST' && path === '/pair') {
      const body = await readJson(request);
      let owner = await this.ctx.storage.get<JsonObject>('owner');
      let recoveryCode: string | null = null;
      if (!owner) {
        recoveryCode = `${RECOVERY_PREFIX}-${groupCode(randomId(30).toUpperCase(), 5)}`;
        owner = {
          owner_id: `own_${randomId(14)}`,
          nickname: cleanNickname(asString(body.nickname, 'nickname')),
          created_at: new Date().toISOString(),
          recovery_hash: await digestHex(recoveryCode),
        };
        await this.ctx.storage.put('owner', owner);
      }
      return json({ ok: true, owner_id: owner.owner_id, owner_nickname: owner.nickname, recovery_code: recoveryCode });
    }
    if (request.method === 'POST' && path === '/recover') {
      const body = await readJson(request);
      const owner = await this.ctx.storage.get<JsonObject>('owner');
      if (!owner) throw new HttpError(404, 'RW Cloud has not been paired yet');
      if (!(await textEquals(asString(body.recovery_hash, 'recovery_hash'), asString(owner.recovery_hash, 'stored recovery hash')))) {
        throw new HttpError(401, 'Invalid account recovery code');
      }
      return json({ ok: true, owner_id: owner.owner_id, owner_nickname: owner.nickname });
    }
    if (request.method === 'POST' && path === '/projects/register') {
      const body = await readJson(request);
      await this.ctx.storage.put(`project:${asString(body.project_id, 'project_id')}`, body);
      return json({ ok: true });
    }
    throw new HttpError(404, 'Account coordinator route not found');
  }
}

export class ProjectCoordinator extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const body = request.method === 'GET' ? {} : await readJson(request, true);
      if (request.method === 'POST' && path === '/init') return this.initProject(body);
      if (request.method === 'POST' && path === '/authorize') return this.authorize(body);
      if (request.method === 'POST' && path === '/state') return this.state(body);
      if (request.method === 'POST' && path === '/presence') return this.presence(body);
      if (request.method === 'POST' && path === '/offline') return this.offline(body);
      if (request.method === 'POST' && path === '/locks/acquire') return this.acquireLock(body);
      if (request.method === 'POST' && path === '/locks/heartbeat') return this.heartbeatLock(body);
      if (request.method === 'POST' && path === '/locks/release') return this.releaseLock(body);
      if (request.method === 'POST' && path === '/locks/release-all') return this.releaseAll(body);
      if (request.method === 'POST' && path === '/files/preflight') return this.filePreflight(body);
      if (request.method === 'POST' && path === '/files/commit') return this.fileCommit(body);
      if (request.method === 'POST' && path === '/files/delete') return this.fileDelete(body);
      if (request.method === 'POST' && path === '/files/rename-preflight') return this.renamePreflight(body);
      if (request.method === 'POST' && path === '/files/rename-commit') return this.renameCommit(body);
      if (request.method === 'POST' && path === '/drafts/commit') return this.draftCommit(body);
      if (request.method === 'POST' && path === '/drafts/find') return this.draftFind(body);
      if (request.method === 'POST' && path === '/drafts/delete') return this.draftDelete(body);
      if (request.method === 'POST' && path === '/invites/create') return this.inviteCreate(body);
      if (request.method === 'POST' && path === '/invites/inspect') return this.inviteInspect(body);
      if (request.method === 'POST' && path === '/invites/join') return this.inviteJoin(body);
      if (request.method === 'POST' && path === '/invites/revoke') return this.inviteRevoke(body);
      throw new HttpError(404, 'Project coordinator route not found');
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      return json({ ok: false, error: message }, status);
    }
  }

  private async initProject(body: JsonObject): Promise<Response> {
    if (await this.ctx.storage.get('meta')) throw new HttpError(409, 'Project already exists');
    const meta = {
      project_id: asString(body.project_id, 'project_id'),
      name: cleanProjectName(asString(body.name, 'name')),
      created_at: asString(body.created_at, 'created_at'),
      owner_id: asString(body.owner_id, 'owner_id'),
      version: 1,
    };
    const participant = {
      participant_id: asString(body.participant_id, 'participant_id'),
      nickname: cleanNickname(asString(body.nickname, 'nickname')),
      role: 'owner' as Role,
      recovery_hash: asString(body.recovery_hash, 'recovery_hash'),
      created_at: new Date().toISOString(),
      last_seen: new Date().toISOString(),
      online: true,
      active_path: null,
    };
    const session = {
      session_id: asString(body.session_id, 'session_id'),
      participant_id: participant.participant_id,
      device_id: asString(body.device_id, 'device_id'),
      role: 'owner' as Role,
      revoked: false,
      created_at: new Date().toISOString(),
      last_seen: new Date().toISOString(),
    };
    await this.ctx.storage.put({
      meta,
      [`participant:${participant.participant_id}`]: participant,
      [`session:${session.session_id}`]: session,
    });
    await this.addHistory(participant.nickname, 'room_created', '', meta.name);
    return json({ ok: true });
  }

  private async authenticate(body: JsonObject, minimum: Role = 'reader'): Promise<{ claims: SessionClaims; participant: JsonObject; session: JsonObject }> {
    const claims = body.claims as unknown as SessionClaims;
    if (!claims || claims.kind !== 'project_session') throw new HttpError(401, 'Missing project session');
    const session = await this.ctx.storage.get<JsonObject>(`session:${claims.session_id}`);
    if (!session || session.revoked === true) throw new HttpError(401, 'Session is revoked');
    if (session.participant_id !== claims.participant_id || session.device_id !== claims.device_id) {
      throw new HttpError(401, 'Session identity mismatch');
    }
    const participant = await this.ctx.storage.get<JsonObject>(`participant:${claims.participant_id}`);
    if (!participant) throw new HttpError(401, 'Participant no longer exists');
    const role = parseRole(participant.role, true);
    if (roleRank(role) < roleRank(minimum)) throw new HttpError(403, 'Role does not permit this operation');
    return { claims: { ...claims, role }, participant, session };
  }

  private async authorize(body: JsonObject): Promise<Response> {
    const auth = await this.authenticate(body, parseRole(body.minimum, true));
    return json({ ok: true, participant_id: auth.claims.participant_id, role: auth.claims.role });
  }

  private async state(body: JsonObject): Promise<Response> {
    await this.authenticate(body, 'reader');
    await this.expireLocks();
    const meta = await this.ctx.storage.get<JsonObject>('meta');
    const participantRows = await this.ctx.storage.list<JsonObject>({ prefix: 'participant:' });
    const lockRows = await this.ctx.storage.list<JsonObject>({ prefix: 'lock:' });
    const historyRows = await this.ctx.storage.list<JsonObject>({ prefix: 'history:', reverse: true, limit: 100 });
    const draftRows = await this.ctx.storage.list<JsonObject>({ prefix: 'draft:' });
    return json({
      ok: true,
      project: meta,
      participants: [...participantRows.values()],
      locks: [...lockRows.values()],
      history: [...historyRows.values()],
      drafts: [...draftRows.values()],
    });
  }

  private async presence(body: JsonObject): Promise<Response> {
    const { claims, participant, session } = await this.authenticate(body, 'reader');
    const now = new Date().toISOString();
    participant.online = true;
    participant.last_seen = now;
    participant.active_path = optionalString(body.active_path);
    session.last_seen = now;
    await this.ctx.storage.put({
      [`participant:${claims.participant_id}`]: participant,
      [`session:${claims.session_id}`]: session,
    });
    return json({ ok: true, server_time: now });
  }

  private async offline(body: JsonObject): Promise<Response> {
    const { claims, participant, session } = await this.authenticate(body, 'reader');
    participant.online = false;
    participant.active_path = null;
    participant.last_seen = new Date().toISOString();
    session.last_seen = participant.last_seen;
    await this.ctx.storage.put({
      [`participant:${claims.participant_id}`]: participant,
      [`session:${claims.session_id}`]: session,
    });
    await this.releaseAllForParticipant(claims.participant_id);
    return json({ ok: true });
  }

  private async acquireLock(body: JsonObject): Promise<Response> {
    const { claims, participant } = await this.authenticate(body, 'editor');
    await this.expireLocks();
    const path = normalizeProjectPath(asString(body.path, 'path'));
    const key = `lock:${await digestHex(path)}`;
    const current = await this.ctx.storage.get<JsonObject>(key);
    if (current && current.participant_id !== claims.participant_id) {
      const holder = await this.ctx.storage.get<JsonObject>(`participant:${current.participant_id}`);
      return json({ ok: true, allowed: false, holder: holder?.nickname ?? 'Another participant', expires_at: current.expires_at });
    }
    const leaseId = current?.lease_id?.toString() || `lease_${randomId(22)}`;
    const leaseSeconds = clampInt(body.lease_seconds, 15, 300, DEFAULT_LEASE_SECONDS);
    const lock = {
      path,
      lease_id: leaseId,
      participant_id: claims.participant_id,
      device_id: claims.device_id,
      nickname: participant.nickname,
      acquired_at: current?.acquired_at ?? new Date().toISOString(),
      expires_at: new Date(Date.now() + leaseSeconds * 1000).toISOString(),
      fencing_token: Number(current?.fencing_token || 0) + 1,
    };
    await this.ctx.storage.put(key, lock);
    await this.addHistory(participant.nickname as string, 'lock_acquired', path, null);
    return json({ ok: true, allowed: true, ...lock });
  }

  private async heartbeatLock(body: JsonObject): Promise<Response> {
    const { claims, participant, session } = await this.authenticate(body, 'editor');
    const path = normalizeProjectPath(asString(body.path, 'path'));
    const key = `lock:${await digestHex(path)}`;
    const lock = await this.ctx.storage.get<JsonObject>(key);
    if (!lock || lock.participant_id !== claims.participant_id || lock.lease_id !== body.lease_id) {
      throw new HttpError(409, 'The edit lease is no longer owned by this device');
    }
    const leaseSeconds = clampInt(body.lease_seconds, 15, 300, DEFAULT_LEASE_SECONDS);
    lock.expires_at = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    participant.online = true;
    participant.last_seen = new Date().toISOString();
    participant.active_path = optionalString(body.active_path) || path;
    session.last_seen = participant.last_seen;
    await this.ctx.storage.put({
      [key]: lock,
      [`participant:${claims.participant_id}`]: participant,
      [`session:${claims.session_id}`]: session,
    });
    return json({ ok: true, expires_at: lock.expires_at });
  }

  private async releaseLock(body: JsonObject): Promise<Response> {
    const { claims, participant } = await this.authenticate(body, 'reader');
    const path = normalizeProjectPath(asString(body.path, 'path'));
    const key = `lock:${await digestHex(path)}`;
    const lock = await this.ctx.storage.get<JsonObject>(key);
    if (lock && lock.participant_id === claims.participant_id) {
      const requestedLease = optionalString(body.lease_id);
      if (!requestedLease || requestedLease === lock.lease_id) {
        await this.ctx.storage.delete(key);
        await this.addHistory(participant.nickname as string, 'lock_released', path, null);
      }
    }
    return json({ ok: true });
  }

  private async releaseAll(body: JsonObject): Promise<Response> {
    const { claims } = await this.authenticate(body, 'reader');
    await this.releaseAllForParticipant(claims.participant_id);
    return json({ ok: true });
  }

  private async releaseAllForParticipant(participantId: string): Promise<void> {
    const locks = await this.ctx.storage.list<JsonObject>({ prefix: 'lock:' });
    const deletes: string[] = [];
    for (const [key, lock] of locks) if (lock.participant_id === participantId) deletes.push(key);
    if (deletes.length) await this.ctx.storage.delete(deletes);
  }

  private async expireLocks(): Promise<void> {
    const now = Date.now();
    const locks = await this.ctx.storage.list<JsonObject>({ prefix: 'lock:' });
    const deletes: string[] = [];
    for (const [key, lock] of locks) {
      const expiry = Date.parse(String(lock.expires_at || ''));
      if (!Number.isFinite(expiry) || expiry <= now) deletes.push(key);
    }
    if (deletes.length) await this.ctx.storage.delete(deletes);
  }

  private async filePreflight(body: JsonObject): Promise<Response> {
    const { claims } = await this.authenticate(body, 'editor');
    const path = normalizeProjectPath(asString(body.path, 'path'));
    await this.requireLease(claims, path, asString(body.lease_id, 'lease_id'));
    const version = Number(await this.ctx.storage.get<number>(`version:${path}`) || 0);
    return json({ ok: true, next_version: version + 1 });
  }

  private async fileCommit(body: JsonObject): Promise<Response> {
    const { claims, participant } = await this.authenticate(body, 'editor');
    const path = normalizeProjectPath(asString(body.path, 'path'));
    await this.requireLease(claims, path, asString(body.lease_id, 'lease_id'));
    const version = clampInt(body.version, 1, Number.MAX_SAFE_INTEGER, 1);
    await this.ctx.storage.put({
      [`version:${path}`]: version,
      [`file:${path}`]: {
        path,
        etag: asString(body.etag, 'etag'),
        size: Number(body.size || 0),
        version,
        digest: optionalString(body.digest) || '',
        updated_at: new Date().toISOString(),
        updated_by: claims.participant_id,
      },
    });
    await this.addHistory(participant.nickname as string, 'file_saved', path, `v${version}`);
    return json({ ok: true });
  }

  private async fileDelete(body: JsonObject): Promise<Response> {
    const { claims, participant } = await this.authenticate(body, 'editor');
    const path = normalizeProjectPath(asString(body.path, 'path'));
    await this.requireLease(claims, path, asString(body.lease_id, 'lease_id'));
    await this.ctx.storage.delete([`file:${path}`, `version:${path}`]);
    await this.addHistory(participant.nickname as string, 'item_deleted', path, null);
    return json({ ok: true });
  }

  private async renamePreflight(body: JsonObject): Promise<Response> {
    const { claims } = await this.authenticate(body, 'editor');
    const from = normalizeProjectPath(asString(body.from, 'from'));
    normalizeProjectPath(asString(body.to, 'to'));
    await this.requireLease(claims, from, asString(body.lease_id, 'lease_id'));
    return json({ ok: true });
  }

  private async renameCommit(body: JsonObject): Promise<Response> {
    const { participant } = await this.authenticate(body, 'editor');
    const from = normalizeProjectPath(asString(body.from, 'from'));
    const to = normalizeProjectPath(asString(body.to, 'to'));
    const oldVersion = Number(await this.ctx.storage.get<number>(`version:${from}`) || 0);
    await this.ctx.storage.delete([`file:${from}`, `version:${from}`]);
    await this.ctx.storage.put({
      [`version:${to}`]: oldVersion + 1,
      [`file:${to}`]: {
        path: to,
        etag: asString(body.etag, 'etag'),
        size: Number(body.size || 0),
        version: oldVersion + 1,
        updated_at: new Date().toISOString(),
      },
    });
    await this.addHistory(participant.nickname as string, 'item_renamed', from, `${to}${body.backup ? ' · backup' : ''}`);
    return json({ ok: true });
  }

  private async requireLease(claims: SessionClaims, path: string, leaseId: string): Promise<JsonObject> {
    await this.expireLocks();
    const lock = await this.ctx.storage.get<JsonObject>(`lock:${await digestHex(path)}`);
    if (!lock || lock.participant_id !== claims.participant_id || lock.device_id !== claims.device_id || lock.lease_id !== leaseId) {
      throw new HttpError(409, 'A valid edit lease is required for this file');
    }
    return lock;
  }

  private async draftCommit(body: JsonObject): Promise<Response> {
    const { claims, participant } = await this.authenticate(body, 'editor');
    const path = normalizeProjectPath(asString(body.path, 'path'));
    const record = {
      path,
      key: asString(body.key, 'key'),
      etag: optionalString(body.etag) || '',
      participant_id: claims.participant_id,
      nickname: participant.nickname,
      updated_at: new Date().toISOString(),
    };
    await this.ctx.storage.put(`draft:${await digestHex(path)}:${claims.participant_id}`, record);
    await this.addHistory(participant.nickname as string, 'draft_saved', path, null);
    return json({ ok: true });
  }

  private async draftFind(body: JsonObject): Promise<Response> {
    await this.authenticate(body, 'reader');
    const path = normalizeProjectPath(asString(body.path, 'path'));
    const rows = await this.ctx.storage.list<JsonObject>({ prefix: `draft:${await digestHex(path)}:` });
    const sorted = [...rows.values()].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    return json({ ok: true, ...(sorted[0] || {}) });
  }

  private async draftDelete(body: JsonObject): Promise<Response> {
    const { claims } = await this.authenticate(body, 'editor');
    const path = normalizeProjectPath(asString(body.path, 'path'));
    const key = `draft:${await digestHex(path)}:${claims.participant_id}`;
    const record = await this.ctx.storage.get<JsonObject>(key);
    await this.ctx.storage.delete(key);
    return json({ ok: true, key: record?.key ?? null });
  }

  private async inviteCreate(body: JsonObject): Promise<Response> {
    const { participant } = await this.authenticate(body, 'owner');
    const inviteId = `inv_${randomId(18)}`;
    const record = {
      invite_id: inviteId,
      role: parseRole(body.role, true),
      expires_at: optionalString(body.expires_at),
      max_uses: clampInt(body.max_uses, 0, 100000, 0),
      uses: 0,
      revoked: false,
      created_at: new Date().toISOString(),
      created_by: participant.nickname,
    };
    await this.ctx.storage.put(`invite:${inviteId}`, record);
    await this.addHistory(participant.nickname as string, 'invite_created', '', record.role as string);
    return json({ ok: true, ...record });
  }


  private async inviteInspect(body: JsonObject): Promise<Response> {
    const invite = body.invite as unknown as InviteClaims;
    if (!invite || invite.kind !== 'invite') throw new HttpError(401, 'Invalid invitation payload');
    const record = await this.ctx.storage.get<JsonObject>(`invite:${invite.invite_id}`);
    if (!record || record.revoked === true) throw new HttpError(401, 'Invitation was revoked');
    if (record.expires_at && Date.parse(String(record.expires_at)) <= Date.now()) throw new HttpError(401, 'Invitation expired');
    const meta = await this.ctx.storage.get<JsonObject>('meta');
    return json({
      ok: true,
      project_id: invite.project_id,
      project_name: meta?.name ?? 'RW Cloud project',
      role: record.role,
      expires_at: record.expires_at ?? null,
      known_participants: await this.knownParticipants(),
    });
  }

  private async inviteJoin(body: JsonObject): Promise<Response> {
    const invite = body.invite as unknown as InviteClaims;
    if (!invite || invite.kind !== 'invite') throw new HttpError(401, 'Invalid invitation payload');
    const record = await this.ctx.storage.get<JsonObject>(`invite:${invite.invite_id}`);
    if (!record || record.revoked === true) throw new HttpError(401, 'Invitation was revoked');
    if (record.expires_at && Date.parse(String(record.expires_at)) <= Date.now()) throw new HttpError(401, 'Invitation expired');
    const maxUses = Number(record.max_uses || 0);
    const uses = Number(record.uses || 0);
    if (maxUses > 0 && uses >= maxUses) throw new HttpError(401, 'Invitation usage limit reached');
    const nickname = cleanNickname(asString(body.nickname, 'nickname'));
    const deviceId = cleanIdentifier(asString(body.device_id, 'device_id'), 'device_id');
    let participant: JsonObject | undefined;
    const requestedId = optionalString(body.participant_id);
    const recoveryHash = optionalString(body.recovery_hash);
    if (requestedId && recoveryHash) {
      const existing = await this.ctx.storage.get<JsonObject>(`participant:${requestedId}`);
      if (existing && await textEquals(String(existing.recovery_hash || ''), recoveryHash)) participant = existing;
    }
    let recoveryCode: string | null = null;
    if (!participant) {
      recoveryCode = `${RECOVERY_PREFIX}-${groupCode(randomId(30).toUpperCase(), 5)}`;
      participant = {
        participant_id: `usr_${randomId(14)}`,
        nickname,
        role: record.role,
        recovery_hash: await digestHex(recoveryCode),
        created_at: new Date().toISOString(),
        last_seen: new Date().toISOString(),
        online: true,
        active_path: null,
      };
    } else {
      participant.nickname = nickname;
      participant.online = true;
      participant.last_seen = new Date().toISOString();
      participant.role = record.role;
    }
    const sessionId = `ses_${randomId(20)}`;
    const session = {
      session_id: sessionId,
      participant_id: participant.participant_id,
      device_id: deviceId,
      role: participant.role,
      revoked: false,
      created_at: new Date().toISOString(),
      last_seen: new Date().toISOString(),
    };
    record.uses = uses + 1;
    await this.ctx.storage.put({
      [`participant:${participant.participant_id}`]: participant,
      [`session:${sessionId}`]: session,
      [`invite:${invite.invite_id}`]: record,
    });
    await this.addHistory(nickname, 'participant_joined', '', participant.role as string);
    const meta = await this.ctx.storage.get<JsonObject>('meta');
    return json({
      ok: true,
      participant_id: participant.participant_id,
      nickname,
      role: participant.role,
      session_id: sessionId,
      recovery_code: recoveryCode,
      project_name: meta?.name ?? 'RW Cloud project',
      known_participants: await this.knownParticipants(),
    });
  }

  private async inviteRevoke(body: JsonObject): Promise<Response> {
    await this.authenticate(body, 'owner');
    const inviteId = asString(body.invite_id, 'invite_id');
    const record = await this.ctx.storage.get<JsonObject>(`invite:${inviteId}`);
    if (!record) throw new HttpError(404, 'Invitation not found');
    record.revoked = true;
    await this.ctx.storage.put(`invite:${inviteId}`, record);
    return json({ ok: true });
  }

  private async knownParticipants(): Promise<JsonObject[]> {
    const rows = await this.ctx.storage.list<JsonObject>({ prefix: 'participant:' });
    return [...rows.values()].map((row) => ({
      participant_id: row.participant_id,
      nickname: row.nickname,
      role: row.role,
    }));
  }

  private async addHistory(nickname: string, action: string, path: string, details: string | null): Promise<void> {
    const when = new Date().toISOString();
    const key = `history:${String(Date.now()).padStart(13, '0')}:${randomId(8)}`;
    await this.ctx.storage.put(key, { when, nickname, action, path, details });
  }
}

async function writeProjectJson(env: Env, projectId: string, project: JsonObject): Promise<void> {
  await env.RW_BUCKET.put(`projects/${projectId}/project.json`, JSON.stringify(project, null, 2), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
}

async function enforceStorageQuota(env: Env, incomingBytes: number): Promise<void> {
  if (!parseBool(env.RW_FREE_MODE, true)) return;
  const limit = envInt(env.RW_MAX_STORAGE_BYTES, DEFAULT_MAX_STORAGE);
  let cursor: string | undefined;
  let total = 0;
  do {
    const page = await env.RW_BUCKET.list({ cursor, limit: 1000 });
    for (const item of page.objects) total += item.size;
    if (total + incomingBytes > limit) throw new HttpError(507, 'RW Cloud free-mode storage guard reached');
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

function landingPage(origin: string, env: Env): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RW Cloud Personal</title><style>
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#10141a;color:#eef2f7;margin:0;padding:32px}main{max-width:760px;margin:auto;background:#171d25;border:1px solid #2a3441;border-radius:18px;padding:28px}code{background:#0b0f14;padding:4px 7px;border-radius:6px;word-break:break-all}.ok{color:#73c991}.muted{color:#a9b4c2}button{padding:10px 14px;border:0;border-radius:8px;background:#377ad8;color:white;cursor:pointer}</style></head>
<body><main><h1>RW Cloud Personal</h1><p class="ok">Worker deployed and responding.</p>
<p>Return to RW Studio and paste this endpoint:</p><p><code id="endpoint">${escapeHtml(origin)}</code></p>
<button onclick="navigator.clipboard.writeText(document.getElementById('endpoint').textContent)">Copy endpoint</button>
<p class="muted">The bootstrap secret is never displayed here. Use the secret generated by RW Studio during deployment.</p>
<p>API version: ${API_VERSION} · Free-mode guard: ${parseBool(env.RW_FREE_MODE, true) ? 'enabled' : 'disabled'}</p></main></body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function fileKey(projectId: string, path: string): string { return `projects/${projectId}/files/${path}`; }
function draftKey(projectId: string, path: string, participantId: string): string {
  return `projects/${projectId}/.rwstudio/drafts/${encodeBase64UrlText(path)}/${participantId}.txt`;
}
function backupKey(projectId: string, stamp: string, path: string): string {
  return `projects/${projectId}/.rwstudio/backups/${stamp}/${path}`;
}

function parseAccessCode(code: string): { endpointPart: string; tokenPart: string } {
  const parts = code.split('.');
  if (parts.length !== 3 || parts[0] !== CODE_PREFIX) throw new HttpError(400, 'Invalid RW Live Share code format');
  return { endpointPart: parts[1], tokenPart: parts[2] };
}

async function seal(env: Env, purpose: string, payload: TokenPayload): Promise<string> {
  const key = await aesKey(env, purpose, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = encoder.encode(JSON.stringify(payload));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(`RWLS:${purpose}:v3`) }, key, plain));
  const combined = new Uint8Array(iv.length + cipher.length);
  combined.set(iv, 0); combined.set(cipher, iv.length);
  return base64Url(combined);
}

async function open<T extends TokenPayload>(env: Env, purpose: string, token: string): Promise<T> {
  try {
    const bytes = fromBase64Url(token);
    if (bytes.length < 29) throw new Error('short token');
    const iv = bytes.slice(0, 12);
    const cipher = bytes.slice(12);
    const key = await aesKey(env, purpose, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(`RWLS:${purpose}:v3`) }, key, cipher);
    const payload = JSON.parse(decoder.decode(plain)) as T;
    if (!payload || typeof payload !== 'object') throw new Error('invalid payload');
    return payload;
  } catch {
    throw new HttpError(401, 'Invalid or altered RW Cloud token');
  }
}

async function aesKey(env: Env, purpose: string, usages: KeyUsage[]): Promise<CryptoKey> {
  if (!env.RW_BOOTSTRAP_SECRET || env.RW_BOOTSTRAP_SECRET.length < 20) {
    throw new HttpError(503, 'RW_BOOTSTRAP_SECRET is missing or too short');
  }
  const material = await crypto.subtle.digest('SHA-256', encoder.encode(`RW Cloud Personal|${purpose}|${env.RW_BOOTSTRAP_SECRET}`));
  return crypto.subtle.importKey('raw', material, 'AES-GCM', false, usages);
}

function bearerToken(request: Request): string {
  const value = request.headers.get('authorization') || '';
  if (!value.toLowerCase().startsWith('bearer ')) throw new HttpError(401, 'Missing Bearer token');
  return value.slice(7).trim();
}

async function readJson(request: Request, allowEmpty = false): Promise<JsonObject> {
  const text = await request.text();
  if (!text.trim()) {
    if (allowEmpty) return {};
    throw new HttpError(400, 'JSON body required');
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as JsonObject;
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

async function responseJson(response: Response): Promise<JsonObject> {
  const data = await response.json().catch(() => null) as JsonObject | null;
  if (!response.ok) throw new HttpError(response.status, optionalString(data?.error) || response.statusText);
  if (!data) throw new HttpError(502, 'Coordinator returned an empty response');
  return data;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

function cors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', '*');
  headers.set('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
  headers.set('access-control-allow-headers', 'authorization,content-type,if-match,if-none-match,range,x-rw-lease-id,x-rw-digest');
  headers.set('access-control-expose-headers', 'etag,x-rw-version,x-rw-path,content-range');
  headers.set('x-content-type-options', 'nosniff');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function normalizeProjectPath(value: string): string {
  let path = value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/').trim();
  if (!path || path.length > 900) throw new HttpError(400, 'Invalid project path');
  const segments = path.split('/');
  if (segments.some((part) => !part || part === '.' || part === '..' || /[\u0000-\u001f]/.test(part))) {
    throw new HttpError(400, 'Unsafe project path');
  }
  if (path === '.rwstudio' || path.startsWith('.rwstudio/')) throw new HttpError(403, 'The .rwstudio path is reserved');
  return path;
}

function validateProjectId(value: string): string {
  if (!/^p_[a-zA-Z0-9_-]{8,40}$/.test(value)) throw new HttpError(400, 'Invalid project ID');
  return value;
}

function cleanIdentifier(value: string, name: string): string {
  const result = value.trim();
  if (!/^[a-zA-Z0-9_.:-]{4,120}$/.test(result)) throw new HttpError(400, `Invalid ${name}`);
  return result;
}

function cleanNickname(value: string): string {
  const result = value.trim().replace(/\s+/g, ' ');
  if (result.length < 2 || result.length > 48 || /[\u0000-\u001f]/.test(result)) throw new HttpError(400, 'Nickname must contain 2–48 characters');
  return result;
}

function cleanProjectName(value: string): string {
  const result = value.trim().replace(/\s+/g, ' ');
  if (result.length < 1 || result.length > 100 || /[\u0000-\u001f]/.test(result)) throw new HttpError(400, 'Project name must contain 1–100 characters');
  return result;
}

function parseRole(value: unknown, allowOwner: boolean): Role {
  const role = String(value || 'reader').toLowerCase();
  if (role === 'owner' && allowOwner) return 'owner';
  if (role === 'editor' || role === 'writer' || role === 'write') return 'editor';
  return 'reader';
}
function roleRank(role: Role): number { return role === 'owner' ? 3 : role === 'editor' ? 2 : 1; }
function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) throw new HttpError(400, `Missing ${name}`);
  return value;
}
function asString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `Missing ${name}`);
  return value.trim();
}
function optionalString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  return result || null;
}
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}
function envInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}
function nowSeconds(): number { return Math.floor(Date.now() / 1000); }
function normalizeOrigin(value: string): string {
  const url = new URL(value.includes('://') ? value : `https://${value}`);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') throw new HttpError(400, 'RW Cloud endpoint must use HTTPS');
  return `${url.protocol}//${url.host}`;
}
function stripEtag(value: string | null): string | null {
  if (!value) return null;
  const result = value.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  return result || null;
}
function guessContentType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    txt: 'text/plain; charset=utf-8', ini: 'text/plain; charset=utf-8', json: 'application/json', xml: 'application/xml',
    tmx: 'application/xml', tsx: 'application/xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    gif: 'image/gif', svg: 'image/svg+xml', ogg: 'audio/ogg', wav: 'audio/wav', mp3: 'audio/mpeg', glb: 'model/gltf-binary',
  };
  return map[ext || ''] || 'application/octet-stream';
}
function randomId(length: number): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
}
function groupCode(value: string, size: number): string {
  const groups: string[] = [];
  for (let i = 0; i < value.length; i += size) groups.push(value.slice(i, i + size));
  return groups.join('-');
}
function timestampName(): string {
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}_${two(d.getUTCHours())}-${two(d.getUTCMinutes())}-${two(d.getUTCSeconds())}`;
}
function encodeBase64UrlText(value: string): string { return base64Url(encoder.encode(value)); }
function decodeBase64UrlText(value: string): string { return decoder.decode(fromBase64Url(value)); }
function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
async function digestHex(value: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function secretEquals(a: string, b: string): Promise<boolean> { return textEquals(await digestHex(a), await digestHex(b)); }
async function textEquals(a: string, b: string): Promise<boolean> {
  const aa = encoder.encode(a); const bb = encoder.encode(b);
  if (aa.length !== bb.length) return false;
  let diff = 0; for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!)); }

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
