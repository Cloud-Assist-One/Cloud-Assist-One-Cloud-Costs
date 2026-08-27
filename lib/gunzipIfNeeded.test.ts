import { gzipSync } from 'node:zlib';
import { gunzipIfNeeded } from './gunzipIfNeeded';

describe('gunzipIfNeeded', () => {
  it('decompresses a .gz key', () => {
    const original = Buffer.from('service,cost\nEC2,10\n');

    const result = gunzipIfNeeded('report-00001.csv.gz', gzipSync(original));

    expect(result.toString()).toBe(original.toString());
  });

  it('matches the extension case-insensitively', () => {
    const original = Buffer.from('a,b\n1,2\n');

    expect(gunzipIfNeeded('REPORT.CSV.GZ', gzipSync(original)).toString()).toBe(original.toString());
  });

  it('returns a plain .csv untouched', () => {
    const plain = Buffer.from('service,cost\nEC2,10\n');

    expect(gunzipIfNeeded('report.csv', plain)).toBe(plain);
  });

  // An .xlsx is a zip container, and gunzipping it would corrupt it.
  it('returns an .xlsx untouched', () => {
    const plain = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

    expect(gunzipIfNeeded('export.xlsx', plain)).toBe(plain);
  });

  // A key can lie. Failing with the key named beats handing the parser
  // gzip bytes and getting an unintelligible parse error instead.
  it('throws a message naming the key when the bytes are not gzip', () => {
    expect(() => gunzipIfNeeded('broken.csv.gz', Buffer.from('not gzip at all'))).toThrow(/broken\.csv\.gz/);
  });
});
