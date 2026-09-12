export interface RawSnapshotNode {
  index: number;
  role: string;
  name: string;
  value?: string;
  depth: number;
}

export interface RawSnapshot {
  revision: number;
  url: string;
  title: string;
  nodes: RawSnapshotNode[];
}

/**
 * Serialized rather than imported into a page so it can run in Chromium's document realm.
 * Keep this function limited to globals reachable from document/location.
 */
export const SNAPSHOT_SCRIPT = `(revision) => {
  const INTERESTING = 'a,button,input,select,textarea,summary,[role],[contenteditable],h1,h2,h3,h4,h5,h6,label';
  const RAW_TEXT_LIMIT = 4096;
  for (const stale of document.querySelectorAll('[data-tg-ref]')) {
    stale.removeAttribute('data-tg-ref');
  }

  const nodes = [];
  let index = 0;
  const clean = (value) => String(value || '').trim().slice(0, RAW_TEXT_LIMIT);
  const walk = (element, depth) => {
    if (nodes.length >= 2000) return false;
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    const hidden = style.display === 'none' || style.visibility === 'hidden' ||
      element.getAttribute('aria-hidden') === 'true';
    if (hidden) return true;

    if (element.matches(INTERESTING)) {
      element.setAttribute('data-tg-ref', 'r' + revision + '-e' + index);
      const tag = element.tagName;
      const inputType = clean(element.type).toLowerCase();
      const role = clean(element.getAttribute('role') ||
        (tag === 'A' ? 'link' :
         tag === 'BUTTON' ? 'button' :
         tag === 'INPUT' ? (inputType === 'checkbox' ? 'checkbox' :
           inputType === 'radio' ? 'radio' :
           inputType === 'range' ? 'slider' : 'textbox') :
         tag === 'SELECT' ? 'combobox' :
         tag === 'TEXTAREA' ? 'textbox' :
         tag.toLowerCase()));
      const name = clean(element.getAttribute('aria-label') || element.innerText ||
        element.getAttribute('placeholder') || element.getAttribute('name') || '');
      const entry = { index, role, name, depth };
      if ((tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') &&
          typeof element.value === 'string' && inputType !== 'password') {
        entry.value = clean(element.value);
      }
      nodes.push(entry);
      index += 1;
    }

    for (const child of element.children) {
      if (!walk(child, depth + 1)) return false;
    }
    return true;
  };

  walk(document.body, 0);
  return {
    revision,
    url: String(location.href).slice(0, RAW_TEXT_LIMIT),
    title: String(document.title).slice(0, RAW_TEXT_LIMIT),
    nodes,
  };
}`;
