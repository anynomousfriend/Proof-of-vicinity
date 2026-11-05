import { createSessionService, SessionError } from '../backend/sessionService.js';
import { blobStorage } from '../backend/blobStorage.js';

export function createHandler(service, configured = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN)) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Use POST.' });
    }
    try {
      if (!configured()) return res.status(503).json({ error: 'Shared session storage is not configured. Attach the private Blob store and redeploy.' });
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body) || JSON.stringify(body).length > 4096) throw new SessionError('Invalid request.');
      let result;
      switch (body.action) {
        case 'health': result = { ready: true }; break;
        case 'create': result = await service.create(body.protocolMode); break;
        case 'status': result = await service.status(body.nonce, body.accessToken); break;
        case 'cancel': result = await service.cancel(body.nonce, body.accessToken); break;
        case 'verify': result = await service.verify(body.nonce, body.listenerId, body.deviceLabel); break;
        default: throw new SessionError('Unknown action.');
      }
      return res.status(200).json(result);
    } catch (error) {
      if (error instanceof SessionError) return res.status(error.status).json({ error: error.message });
      if (error instanceof SyntaxError) return res.status(400).json({ error: 'Invalid JSON.' });
      console.error('Proximity coordinator request failed:', error.name);
      return res.status(503).json({ error: 'Session storage is temporarily unavailable. Please retry.' });
    }
  };
}
export default createHandler(createSessionService(blobStorage));
