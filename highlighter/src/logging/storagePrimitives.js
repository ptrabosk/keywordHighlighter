export async function storageGet(keys) {
  const area = globalThis.chrome?.storage?.local;
  if (!area?.get) return {};
  return await area.get(keys);
}

export async function storageSet(items) {
  const area = globalThis.chrome?.storage?.local;
  if (!area?.set) return;
  await area.set(items);
}

export async function storageRemove(keys) {
  const area = globalThis.chrome?.storage?.local;
  if (!area?.remove) return;
  await area.remove(keys);
}
