import { toast } from 'sonner';

export const WORKERS_PAID_URL = 'https://dash.cloudflare.com/?to=/:account/workers/plans';

export function showWorkersPaidRequiredToast(): void {
  toast.warning(
    'Your Cloudflare Workers AI free allocation is exhausted. CloudChef did not change your plan; authorize Workers Paid in Cloudflare if you want to continue.',
    {
      action: {
        label: 'Review Workers Paid',
        onClick: () => window.open(WORKERS_PAID_URL, '_blank', 'noopener'),
      },
    },
  );
}
