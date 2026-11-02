// Blob storage for media. Content-addressed: the key is the SHA-256 of the bytes, so identical
// files are stored once. The interface is deliberately tiny so the local-disk store can be
// swapped for S3-compatible object storage (with hot/cold tiers and a second copy) later.

import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { withOffsite } from './offsite-store.ts';

export interface BlobStore {
  put(data: Buffer): Promise<{ hash: string; size: number }>;
  get(hash: string): Promise<Buffer | null>;
  delete(hash: string): Promise<void>;
}

const HASH_RE = /^[0-9a-f]{64}$/;

export function localBlobStore(root: string): BlobStore {
  const pathFor = (hash: string) => join(root, hash.slice(0, 2), hash.slice(2, 4), hash);
  return {
    async put(data) {
      const hash = createHash('sha256').update(data).digest('hex');
      const path = pathFor(hash);
      try {
        await access(path);
      } catch {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, data);
      }
      return { hash, size: data.length };
    },
    async get(hash) {
      if (!HASH_RE.test(hash)) return null; // never build a path from anything but a real hash
      try {
        return await readFile(pathFor(hash));
      } catch {
        return null;
      }
    },
    async delete(hash) {
      if (HASH_RE.test(hash)) await rm(pathFor(hash), { force: true });
    },
  };
}

export const blobs: BlobStore = withOffsite(localBlobStore(process.env.THIKRA_BLOBS ?? 'data/blobs'));
