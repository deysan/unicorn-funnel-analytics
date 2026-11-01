// Погоджений ASCII-піднабір D-072/073; це не перевірка існування скриньки.
export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== 'string' || /[^\x20-\x7e]/.test(input)) return null;
  const value = input.replace(/^ +| +$/g, '');
  if (value.length > 254) return null;
  const parts = value.split('@');
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  if (!local || local.length > 64 || !local.split('.').every((atom) => /^[a-zA-Z0-9!#$%&'*+\/=?^_`{|}~-]+$/.test(atom))) return null;
  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every((label) => label.length >= 1 && label.length <= 63
    && /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label))) return null;
  return `${local}@${domain.toLowerCase()}`;
}
