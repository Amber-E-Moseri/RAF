/**
 * Global API error handler: server faults never reveal internal text to clients.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import express from 'express';

import { apiErrorHandler } from '../lib/server/errorHandler.js';

function startApp(throwError) {
  const app = express();
  app.get('/boom', (_req, _res, next) => next(throwError));
  app.use(apiErrorHandler);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function get(server, path) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

test('a 500 with SQL text returns only the generic message to the client', async () => {
  const originalError = console.error;
  const logged = [];
  console.error = (line) => logged.push(String(line));
  const server = await startApp(Object.assign(new Error('duplicate key value violates unique constraint "remi_messages_pkey" DETAIL: Key (id)=(secret-123)'), {}));
  try {
    const res = await get(server, '/boom');
    assert.equal(res.status, 500);
    assert.deepEqual(JSON.parse(res.body), { error: 'Internal Server Error' });
    assert.doesNotMatch(res.body, /remi_messages|secret-123|duplicate key/);
    assert.doesNotMatch(logged.join('\n'), /secret-123/, 'logs carry the generic message only');
  } finally {
    console.error = originalError;
    await new Promise((resolve) => server.close(resolve));
  }
});

test('an upstream-style 502 body is not echoed to the client', async () => {
  const server = await startApp(Object.assign(new Error('401 {"type":"error","error":{"message":"invalid x-api-key"}}'), { status: 502 }));
  const originalError = console.error;
  console.error = () => {};
  try {
    const res = await get(server, '/boom');
    assert.equal(res.status, 502);
    assert.deepEqual(JSON.parse(res.body), { error: 'Internal Server Error' });
  } finally {
    console.error = originalError;
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a deliberate 4xx keeps its client-facing message', async () => {
  const server = await startApp(Object.assign(new Error('Workspace access denied'), { status: 403 }));
  const originalError = console.error;
  console.error = () => {};
  try {
    const res = await get(server, '/boom');
    assert.equal(res.status, 403);
    assert.deepEqual(JSON.parse(res.body), { error: 'Workspace access denied' });
  } finally {
    console.error = originalError;
    await new Promise((resolve) => server.close(resolve));
  }
});
