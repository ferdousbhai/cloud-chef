import { useState } from 'react';
import { toast } from 'sonner';
import {
  DotsHorizontalIcon,
  ExclamationTriangleIcon,
  EyeNoneIcon,
  Link2Icon,
  Pencil1Icon,
  TrashIcon,
} from '@radix-ui/react-icons';
import { Menu, MenuItem, MenuSeparator } from '@ui/Menu';
import { messageOf } from '~/lib/json-request';
import { setPostShown } from '~/lib/showcase-api';
import type { PostView } from '~/lib/showcase';
import { CaptionDialog, DeletePostDialog, ReportDialog } from './PostDialogs';
import { useShowcaseViewer } from './ViewerContext';

type Dialog = 'caption' | 'delete' | 'report' | null;

/**
 * A post's own menu. Its author (and a team project's admins) can edit the caption, hide it from their page,
 * or delete it; anyone can copy its link or report it.
 */
export function PostMenu({
  post,
  onCaption,
  onGone,
}: {
  post: PostView;
  onCaption: (caption: string | null) => void;
  /** Hidden or deleted: gone from this page. */
  onGone: () => void;
}) {
  const { manages } = useShowcaseViewer();
  const [dialog, setDialog] = useState<Dialog>(null);
  const mine = manages(post.id);

  const copyLink = () => {
    void navigator.clipboard
      .writeText(new URL(post.path, window.location.origin).toString())
      .then(() => toast.success('Link copied.'))
      .catch(() => toast.error('The link couldn’t be copied.'));
  };
  const hide = () => {
    setPostShown(post.id, false)
      .then(() => {
        toast.success(`${post.title} is hidden from your page. Show it again from your page.`);
        onGone();
      })
      .catch((error) => toast.error(messageOf(error, 'The post couldn’t be hidden. Try again.')));
  };

  return (
    <>
      <Menu
        buttonProps={{
          variant: 'subtle',
          title: `More for ${post.title}`,
          inline: true,
          className: 'showcase-icon-button !min-h-10 !p-0',
          icon: <DotsHorizontalIcon className="size-5" />,
        }}
      >
        {mine ? (
          <>
            <MenuItem action={() => setDialog('caption')}>
              <Pencil1Icon />
              Edit caption
            </MenuItem>
            <MenuItem action={hide}>
              <EyeNoneIcon />
              Hide from my page
            </MenuItem>
            <MenuSeparator />
          </>
        ) : null}
        <MenuItem action={copyLink}>
          <Link2Icon />
          Copy link
        </MenuItem>
        {mine ? (
          <MenuItem danger action={() => setDialog('delete')}>
            <TrashIcon />
            Delete post
          </MenuItem>
        ) : (
          <MenuItem danger action={() => setDialog('report')}>
            <ExclamationTriangleIcon />
            Report
          </MenuItem>
        )}
      </Menu>
      {dialog === 'caption' ? (
        <CaptionDialog
          postId={post.id}
          caption={post.caption}
          onSaved={(caption) => {
            setDialog(null);
            onCaption(caption);
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === 'delete' ? (
        <DeletePostDialog
          postId={post.id}
          title={post.title}
          onDeleted={() => {
            setDialog(null);
            toast.success('The post is deleted.');
            onGone();
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === 'report' ? <ReportDialog postId={post.id} onClose={() => setDialog(null)} /> : null}
    </>
  );
}
