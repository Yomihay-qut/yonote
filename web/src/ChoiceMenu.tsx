import { useId, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, Folder } from 'lucide-react'
import { FluidPopover } from './FluidPopover'
import type { LocalRecord } from './types'

type Choice = { value: string; label: string; icon?: ReactNode }

export function ChoiceMenu({
  label,
  value,
  choices,
  onChange,
  placeholder,
  action,
  disabled,
  className = '',
}: {
  label: string
  value?: string
  choices: Choice[]
  onChange: (value: string) => void
  placeholder?: string
  action?: ReactNode
  disabled?: boolean
  className?: string
}) {
  const id = useId()
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const current = choices.find((choice) => choice.value === value)
  return (
    <>
      <button
        ref={anchor}
        id={id + '-trigger'}
        type="button"
        className={'choice-trigger ' + className}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        {action ? action : <>{current?.icon}<span>{current?.label ?? placeholder}</span></>}
        <ChevronDown className="choice-chevron" size={15} />
      </button>
      <FluidPopover anchor={anchor} id={id} open={open} onClose={() => setOpen(false)}
        role="listbox" align="start" compact>
        {choices.map((choice) => (
          <button
            key={choice.value}
            type="button"
            role="option"
            aria-selected={choice.value === value}
            onClick={() => {
              anchor.current?.focus({ preventScroll: true })
              if (choice.value !== value) onChange(choice.value)
            }}
          >
            {choice.icon}
            <span>{choice.label}</span>
            {choice.value === value && <Check className="choice-check" size={16} />}
          </button>
        ))}
      </FluidPopover>
    </>
  )
}

export function FolderPicker({
  folders, value, ...props
}: Omit<Parameters<typeof ChoiceMenu>[0], 'choices'> & { folders: LocalRecord[] }) {
  const current = value && !folders.some((folder) => folder.id === value) ? '' : value
  return <ChoiceMenu {...props} value={current} choices={[
    { value: '', label: '默认', icon: <Folder size={16} /> },
    ...folders.map((folder) => ({
      value: folder.id,
      label: folder.value.name || '未命名文件夹',
      icon: <Folder size={16} style={{ color: folder.value.color }} />,
    })),
  ]} />
}
