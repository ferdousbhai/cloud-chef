import { useState, useMemo, useCallback, type ChangeEvent } from 'react';
import type { ChatHistorySummary } from '~/lib/cloudflare/data-api';
import { useDebounce } from '@uidotdev/usehooks';

export function useSearchFilter({ items }: { items: ChatHistorySummary[] }) {
  const [searchQuery, setSearchQuery] = useState('');
  const debouncedSearchQuery = useDebounce(searchQuery, 300);

  const handleSearchChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(event.target.value);
  }, []);

  const filteredItems = useMemo(() => {
    const query = debouncedSearchQuery.trim().toLowerCase();
    if (!query) {
      return items;
    }

    return items.filter((item) => item.description?.toLowerCase().includes(query) ?? false);
  }, [items, debouncedSearchQuery]);

  return {
    filteredItems,
    handleSearchChange,
  };
}
