export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function isHttpUrl(value) {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export function text(value, label, { max = 200, required = true } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be text`);
  value = value.trim();
  if (required && !value) throw new HttpError(400, `${label} is required`);
  if (value.length > max) throw new HttpError(400, `${label} is too long (max ${max})`);
  return value;
}

export function link(value, label = 'Link') {
  const url = text(value, label, { max: 2000, required: false });
  if (url && !isHttpUrl(url)) throw new HttpError(400, `${label} must start with http:// or https://`);
  return url;
}

export function timestamp(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new HttpError(400, `${label} must be a date`);
  return Math.round(value);
}
