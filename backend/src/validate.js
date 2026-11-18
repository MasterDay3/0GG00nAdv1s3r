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
  if (typeof value !== 'string') throw new HttpError(400, `${label}: має бути текстом`);
  value = value.trim();
  if (required && !value) throw new HttpError(400, `${label}: обов’язкове поле`);
  if (value.length > max) throw new HttpError(400, `${label}: задовго (максимум ${max} символів)`);
  return value;
}

export function link(value, label = 'Посилання') {
  const url = text(value, label, { max: 2000, required: false });
  // new URL() quietly drops line breaks, but the raw text is what is stored and later written into calendar feeds.
  if (/[\u0000-\u001f\u007f]/.test(url)) throw new HttpError(400, `${label}: без переносів рядка й службових символів`);
  if (url && !isHttpUrl(url)) throw new HttpError(400, `${label}: має починатися з http:// або https://`);
  return url;
}

// Dates between 2000 and 2100: a value like 1e300 is a finite number, but no date code can print it.
const EARLIEST = Date.UTC(2000, 0, 1);
const LATEST = Date.UTC(2100, 0, 1);

export function timestamp(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new HttpError(400, `${label}: має бути датою`);
  if (value < EARLIEST || value > LATEST) throw new HttpError(400, `${label}: дата має бути між 2000 і 2100 роками`);
  return Math.round(value);
}
