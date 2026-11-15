import { useState, type ReactNode } from 'react'
import { Dialog as D, DropdownMenu as DM, Tooltip as T, Tabs as TB } from 'radix-ui'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

export function Tip({ content, children }: { content: ReactNode; children: ReactNode }) {
  return (
    <T.Provider delayDuration={200}>
      <T.Root>
        <T.Trigger asChild>{children}</T.Trigger>
        <T.Portal>
          <T.Content sideOffset={6} className="z-50 max-w-xs rounded-md bg-ink px-2.5 py-1.5 text-xs leading-relaxed text-white shadow-lg">
            {content}
            <T.Arrow className="fill-ink" />
          </T.Content>
        </T.Portal>
      </T.Root>
    </T.Provider>
  )
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  wide,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: string
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-ink/30 backdrop-blur-[1px]" />
        <D.Content
          className={cn(
            'fixed left-1/2 top-[8vh] z-50 max-h-[84vh] w-[calc(100vw-2rem)] -translate-x-1/2 overflow-y-auto rounded-xl border border-line bg-surface shadow-xl',
            wide ? 'max-w-3xl' : 'max-w-lg',
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div>
              <D.Title className="text-base font-semibold text-ink">{title}</D.Title>
              {description ? (
                <D.Description className="mt-1 text-sm text-muted">{description}</D.Description>
              ) : (
                <D.Description className="sr-only">{title}</D.Description>
              )}
            </div>
            <D.Close className="rounded-md p-1 text-muted hover:bg-canvas hover:text-ink" aria-label="Close">
              <X className="size-4" />
            </D.Close>
          </div>
          <div className="px-5 py-4">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-line bg-canvas/60 px-5 py-3">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}

/** A right-hand panel (task details, member drill-down). */
export function Sheet({ open, onOpenChange, title, children }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; children: ReactNode }) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-ink/20" />
        <D.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col border-l border-line bg-surface shadow-2xl">
          <D.Title className="sr-only">{title}</D.Title>
          <D.Description className="sr-only">{title}</D.Description>
          {children}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
export const SheetClose = D.Close

export function Confirm({
  trigger,
  title,
  description,
  confirmLabel = 'Confirm',
  danger,
  onConfirm,
}: {
  trigger: ReactNode
  title: string
  description: ReactNode
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => Promise<unknown> | void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  return (
    <>
      <span onClick={() => setOpen(true)}>{trigger}</span>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title={title}
        footer={
          <>
            <button className="h-9 rounded-lg border border-line-strong bg-surface px-3.5 text-sm" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              className={cn('h-9 rounded-lg px-3.5 text-sm font-medium text-white disabled:opacity-50', danger ? 'bg-danger' : 'bg-primary')}
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  await onConfirm()
                  setOpen(false)
                } finally {
                  setBusy(false)
                }
              }}
            >
              {confirmLabel}
            </button>
          </>
        }
      >
        <p className="text-sm text-ink-soft">{description}</p>
      </Modal>
    </>
  )
}

export const Menu = DM.Root
export const MenuTrigger = DM.Trigger
export function MenuContent({ children, align = 'end' }: { children: ReactNode; align?: 'start' | 'end' }) {
  return (
    <DM.Portal>
      <DM.Content align={align} sideOffset={6} className="z-50 min-w-48 rounded-lg border border-line bg-surface p-1 text-sm shadow-lg">
        {children}
      </DM.Content>
    </DM.Portal>
  )
}
export function MenuItem({ children, onSelect, danger }: { children: ReactNode; onSelect?: () => void; danger?: boolean }) {
  return (
    <DM.Item
      onSelect={onSelect}
      className={cn(
        'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-canvas [&_svg]:size-4',
        danger ? 'text-danger' : 'text-ink',
      )}
    >
      {children}
    </DM.Item>
  )
}
export const MenuLabel = ({ children }: { children: ReactNode }) => <DM.Label className="px-2 py-1.5 text-xs font-medium text-muted">{children}</DM.Label>
export const MenuSeparator = () => <DM.Separator className="my-1 h-px bg-line" />

export function Tabs({
  value,
  onValueChange,
  tabs,
  children,
}: {
  value: string
  onValueChange: (v: string) => void
  tabs: { value: string; label: ReactNode }[]
  children: ReactNode
}) {
  return (
    <TB.Root value={value} onValueChange={onValueChange}>
      <TB.List className="mb-4 flex gap-1 overflow-x-auto border-b border-line">
        {tabs.map((t) => (
          <TB.Trigger
            key={t.value}
            value={t.value}
            className="-mb-px whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm font-medium text-muted hover:text-ink data-[state=active]:border-primary data-[state=active]:text-primary"
          >
            {t.label}
          </TB.Trigger>
        ))}
      </TB.List>
      {children}
    </TB.Root>
  )
}
export const TabPanel = TB.Content
