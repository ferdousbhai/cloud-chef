import { classNames } from '~/utils/classNames';

/** A person's picture, round, or their first letter on a soft tint when they have none. */
export function Avatar({
  name,
  image,
  size = 32,
  className,
}: {
  name: string;
  image: string | null;
  size?: number;
  className?: string;
}) {
  const style = { width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.42)) };
  if (image) {
    return (
      <img
        src={image}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        className={classNames('showcase-avatar shrink-0 rounded-full object-cover', className)}
        style={style}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={classNames(
        'showcase-avatar inline-flex shrink-0 items-center justify-center rounded-full font-semibold uppercase',
        className,
      )}
      style={style}
    >
      {Array.from(name.trim())[0] ?? '?'}
    </span>
  );
}
