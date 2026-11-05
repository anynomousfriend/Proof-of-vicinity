// The hosted deployment shares state through HTTPS functions and private storage.
export function createHostedCoordinator(request = fetch) {
  const handlers = new Map();
  let closed = false, connected = false, active = null, pollTimer, healthTimer, generation = 0;
  const listenerId = crypto.randomUUID();
  const notify = (event, value) => handlers.get(event)?.forEach((fn) => fn(value));
  async function call(action, data = {}) {
    const response = await request('/api/proximity', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...data }), cache: 'no-store', signal: AbortSignal.timeout(12000),
    });
    const body = await response.json();
    if (!response.ok) { const error = new Error(body.error || 'Coordinator request failed.'); error.status = response.status; throw error; }
    return body;
  }
  async function health() {
    if (closed) return;
    try {
      await call('health');
      if (closed) return;
      if (!connected) { connected = true; notify('connect'); }
    } catch (error) {
      if (closed) return;
      if (connected) {
        connected = false;
        generation++;
        clearTimeout(pollTimer);
        const record = active; active = null;
        void cancel(record);
        notify('disconnect');
      }
      notify('connect_error', error);
    }
    if (!closed) healthTimer = setTimeout(health, 10000);
  }
  async function cancel(record) {
    if (record) await call('cancel', { nonce: record.session.nonce, accessToken: record.accessToken }).catch(() => {});
  }
  async function poll(record, token) {
    try {
      const payload = await call('status', { nonce: record.session.nonce, accessToken: record.accessToken });
      if (closed || token !== generation) return;
      if (payload.latestAttestation) {
        active = null;
        notify('proximity-verified', payload);
        return;
      }
    } catch (error) {
      if (closed || token !== generation) return;
      if ([403, 410].includes(error.status)) {
        active = null;
        notify('session-error', { reason: error.message });
        return;
      }
      notify('verification-failed', { reason: 'Connection interrupted. Retrying session status…' });
    }
    if (!closed && token === generation) pollTimer = setTimeout(() => poll(record, token), 1500);
  }
  queueMicrotask(health);
  return {
    get connected() { return connected; },
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(fn);
      return this;
    },
    emit(event, data = {}) {
      if (event === 'cancel-session') {
        generation++;
        clearTimeout(pollTimer);
        const record = active; active = null;
        void cancel(record);
      }
      if (event === 'create-session') {
        const token = ++generation;
        clearTimeout(pollTimer);
        const previous = active; active = null;
        void (async () => {
          await cancel(previous);
          const record = await call('create', data);
          if (closed || token !== generation) { await cancel(record); return; }
          active = record;
          notify('session-created', record.session);
          void poll(record, token);
        })().catch((error) => {
          if (!closed && token === generation) notify('session-error', { reason: error.message });
        });
      }
      if (event === 'verify-nonce') {
        const token = generation;
        void call('verify', { ...data, listenerId }).then((payload) => {
          if (!closed && token === generation) notify('proximity-verified', payload);
        }).catch((error) => {
          if (!closed && token === generation) notify('verification-failed', { reason: error.message });
        });
      }
    },
    disconnect() {
      closed = true;
      connected = false;
      generation++;
      clearTimeout(pollTimer);
      clearTimeout(healthTimer);
      const record = active; active = null;
      void cancel(record);
      handlers.clear();
    },
  };
}
