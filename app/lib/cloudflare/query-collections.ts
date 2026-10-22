import { useCallback } from 'react';

/** What the caches and retries here need of a Query DB collection. */
type QueryCollection = {
  cleanup: () => Promise<void>;
  utils: { clearError: () => Promise<void> };
};

/**
 * Collections kept by scope key, each made on its first use. Past `limit`, the one used least recently
 * is dropped and cleaned up.
 */
export function collectionCache<Collection extends QueryCollection>(limit = Number.POSITIVE_INFINITY) {
  const collections = new Map<string, Collection>();
  return {
    /** The collection kept for `key`, if one was made. */
    find: (key: string): Collection | undefined => collections.get(key),
    /** The collection kept for `key`, made with `create` the first time. */
    get(key: string, create: () => Collection): Collection {
      const existing = collections.get(key);
      // Re-inserted, so the Map's order is the order of use.
      collections.delete(key);
      const collection = existing ?? create();
      collections.set(key, collection);
      const [oldest] = collections;
      if (collections.size > limit && oldest) {
        collections.delete(oldest[0]);
        void oldest[1].cleanup().catch(() => undefined);
      }
      return collection;
    },
  };
}

/** Retries a collection's failed load by clearing its error, which refetches it. */
export function useCollectionRetry(collection: QueryCollection | undefined): () => void {
  return useCallback(() => {
    void collection?.utils.clearError().catch(() => undefined);
  }, [collection]);
}
