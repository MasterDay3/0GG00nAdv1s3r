// node:zlib unpacks .pptx/.docx files (they are zip archives) without a dependency.
import { inflateRawSync } from 'node:zlib';

const MAX_UNPACKED = 50 * 1024 * 1024;

// Reads the files out of a zip archive: Map of name → Buffer, only for names that pass `wanted`.
export function unzip(buffer, wanted = () => true) {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('Not a zip file');
  const count = buffer.readUInt16LE(end + 10);
  let pos = buffer.readUInt32LE(end + 16);
  const files = new Map();
  let unpacked = 0;
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(pos) !== 0x02014b50) throw new Error('Broken zip file');
    const method = buffer.readUInt16LE(pos + 10);
    const packedSize = buffer.readUInt32LE(pos + 20);
    const nameLength = buffer.readUInt16LE(pos + 28);
    const skip = nameLength + buffer.readUInt16LE(pos + 30) + buffer.readUInt16LE(pos + 32);
    const local = buffer.readUInt32LE(pos + 42);
    const name = buffer.toString('utf8', pos + 46, pos + 46 + nameLength);
    pos += 46 + skip;
    if (!wanted(name)) continue;
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const packed = buffer.subarray(start, start + packedSize);
    let data;
    if (method === 0) data = packed;
    else if (method === 8) data = inflateRawSync(packed, { maxOutputLength: MAX_UNPACKED });
    else continue;
    unpacked += data.length;
    if (unpacked > MAX_UNPACKED) throw new Error('The file unpacks to more than 50 MB');
    files.set(name, data);
  }
  return files;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXml(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, code) => {
    if (code[0] !== '#') return ENTITIES[code] ?? whole;
    return String.fromCodePoint(code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1)));
  });
}

// Text of an Office XML part: one line per paragraph (<a:p> in slides, <w:p> in Word).
function xmlText(xml, ns) {
  const lines = [];
  for (const [paragraph] of xml.matchAll(new RegExp(`<${ns}:p[ >][\\s\\S]*?</${ns}:p>`, 'g'))) {
    const runs = [...paragraph.matchAll(new RegExp(`<${ns}:t(?: [^>]*)?>([^<]*)</${ns}:t>`, 'g'))].map((m) => decodeXml(m[1]));
    const line = runs.join('').trim();
    if (line) lines.push(line);
  }
  return lines.join('\n');
}

export function kindOf(filename) {
  const ext = (/\.([a-z0-9]+)$/i.exec(filename)?.[1] || '').toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'pptx') return 'pptx';
  if (ext === 'docx') return 'docx';
  if (ext === 'txt' || ext === 'md') return 'text';
  return null;
}

// Slides of a .pptx in order: [{ slide: 1, text }, ...]. Empty slides are kept so the numbers match PowerPoint.
export function pptxSlides(buffer) {
  const files = unzip(buffer, (name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  return [...files.entries()]
    .map(([name, data]) => ({ slide: Number(/slide(\d+)\.xml$/.exec(name)[1]), text: xmlText(data.toString('utf8'), 'a') }))
    .sort((a, b) => a.slide - b.slide);
}

export function docxText(buffer) {
  const xml = unzip(buffer, (name) => name === 'word/document.xml').get('word/document.xml');
  if (!xml) throw new Error('No document text found');
  return xmlText(xml.toString('utf8'), 'w');
}
