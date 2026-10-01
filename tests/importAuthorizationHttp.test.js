/**
 * HTTP-level authorization and end-to-end identity proof for bank imports.
 *
 * Real server, real JWTs, real membership checks, and real PDFs through the real pdf-parse
 * extractor. The SQLite driver does not enforce RLS; database-level isolation is proven
 * separately in postgresImportIdentity.integration.test.js.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startIsolatedSqliteServer } from './helpers/isolatedSqliteServer.js';
import { buildTextPdf } from './helpers/textPdf.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let server;
let baseUrl;
let alice;
let bob;
let viewer;
let bobAccountId;
let aliceCategoryId;

async function request(pathname, { method = 'GET', token, workspaceId, body, form } = {}) {
  const headers = {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}),
  };
  let payload;
  if (form) {
    payload = form;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}${pathname}`, { method, headers, body: payload });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data };
}

async function signup(email, householdName) {
  const { status, data } = await request('/api/v1/auth/signup', {
    method: 'POST',
    body: { email, password: 'ImportAuth1!', householdName },
  });
  assert.equal(status, 201, `signup failed: ${JSON.stringify(data)}`);
  return { token: data.token, workspaceId: data.workspace.id };
}

function pdfForm(lines, salt, extra = {}) {
  const form = new FormData();
  const bytes = new Uint8Array(buildTextPdf(lines, salt));
  form.set('file', new File([bytes], `statement-${salt}.pdf`, { type: 'application/pdf' }));
  for (const [key, value] of Object.entries(extra)) form.set(key, value);
  return form;
}

const BOOK = '2026-01-20 BOOKSTORE -30.00 965.00';
const COFFEE = '2026-01-15 COFFEE SHOP -5.00 995.00';
const RENT = '2026-02-01 RENT -900.00 65.00';

function importAs(user, lines, salt, extra) {
  return request('/api/v1/imports/bank-statement', {
    method: 'POST', token: user.token, workspaceId: user.workspaceId, form: pdfForm(lines, salt, extra),
  });
}

function classifyAs(user, importId, body = {}) {
  return request(`/api/v1/imports/${importId}/classify`, {
    method: 'POST', token: user.token, workspaceId: user.workspaceId,
    body: { classification_type: 'transaction', category_id: aliceCategoryId, ...body },
  });
}

before(async () => {
  server = await startIsolatedSqliteServer({
    repoRoot,
    testName: 'raf-import-authorization',
    authRequired: true,
    jwtSecret: 'raf-import-authorization-secret',
    extraEnv: { RAF_AUTH_PROVIDER: 'local', RAF_AUTH_RATE_LIMIT_MAX: '1000', SUPABASE_URL: '', SUPABASE_ANON_KEY: '' },
  });
  baseUrl = server.baseUrl;

  alice = await signup('imp-alice@example.com', 'Alice');
  bob = await signup('imp-bob@example.com', 'Bob');
  viewer = await signup('imp-viewer@example.com', 'Viewer Own');

  const invitation = await request(`/api/v1/workspaces/${alice.workspaceId}/invitations`, {
    method: 'POST', token: alice.token, workspaceId: alice.workspaceId,
    body: { email: 'imp-viewer@example.com', role: 'viewer' },
  });
  assert.equal(invitation.status, 201, JSON.stringify(invitation.data));
  const accepted = await request(`/api/v1/invitations/${invitation.data.invitation.rawToken}/accept`, {
    method: 'POST', token: viewer.token, workspaceId: viewer.workspaceId,
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));

  const account = await request('/api/v1/financial-accounts', {
    method: 'POST', token: bob.token, workspaceId: bob.workspaceId, body: { name: 'Bob Checking', accountType: 'checking' },
  });
  assert.equal(account.status, 201, JSON.stringify(account.data));
  bobAccountId = account.data.id;

  const categories = await request('/api/v1/household/allocation-categories', { token: alice.token, workspaceId: alice.workspaceId });
  assert.equal(categories.status, 200, JSON.stringify(categories.data));
  aliceCategoryId = (categories.data.items ?? categories.data.categories ?? categories.data)[0].id;
});

after(async () => {
  await server?.stop();
});

test('unauthenticated import writes are rejected', async () => {
  const response = await request('/api/v1/imports/bank-statement', { method: 'POST', form: pdfForm([BOOK], 'anon') });
  assert.equal(response.status, 401);
});

test('a valid user cannot import into, classify in, or upload to a workspace they do not belong to', async () => {
  const aliceImport = await importAs(alice, [BOOK, COFFEE], 'own');
  assert.equal(aliceImport.status, 201, JSON.stringify(aliceImport.data));
  const aliceRowId = aliceImport.data.items[0].id;

  const foreignImport = await request('/api/v1/imports/bank-statement', {
    method: 'POST', token: bob.token, workspaceId: alice.workspaceId, form: pdfForm([RENT], 'foreign'),
  });
  assert.equal(foreignImport.status, 403);

  const foreignClassify = await request(`/api/v1/imports/${aliceRowId}/classify`, {
    method: 'POST', token: bob.token, workspaceId: alice.workspaceId,
    body: { classification_type: 'ignore' },
  });
  assert.equal(foreignClassify.status, 403);

  const foreignUpload = await request('/api/v1/imports/upload', {
    method: 'POST', token: bob.token, workspaceId: alice.workspaceId,
    body: { filename: 'x.csv', text: 'Date,Description,Amount\n2026-01-20,B,30.00' },
  });
  assert.equal(foreignUpload.status, 403);

  // Nothing was created in Alice's workspace by the rejected attempts.
  const listed = await request('/api/v1/imports', { token: alice.token, workspaceId: alice.workspaceId });
  assert.equal(listed.data.items.length, 2);
});

test('a viewer cannot import or classify in a workspace where they only hold the viewer role', async () => {
  const viaOwnerWorkspace = await request('/api/v1/imports/bank-statement', {
    method: 'POST', token: viewer.token, workspaceId: alice.workspaceId, form: pdfForm([RENT], 'viewer-write'),
  });
  assert.equal(viaOwnerWorkspace.status, 403);

  const aliceImport = await importAs(alice, [COFFEE], 'viewer-target');
  const classify = await request(`/api/v1/imports/${aliceImport.data.items[0].id}/classify`, {
    method: 'POST', token: viewer.token, workspaceId: alice.workspaceId, body: { classification_type: 'ignore' },
  });
  assert.equal(classify.status, 403);
});

test('another workspace\'s staged row is invisible: classify with the row id from inside your own workspace is 404', async () => {
  const bobImport = await importAs(bob, [RENT], 'bob-own');
  assert.equal(bobImport.status, 201, JSON.stringify(bobImport.data));
  const bobRowId = bobImport.data.items[0].id;

  const attack = await request(`/api/v1/imports/${bobRowId}/classify`, {
    method: 'POST', token: alice.token, workspaceId: alice.workspaceId,
    body: { classification_type: 'ignore' },
  });
  assert.equal(attack.status, 404);

  const stillUnreviewed = await request(`/api/v1/imports/${bobRowId}`, { token: bob.token, workspaceId: bob.workspaceId });
  assert.equal(stillUnreviewed.data.status, 'unreviewed');
});

test('a foreign account id is rejected with 404 and nothing is staged', async () => {
  const before = await request('/api/v1/imports', { token: alice.token, workspaceId: alice.workspaceId });
  const attack = await importAs(alice, [BOOK, COFFEE, '2026-03-02 GYM -40.00 25.00'], 'foreign-account', { account_id: bobAccountId });
  assert.equal(attack.status, 404);
  const after = await request('/api/v1/imports', { token: alice.token, workspaceId: alice.workspaceId });
  assert.equal(after.data.items.length, before.data.items.length);
});

test('a PDF with no readable text returns an actionable 422 and nothing is staged', async () => {
  const before = await request('/api/v1/imports', { token: alice.token, workspaceId: alice.workspaceId });
  const form = new FormData();
  form.set('file', new File([new Uint8Array(Buffer.from('%PDF-1.4\n%%EOF\n'))], 'blank.pdf', { type: 'application/pdf' }));
  const response = await request('/api/v1/imports/bank-statement', {
    method: 'POST', token: alice.token, workspaceId: alice.workspaceId, form,
  });
  assert.equal(response.status, 422);
  const after = await request('/api/v1/imports', { token: alice.token, workspaceId: alice.workspaceId });
  assert.equal(after.data.items.length, before.data.items.length);
});

test('overlapping statements over HTTP: the overlap is blocked until explicitly confirmed, and re-uploading the same file is 409', async () => {
  const first = await importAs(alice, [BOOK, COFFEE], 'overlap-1');
  const firstBook = first.data.items.find((item) => /BOOKSTORE/.test(item.description));
  assert.equal((await classifyAs(alice, firstBook.id)).status, 200);

  const second = await importAs(alice, [BOOK, RENT], 'overlap-2');
  assert.equal(second.status, 201);
  const secondBook = second.data.items.find((item) => /BOOKSTORE/.test(item.description));

  const blocked = await classifyAs(alice, secondBook.id);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.details.errorCode, 'IMPORT_POSSIBLE_DUPLICATE');
  assert.ok(blocked.data.details.matches.length >= 1, 'the response names the transaction it may duplicate');

  const sameFile = await importAs(alice, [BOOK, RENT], 'overlap-2');
  assert.equal(sameFile.status, 409);

  const confirmed = await classifyAs(alice, secondBook.id, { confirm_distinct: true });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
});
