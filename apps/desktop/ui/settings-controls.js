export function enhanceSettingsSelect(select) {
  if (typeof HTMLElement.prototype.showPopover !== 'function') return () => {};

  const label = select.labels[0];
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.id = `${select.id}Button`;
  trigger.className = 'settings-select-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');

  const value = document.createElement('span');
  value.id = `${select.id}Value`;
  trigger.setAttribute('aria-labelledby', `${label.id} ${value.id}`);
  trigger.append(value);

  const menu = document.createElement('div');
  menu.id = `${select.id}Options`;
  menu.className = 'settings-select-menu';
  menu.setAttribute('popover', 'auto');
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-labelledby', label.id);
  trigger.setAttribute('aria-controls', menu.id);
  trigger.setAttribute('popovertarget', menu.id);
  select.after(trigger, menu);
  select.hidden = true;
  label.htmlFor = trigger.id;

  function refresh() {
    value.textContent = select.selectedOptions[0]?.textContent.trim() || '';
  }

  function close() {
    if (menu.matches(':popover-open')) menu.hidePopover();
  }

  function open() {
    menu.replaceChildren();
    const items = Array.from(select.options, (option) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.tabIndex = -1;
      item.textContent = option.textContent.trim();
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(option.selected));
      item.addEventListener('click', () => {
        close();
        trigger.focus();
        if (select.value === option.value) return;
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      menu.append(item);
      return item;
    });

    const anchor = trigger.getBoundingClientRect();
    const edge = 8;
    const gap = 4;
    const viewportWidth = document.documentElement.clientWidth;
    const below = window.innerHeight - anchor.bottom - gap - edge;
    const above = anchor.top - gap - edge;
    menu.style.minWidth = `${anchor.width}px`;
    menu.style.maxHeight = `${Math.max(above, below)}px`;
    menu.showPopover();

    const openAbove = menu.offsetHeight > below && above > below;
    menu.style.maxHeight = `${openAbove ? above : below}px`;
    menu.style.top = `${openAbove ? anchor.top - gap - menu.offsetHeight : anchor.bottom + gap}px`;
    const left =
      getComputedStyle(trigger).direction === 'rtl'
        ? anchor.left
        : anchor.right - menu.offsetWidth;
    menu.style.left = `${Math.max(edge, Math.min(left, viewportWidth - menu.offsetWidth - edge))}px`;
    trigger.setAttribute('aria-expanded', 'true');
    items[Math.max(select.selectedIndex, 0)]?.focus();
  }

  trigger.addEventListener('click', (event) => {
    event.preventDefault();
    if (menu.matches(':popover-open')) close();
    else open();
  });
  trigger.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    open();
  });
  menu.addEventListener('toggle', () => {
    trigger.setAttribute(
      'aria-expanded',
      String(menu.matches(':popover-open')),
    );
  });
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Tab' || event.key === 'Escape') {
      close();
      trigger.focus();
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    const items = Array.from(menu.children);
    const current = items.indexOf(document.activeElement);
    const next = {
      ArrowDown: (current + 1) % items.length,
      ArrowUp: (current - 1 + items.length) % items.length,
      Home: 0,
      End: items.length - 1,
    }[event.key];
    if (next !== undefined) {
      event.preventDefault();
      items[next]?.focus();
    } else if (
      event.key.length === 1 &&
      event.key.trim() &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      const key = event.key.toLocaleLowerCase();
      const match = [
        ...items.slice(current + 1),
        ...items.slice(0, current + 1),
      ].find((item) => item.textContent.toLocaleLowerCase().startsWith(key));
      if (match) {
        event.preventDefault();
        match.focus();
      }
    }
  });
  select.closest('.modal-body').addEventListener('scroll', close);
  window.addEventListener('resize', close);
  select.addEventListener('change', refresh);
  refresh();
  return refresh;
}

export function enhanceSettingsNumber(input) {
  const control = document.createElement('div');
  control.className = 'settings-number-control';
  input.before(control);
  control.append(input);

  const stepper = document.createElement('div');
  stepper.className = 'settings-stepper';
  for (const [direction, label] of [
    ['up', '+1'],
    ['down', '−1'],
  ]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.tabIndex = -1;
    button.dataset.step = direction;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-controls', input.id);
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => {
      if (input.disabled) return;
      const before = input.value;
      if (direction === 'up') input.stepUp();
      else input.stepDown();
      if (input.value !== before) {
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    stepper.append(button);
  }
  control.append(stepper);
}
