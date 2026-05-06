function findSearchInput(): HTMLInputElement | HTMLElement | null {
  const nativeInput = document.querySelector<HTMLInputElement>(
    'input[type="text"][role="textbox"]',
  );
  if (nativeInput) return nativeInput;

  const byPlaceholder = document.querySelector<HTMLInputElement>(
    'input[placeholder*="搜索"], input[placeholder*="Search"], input[placeholder*="search"]',
  );
  if (byPlaceholder) return byPlaceholder;

  const editable = Array.from(
    document.querySelectorAll<HTMLElement>(
      'div[contenteditable="true"][role="textbox"]',
    ),
  ).find((el) => !el.closest('footer') && !el.closest('#main'));
  return editable ?? null;
}

function setNativeInputValue(el: HTMLInputElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  );
  descriptor?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function typeIntoEditable(el: HTMLElement, value: string) {
  el.focus();
  document.execCommand('selectAll', false);
  document.execCommand('delete', false);
  document.execCommand('insertText', false, value);
}

function pressEnter(el: HTMLElement) {
  const opts: KeyboardEventInit = {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
  };
  el.dispatchEvent(new KeyboardEvent('keydown', opts));
  el.dispatchEvent(new KeyboardEvent('keypress', opts));
  el.dispatchEvent(new KeyboardEvent('keyup', opts));
}

function chatOpenForQuery(query: string): boolean {
  const main = document.querySelector('div#main');
  if (!main) return false;
  const header = main.querySelector('header');
  const headerDigits = header?.textContent?.replace(/[^\d]/g, '') ?? '';
  return headerDigits.includes(query);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function jumpToChat(query: string): Promise<boolean> {
  if (chatOpenForQuery(query)) return true;

  const input = findSearchInput();
  if (!input) return false;

  input.focus();

  if (input instanceof HTMLInputElement) {
    setNativeInputValue(input, '');
    await sleep(80);
    setNativeInputValue(input, query);
  } else {
    typeIntoEditable(input, query);
  }

  await sleep(600);

  pressEnter(input);

  for (let i = 0; i < 20; i++) {
    await sleep(150);
    if (chatOpenForQuery(query)) return true;
  }

  pressEnter(input);
  for (let i = 0; i < 10; i++) {
    await sleep(200);
    if (chatOpenForQuery(query)) return true;
  }

  return false;
}
