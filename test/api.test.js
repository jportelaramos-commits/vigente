import { test } from 'node:test';
import assert from 'node:assert';
import { app, runAlerts } from '../server.js';

const srv = app.listen(0);
const base = `http://localhost:${srv.address().port}`;
const call = (p, opt = {}, token) => fetch(base + p, {
  ...opt, headers: { 'content-type': 'application/json', ...(token && { authorization: 'Bearer ' + token }) },
}).then(async (r) => ({ status: r.status, body: await r.json() }));

test('fluxo completo', async () => {
  const reg = await call('/api/auth/register', { method: 'POST', body: JSON.stringify({ name: 'Ana', email: 'ana@x.com', password: '12345678' }) });
  assert.equal(reg.status, 200);
  const t = reg.body.token;
  const dup = await call('/api/auth/register', { method: 'POST', body: JSON.stringify({ name: 'Ana', email: 'ana@x.com', password: '12345678' }) });
  assert.equal(dup.status, 400);
  const login = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'ana@x.com', password: 'errada' }) });
  assert.equal(login.status, 400);

  const soon = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);
  const c = await call('/api/contracts', { method: 'POST', body: JSON.stringify({ title: 'Aluguel', end_date: soon, auto_renew: true }) }, t);
  assert.equal(c.status, 200);
  const upd = await call('/api/contracts/' + c.body.id, { method: 'PUT', body: JSON.stringify({ ...c.body, value: 1200 }) }, t);
  assert.equal(upd.body.value, 1200);
  assert.equal((await call('/api/contracts', {}, t)).body.length, 1);
  assert.equal(await runAlerts(), 1);
  assert.equal(await runAlerts(), 0); // não repete em menos de 7 dias

  for (let i = 0; i < 9; i++) await call('/api/contracts', { method: 'POST', body: JSON.stringify({ title: 'C' + i, end_date: soon }) }, t);
  const over = await call('/api/contracts', { method: 'POST', body: JSON.stringify({ title: 'extra', end_date: soon }) }, t);
  assert.equal(over.status, 402); // limite do Starter

  assert.equal((await call('/api/contracts', {}, 'token-falso')).status, 401);
  srv.close();
});
