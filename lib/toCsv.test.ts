import { toCsv, csvCell } from './toCsv';

describe('csvCell', () => {
  it('leaves a plain value alone', () => {
    expect(csvCell('Amazon EC2')).toBe('Amazon EC2');
  });

  it('quotes a value containing a comma, which would otherwise split the row', () => {
    expect(csvCell('EC2, other')).toBe('"EC2, other"');
  });

  it('doubles embedded quotes and wraps the value', () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it('quotes a value containing a newline so it stays one field', () => {
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('writes null and undefined as empty, not as the words', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('writes numbers unquoted so a spreadsheet reads them as numbers', () => {
    expect(csvCell(12.34)).toBe('12.34');
    expect(csvCell(0)).toBe('0');
  });

  // Excel and Sheets execute a leading =, +, - or @ as a formula. A resource
  // tag someone typed could otherwise run on open.
  it('neutralises a value that a spreadsheet would treat as a formula', () => {
    expect(csvCell('=1+1')).toBe(`"'=1+1"`);
    expect(csvCell('+SUM(A1)')).toBe(`"'+SUM(A1)"`);
    expect(csvCell('-2+3')).toBe(`"'-2+3"`);
    expect(csvCell('@cmd')).toBe(`"'@cmd"`);
  });

  it('does not mistake a negative number for a formula', () => {
    expect(csvCell(-5)).toBe('-5');
  });
});

describe('toCsv', () => {
  const columns = [
    { key: 'service_name', header: 'Service' },
    { key: 'cost', header: 'Cost' },
  ] as const;

  it('writes a header row followed by one row per record', () => {
    const csv = toCsv([{ service_name: 'Amazon EC2', cost: 10 }], columns);

    expect(csv).toBe('Service,Cost\r\nAmazon EC2,10');
  });

  it('writes only the header when there are no rows', () => {
    expect(toCsv([], columns)).toBe('Service,Cost');
  });

  // CRLF is what Excel expects; a bare LF makes older versions read the file
  // as a single line.
  it('separates rows with CRLF', () => {
    const csv = toCsv([{ service_name: 'a', cost: 1 }, { service_name: 'b', cost: 2 }], columns);

    expect(csv.split('\r\n')).toHaveLength(3);
  });

  it('reads a missing key as an empty cell rather than dropping the column', () => {
    const csv = toCsv([{ service_name: 'Amazon EC2' }], columns);

    expect(csv).toBe('Service,Cost\r\nAmazon EC2,');
  });
});
