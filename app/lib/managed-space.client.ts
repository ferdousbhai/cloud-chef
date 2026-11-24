import { toast } from 'sonner';

/** Says the space's building for the month is used up, with the way to the credit that continues it. */
export function showAllowanceUsedToast(): void {
  toast.warning('This space has used this month’s building. Credit keeps it going now.', {
    action: {
      label: 'Add credit',
      onClick: () => window.location.assign('/settings#subscription'),
    },
  });
}
