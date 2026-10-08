import type { SVGProps } from 'react';

/**
 * The flowpact mark (assets/brand/mark-mono.svg): Seal teal on light pages, the lighter Seal teal on dark ones
 * (assets/brand/brand.md). Decorative: it always sits next to the name.
 */
export function Logo({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 64 64"
      aria-hidden="true"
      className={`text-[#0b8496] dark:text-[#16a2b6] ${className ?? ''}`}
      {...props}
    >
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M16 0H48A16 16 0 0 1 64 16V48A16 16 0 0 1 48 64H16A16 16 0 0 1 0 48V16A16 16 0 0 1 16 0ZM4 36H15L10 20H54L49 36H60V44H38L43 28H21L26 44H4Z"
      />
    </svg>
  );
}
