// localStorage that never throws: in some cases (private mode, blocked storage) it's unavailable,
// and then settings just aren't remembered.
export function load(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable; the setting just isn't remembered.
  }
}
