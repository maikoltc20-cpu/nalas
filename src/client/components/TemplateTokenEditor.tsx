import { useEffect, useRef } from 'react';
import type { FlowStep } from '../../shared/types';
import {
  listAvailableFlowVariables,
  resolveTemplateTokenMeta,
} from '../../shared/flowTemplates';

interface TemplateTokenEditorProps {
  value: string;
  onChange: (next: string) => void;
  steps: FlowStep[];
  allowReference?: boolean;
  multiline?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  excludedStepId?: string;
  insertLabel?: string;
  flowKey?: string;
}

const TOKEN_REGEX = /\{\{([a-zA-Z0-9_]+)\}\}/g;

function createChipElement(
  token: string,
  steps: FlowStep[],
  allowReference: boolean
): HTMLSpanElement {
  const meta = resolveTemplateTokenMeta(token, steps, { allowReference });
  const chip = document.createElement('span');
  chip.setAttribute('contenteditable', 'false');
  chip.setAttribute('data-token', token);
  chip.className =
    meta.status === 'valid'
      ? 'inline-flex items-center gap-1 mx-0.5 px-2 py-0.5 rounded-[6px] text-xs font-semibold bg-[#EAF5F2] text-[#116B70] border border-[#C6E3DA] align-baseline select-none'
      : 'inline-flex items-center gap-1 mx-0.5 px-2 py-0.5 rounded-[6px] text-xs font-semibold bg-[#FFF0E3] text-[#8C542C] border border-[#F2D7BF] align-baseline select-none';

  const labelEl = document.createElement('span');
  labelEl.setAttribute('data-token-label', 'true');
  labelEl.textContent = meta.label;
  chip.appendChild(labelEl);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.setAttribute('data-remove-token', 'true');
  removeBtn.setAttribute('aria-label', `Quitar ${meta.label}`);
  removeBtn.className =
    'ml-0.5 text-[11px] leading-none opacity-70 hover:opacity-100 cursor-pointer';
  removeBtn.textContent = '×';
  chip.appendChild(removeBtn);

  return chip;
}

function serializeEditorNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? '').replace(/\u00A0/g, ' ');
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return '';
  }
  const el = node as HTMLElement;
  const token = el.getAttribute('data-token');
  if (token) {
    return `{{${token}}}`;
  }
  if (el.tagName === 'BR') {
    return '\n';
  }
  let out = '';
  el.childNodes.forEach((child) => {
    out += serializeEditorNode(child);
  });
  if (el.tagName === 'DIV' || el.tagName === 'P') {
    if (!out.endsWith('\n')) {
      out += '\n';
    }
  }
  return out;
}

function serializeEditorRoot(root: HTMLElement): string {
  let out = '';
  root.childNodes.forEach((child) => {
    out += serializeEditorNode(child);
  });
  return out;
}

export function TemplateTokenEditor({
  value,
  onChange,
  steps,
  allowReference = false,
  multiline = true,
  placeholder,
  ariaLabel,
  disabled = false,
  excludedStepId,
  insertLabel = 'Insertar respuesta en este mensaje:',
  flowKey,
}: TemplateTokenEditorProps) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const lastEmittedValueRef = useRef<string | null>(null);
  const savedRangeRef = useRef<Range | null>(null);

  useEffect(() => {
    const root = editorRef.current;
    if (!root) return;

    if (lastEmittedValueRef.current !== value) {
      root.innerHTML = '';
      let lastIndex = 0;
      const re = new RegExp(TOKEN_REGEX.source, 'g');
      let match: RegExpExecArray | null;
      while ((match = re.exec(value)) !== null) {
        if (match.index > lastIndex) {
          root.appendChild(document.createTextNode(value.slice(lastIndex, match.index)));
        }
        root.appendChild(createChipElement(match[1], steps, allowReference));
        lastIndex = match.index + match[0].length;
      }
      if (lastIndex < value.length) {
        root.appendChild(document.createTextNode(value.slice(lastIndex)));
      }
      lastEmittedValueRef.current = value;
      savedRangeRef.current = null;
      return;
    }

    // Refresh readable chip labels if question titles changed while typing
    root.querySelectorAll<HTMLElement>('[data-token]').forEach((chip) => {
      const token = chip.getAttribute('data-token');
      if (!token) return;
      const meta = resolveTemplateTokenMeta(token, steps, { allowReference });
      chip.className =
        meta.status === 'valid'
          ? 'inline-flex items-center gap-1 mx-0.5 px-2 py-0.5 rounded-[6px] text-xs font-semibold bg-[#EAF5F2] text-[#116B70] border border-[#C6E3DA] align-baseline select-none'
          : 'inline-flex items-center gap-1 mx-0.5 px-2 py-0.5 rounded-[6px] text-xs font-semibold bg-[#FFF0E3] text-[#8C542C] border border-[#F2D7BF] align-baseline select-none';
      const labelEl = chip.querySelector<HTMLElement>('[data-token-label]');
      if (labelEl && labelEl.textContent !== meta.label) {
        labelEl.textContent = meta.label;
      }
    });
  }, [value, steps, allowReference]);

  function saveCurrentSelection() {
    const root = editorRef.current;
    const sel = window.getSelection();
    if (!root || !sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (root.contains(range.commonAncestorContainer)) {
      savedRangeRef.current = range.cloneRange();
    }
  }

  function emitFromDom() {
    const root = editorRef.current;
    if (!root) return;
    const serialized = serializeEditorRoot(root);
    lastEmittedValueRef.current = serialized;
    onChange(serialized);
  }

  function insertPlainTextAtCaret(text: string) {
    const root = editorRef.current;
    if (!root || disabled) return;
    const sel = window.getSelection();
    let range: Range;
    if (sel && sel.rangeCount > 0 && root.contains(sel.getRangeAt(0).commonAncestorContainer)) {
      range = sel.getRangeAt(0);
    } else if (savedRangeRef.current && root.contains(savedRangeRef.current.commonAncestorContainer)) {
      range = savedRangeRef.current;
    } else {
      range = document.createRange();
      range.selectNodeContents(root);
      range.collapse(false);
    }
    range.deleteContents();
    const textNode = document.createTextNode(text);
    range.insertNode(textNode);
    const nextRange = document.createRange();
    nextRange.setStart(textNode, text.length);
    nextRange.collapse(true);
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(nextRange);
    }
    savedRangeRef.current = nextRange.cloneRange();
    emitFromDom();
  }

  function insertTokenAtCaret(token: string) {
    const root = editorRef.current;
    if (!root || disabled) return;
    root.focus();

    const sel = window.getSelection();
    let range: Range;
    if (savedRangeRef.current && root.contains(savedRangeRef.current.commonAncestorContainer)) {
      range = savedRangeRef.current.cloneRange();
    } else if (sel && sel.rangeCount > 0 && root.contains(sel.getRangeAt(0).commonAncestorContainer)) {
      range = sel.getRangeAt(0).cloneRange();
    } else {
      range = document.createRange();
      range.selectNodeContents(root);
      range.collapse(false);
    }

    range.deleteContents();
    const chip = createChipElement(token, steps, allowReference);
    const trailingSpace = document.createTextNode(' ');
    range.insertNode(trailingSpace);
    range.insertNode(chip);

    const nextRange = document.createRange();
    nextRange.setStart(trailingSpace, trailingSpace.length);
    nextRange.collapse(true);
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(nextRange);
    }
    savedRangeRef.current = nextRange.cloneRange();
    emitFromDom();
  }

  const allInsertables = listAvailableFlowVariables(steps, {
    includeBuiltIns: true,
    flowKey,
  }).filter((v) => {
    if (v.stepId && v.stepId === excludedStepId) return false;
    if (v.key === 'referencia' && !allowReference) return false;
    return true;
  });

  return (
    <div className="space-y-2">
      <div className="relative">
        {!value && placeholder && (
          <div className="pointer-events-none absolute inset-x-3.5 top-2.5 text-[15px] text-[#8C9AA8] leading-relaxed select-none">
            {placeholder}
          </div>
        )}
        <div
          ref={editorRef}
          role="textbox"
          aria-multiline={multiline}
          aria-label={ariaLabel}
          contentEditable={!disabled}
          suppressContentEditableWarning
          onInput={() => {
            saveCurrentSelection();
            emitFromDom();
          }}
          onKeyUp={saveCurrentSelection}
          onMouseUp={saveCurrentSelection}
          onBlur={saveCurrentSelection}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (multiline) {
                insertPlainTextAtCaret('\n');
              }
            }
          }}
          onPaste={(e) => {
            e.preventDefault();
            const raw = e.clipboardData.getData('text/plain');
            const normalized = multiline ? raw.replace(/\r\n?/g, '\n') : raw.replace(/[\r\n]+/g, ' ');
            insertPlainTextAtCaret(normalized);
          }}
          onClick={(e) => {
            const target = e.target as HTMLElement | null;
            const removeBtn = target?.closest('[data-remove-token]');
            if (removeBtn) {
              e.preventDefault();
              e.stopPropagation();
              const chip = removeBtn.closest('[data-token]');
              if (chip && editorRef.current?.contains(chip)) {
                chip.remove();
                emitFromDom();
              }
            }
          }}
          className={`w-full text-[15px] border border-[#DCE3E8] rounded-[9px] px-3.5 py-2.5 leading-relaxed whitespace-pre-wrap break-words focus:outline-none focus:ring-2 focus:ring-[#167D83]/25 focus:border-[#167D83] ${
            multiline ? 'min-h-[88px]' : 'min-h-[44px]'
          } ${disabled ? 'bg-[#EDF0F2] text-[#5A6877]' : 'bg-white text-[#25364A]'}`}
        />
      </div>

      {allInsertables.length > 0 && !disabled && (
        <div className="space-y-1.5">
          <div className="text-[11px] font-medium text-[#5A6877]">{insertLabel}</div>
          <div className="flex flex-wrap gap-1.5">
            {allInsertables.map((v) => (
              <button
                key={`insert_${v.key}`}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => insertTokenAtCaret(v.key)}
                className="px-2.5 py-1 text-[11px] font-medium text-[#116B70] bg-[#EAF5F2] border border-[#D4EAE4] rounded-[7px] hover:bg-[#DCEFE9]"
              >
                + {v.key === 'referencia' ? 'Número de solicitud' : v.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
