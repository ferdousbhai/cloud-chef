import { useState } from 'react';
import { Button } from '@ui/Button';
import { createCloudflareReturnURL, signInWithCloudflare } from '~/lib/auth-client';
import { messageOf } from '~/lib/json-request';
import { toast } from 'sonner';

/** Connects a Cloudflare account to the signed-in person, coming back to this page. */
export function ConnectCloudflareButton() {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      loading={busy}
      onClick={() => {
        setBusy(true);
        signInWithCloudflare(createCloudflareReturnURL())
          .catch((error) => toast.error(messageOf(error, 'Cloudflare couldn’t be connected. Try again.')))
          .finally(() => setBusy(false));
      }}
    >
      Connect Cloudflare
    </Button>
  );
}
