import Image from 'next/image';

// Intrinsic size of public/seen-logo.png — used to keep the aspect ratio exact at any height.
const NATURAL_W = 386;
const NATURAL_H = 157;

/**
 * Seen — by Dashing wordmark. The artwork is solid black on transparency, so `.brand-logo`
 * inverts it for the dark palette (the app's default) and leaves it as-is under [data-theme='light'].
 */
export default function Logo({ height = 24 }: { height?: number }) {
  return (
    <Image
      src="/seen-logo.png"
      alt="Seen — by Dashing"
      width={Math.round((height * NATURAL_W) / NATURAL_H)}
      height={height}
      className="brand-logo"
      priority
    />
  );
}
