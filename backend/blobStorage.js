import { get, put, BlobNotFoundError, BlobPreconditionFailedError } from '@vercel/blob';

const path = (nonce) => `proximity/v1/${nonce}.json`;
const options = { access: 'private', addRandomSuffix: false, contentType: 'application/json' };
export const blobStorage = {
  async create(nonce, data) {
    try {
      await put(path(nonce), JSON.stringify(data), options);
      return true;
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError) return false;
      throw error;
    }
  },
  async read(nonce) {
    try {
      const result = await get(path(nonce), { access: 'private', useCache: false });
      if (!result || result.statusCode !== 200) return null;
      return { data: await new Response(result.stream).json(), version: result.blob.etag };
    } catch (error) {
      if (error instanceof BlobNotFoundError) return null;
      throw error;
    }
  },
  async replace(nonce, data, version) {
    try {
      await put(path(nonce), JSON.stringify(data), { ...options, allowOverwrite: true, ifMatch: version });
      return true;
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError || error instanceof BlobNotFoundError) return false;
      throw error;
    }
  },
};
