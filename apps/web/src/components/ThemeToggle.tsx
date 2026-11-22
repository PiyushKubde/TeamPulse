import { Moon, Sun } from 'lucide-react'
import { useTheme } from '@/lib/theme'
import { cn } from '@/lib/utils'

/** One click between light and dark. Used in the app's top bar, the landing page and the sign-in pages. */
export function ThemeToggle({ className }: { className?: string }) {
  const { resolved, setPref } = useTheme()
  const dark = resolved === 'dark'
  const text = dark ? 'Switch to light mode' : 'Switch to dark mode'
  return (
    <button
      type="button"
      className={cn('inline-flex items-center justify-center rounded-lg p-2 text-ink-soft transition-colors hover:bg-hover hover:text-ink', className)}
      onClick={() => setPref(dark ? 'light' : 'dark')}
      aria-label={text}
      title={text}
    >
      {dark ? <Sun className="size-4.5" /> : <Moon className="size-4.5" />}
    </button>
  )
}
