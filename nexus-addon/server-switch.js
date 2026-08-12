export async function applyServerSelection(serverKey, { onChange } = {}) {
  const key = serverKey || 's0';
  if (globalThis.nexusStorage?.setActiveServer) {
    await globalThis.nexusStorage.setActiveServer(key);
  }
  if (typeof onChange === 'function') {
    await onChange(key);
  }
  return key;
}

export function bindServerSelector(selector, { onChange } = {}) {
  if (!selector || typeof selector.addEventListener !== 'function') return selector;
  selector.addEventListener('change', async (event) => {
    const key = (event?.target?.value ?? selector.value) || 's0';
    await applyServerSelection(key, { onChange });
  });
  return selector;
}
